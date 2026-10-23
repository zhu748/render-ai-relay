import http from 'node:http';
import https from 'node:https';
import { timingSafeEqual } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'proxy-connection',
]);
const REPRESENTATION_HEADERS = [
  'content-length', 'content-encoding', 'content-md5', 'digest',
  'content-digest', 'repr-digest', 'etag', 'last-modified', 'accept-ranges',
];

export class ProxyError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function numberSetting(env, name, fallback, { min = 0, max = Infinity, integer = false } = {}) {
  const value = env[name] === undefined || env[name] === '' ? fallback : Number(env[name]);
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}

export function loadConfig(env = process.env) {
  if (!env.TARGET_URL) throw new Error('TARGET_URL is required');
  const target = new URL(env.TARGET_URL);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.search || target.hash) {
    throw new Error('TARGET_URL must be an HTTP(S) URL without credentials, query, or fragment');
  }
  const interval = numberSetting(env, 'HEARTBEAT_INTERVAL_SECONDS', 1, { max: 60 });
  const first = numberSetting(env, 'HEARTBEAT_START_DELAY_SECONDS', 1, { max: 60 });
  return {
    target,
    port: numberSetting(env, 'PORT', 10000, { min: 0, max: 65535, integer: true }),
    heartbeatMs: interval * 1000,
    firstHeartbeatMs: first * 1000,
    totalTimeoutMs: numberSetting(env, 'UPSTREAM_TIMEOUT_SECONDS', 1800, { max: 86400 }) * 1000,
    connectTimeoutMs: numberSetting(env, 'CONNECT_TIMEOUT_SECONDS', 30, { min: 1, max: 300 }) * 1000,
    maxRequestBytes: numberSetting(env, 'MAX_REQUEST_BYTES', 32 * 1024 * 1024, { min: 1, integer: true }),
    maxJsonResponseBytes: numberSetting(env, 'MAX_JSON_RESPONSE_BYTES', 256 * 1024 * 1024, { min: 1, integer: true }),
    maxConcurrentRequests: numberSetting(env, 'MAX_CONCURRENT_REQUESTS', 32, { min: 1, max: 1024, integer: true }),
    maxBufferedRequestBytes: numberSetting(env, 'MAX_BUFFERED_REQUEST_BYTES', 64 * 1024 * 1024, { min: 1, integer: true }),
    heartbeatPrefixes: (env.HEARTBEAT_PATH_PREFIXES || '').split(',').map(s => s.trim()).filter(Boolean),
    proxyToken: env.PROXY_TOKEN || '',
    tempDirectory: env.TEMP_DIRECTORY || join(tmpdir(), 'render-ai-relay'),
  };
}

function filterHeaders(headers) {
  const blocked = new Set(HOP_HEADERS);
  for (const token of String(headers.connection || '').split(',')) blocked.add(token.trim().toLowerCase());
  return Object.fromEntries(Object.entries(headers).filter(([key, value]) => !blocked.has(key.toLowerCase()) && value !== undefined));
}

function jsonType(value) {
  const type = String(value || '').split(';', 1)[0].trim().toLowerCase();
  return type === 'application/json' || /^application\/[a-z0-9!#$&^_.+-]+\+json$/.test(type);
}

function responseKind(upstream, method) {
  if (method === 'HEAD' || [204, 205, 206, 304].includes(upstream.statusCode) || upstream.headers['content-range']) return null;
  const encoding = String(upstream.headers['content-encoding'] || 'identity').trim().toLowerCase();
  if (encoding !== 'identity') return null;
  if (jsonType(upstream.headers['content-type'])) return 'json';
  if (String(upstream.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase() === 'text/event-stream') return 'sse';
  return null;
}

function requestHint(req, body) {
  if (String(req.headers.accept || '').toLowerCase().includes('text/event-stream')) return 'sse';
  if (jsonType(req.headers['content-type']) && !req.headers['content-encoding']) {
    try {
      // Classification only: the original Buffer is forwarded, never re-serialized.
      if (JSON.parse(body.toString('utf8'))?.stream === true) return 'sse';
    } catch { /* malformed input belongs to the upstream */ }
  }
  return 'json';
}

function tokenMatches(actual, expected) {
  const left = Buffer.from(actual || '');
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function readBody(req, limit, signal, reserve) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('aborted', onAbort);
      req.off('error', onError);
      signal.removeEventListener('abort', onSignalAbort);
    };
    const onError = error => { cleanup(); chunks.length = 0; reject(error); };
    const onAbort = () => onError(new ProxyError(499, 'client_disconnected', 'Client disconnected'));
    const onSignalAbort = () => onError(signal.reason);
    const onData = chunk => {
      size += chunk.length;
      if (size > limit) {
        onError(new ProxyError(413, 'request_too_large', 'Request body exceeds MAX_REQUEST_BYTES'));
        req.resume();
        return;
      }
      if (!reserve(chunk.length)) {
        onError(new ProxyError(503, 'request_memory_limit', 'Relay request memory limit reached; retry later'));
        req.resume();
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      const body = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, size);
      chunks.length = 0;
      resolve(body);
    };
    if (signal.aborted) { reject(signal.reason); return; }
    signal.addEventListener('abort', onSignalAbort, { once: true });
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('aborted', onAbort);
    req.on('error', onError);
  });
}

// SSE CR, LF and CRLF line endings, including separators split across TCP chunks.
// Blank heartbeats may only be inserted between complete events.
function createSseBoundary() {
  let lineHasBytes = false;
  let eventHasLines = false;
  let previousCR = false;
  return {
    get safe() { return !lineHasBytes && !eventHasLines; },
    update(chunk) {
      for (const byte of chunk) {
        if (previousCR && byte === 10) { previousCR = false; continue; }
        previousCR = false;
        if (byte === 10 || byte === 13) {
          eventHasLines = lineHasBytes;
          lineHasBytes = false;
          previousCR = byte === 13;
        } else {
          lineHasBytes = true;
        }
      }
    },
  };
}

function writeChunk(res, chunk, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  if (res.write(chunk)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      res.off('drain', onDrain);
      res.off('close', onClose);
      res.off('error', onError);
      signal.removeEventListener('abort', onAbort);
    };
    const onDrain = () => { cleanup(); resolve(); };
    const onError = error => { cleanup(); reject(error); };
    const onClose = () => onError(new ProxyError(499, 'client_disconnected', 'Client disconnected'));
    const onAbort = () => onError(signal.reason);
    res.once('drain', onDrain);
    res.once('close', onClose);
    res.once('error', onError);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function createProxy(config, { logger = console } = {}) {
  const agents = {
    'http:': new http.Agent({ keepAlive: true, maxSockets: config.maxConcurrentRequests, maxFreeSockets: Math.min(16, config.maxConcurrentRequests) }),
    'https:': new https.Agent({ keepAlive: true, maxSockets: config.maxConcurrentRequests, maxFreeSockets: Math.min(16, config.maxConcurrentRequests) }),
  };
  let activeRequests = 0;
  let bufferedRequestBytes = 0;
  const target = config.target;
  const basePath = target.pathname === '/' ? '' : target.pathname.replace(/\/+$/, '');

  const handler = async (req, res) => {
    // The stream may emit another error after request collection was canceled.
    req.on('error', () => {});
    if (req.url.split('?', 1)[0] === '/__proxy_health' && ['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : '{"ok":true}\n');
      return;
    }

    const controller = new AbortController();
    const { signal } = controller;
    let heartbeatTimer, totalTimer, connectTimer, temporaryDirectory, outgoing, body;
    let phase = 'reading_request';
    let upstream, committedKind = null, sentKind = null, receivedBodyBytes = 0;
    let actualBodyStarted = false, lastOutputAt = 0, hint = 'json';
    let admitted = false, requestMemoryBytes = 0;
    const sseBoundary = createSseBoundary();

    const abort = reason => { if (!signal.aborted) controller.abort(reason); };
    const onClientClose = () => {
      if (!res.writableFinished) abort(new ProxyError(499, 'client_disconnected', 'Client disconnected'));
    };
    res.once('close', onClientClose);
    // Socket/stream errors are handled by the request's catch, not as uncaught events.
    res.on('error', error => abort(error));

    function releaseRequestMemory() {
      bufferedRequestBytes -= requestMemoryBytes;
      requestMemoryBytes = 0;
      body = undefined;
    }

    function commit(kind, modifying = true) {
      if (res.headersSent) return;
      const headers = upstream ? filterHeaders(upstream.headers) : {};
      if (modifying) {
        for (const name of REPRESENTATION_HEADERS) delete headers[name];
        headers['cache-control'] = 'no-store, no-transform';
        headers['x-accel-buffering'] = 'no';
      }
      if (!upstream) headers['content-type'] = kind === 'sse' ? 'text/event-stream; charset=utf-8' : 'application/json; charset=utf-8';
      sentKind = kind;
      res.writeHead(upstream?.statusCode || 200, headers);
      if (modifying) res.flushHeaders();
    }

    function heartbeat() {
      if (signal.aborted || res.destroyed || res.writableEnded) return null;
      if (!['waiting_headers', 'buffering_json', 'sse'].includes(phase)) return null;
      if (res.writableNeedDrain || res.writableLength || (phase === 'sse' && !sseBoundary.safe)) return config.heartbeatMs;
      const remaining = config.heartbeatMs - (performance.now() - lastOutputAt);
      if (lastOutputAt && remaining > 0) return remaining;
      const kind = phase === 'waiting_headers' ? hint : responseKind(upstream, req.method);
      if (!kind) return null;
      commit(kind);
      committedKind = kind;
      // LF LF is valid JSON whitespace and an ignored blank SSE event.
      res.write('\n\n');
      lastOutputAt = performance.now();
      return config.heartbeatMs;
    }

    function scheduleHeartbeat(delayMs) {
      // Re-arm from actual output using a monotonic clock. A slightly early
      // timer must wait the remaining milliseconds, not skip a whole interval.
      heartbeatTimer = setTimeout(() => {
        try {
          const next = heartbeat();
          if (next !== null) scheduleHeartbeat(next);
        } catch (error) { abort(error); }
      }, Math.max(1, Math.ceil(delayMs)));
      heartbeatTimer.unref();
    }

    function sendFailure(error) {
      if (res.destroyed || res.writableEnded || error.status === 499) return;
      const payload = JSON.stringify({ error: {
        message: error.message,
        type: 'relay_error',
        code: error.code || 'upstream_connection_error',
        status: error.status || 502,
      } });
      if (!res.headersSent) {
        if (error.status === 503) res.setHeader('retry-after', '1');
        res.writeHead(error.status || 502, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(payload);
      } else if (sentKind === 'json' && !actualBodyStarted) {
        res.end(payload);
      } else if (sentKind === 'sse' && sseBoundary.safe) {
        res.end(`event: error\ndata: ${payload}\n\n`);
      } else {
        // Appending an error inside partial JSON/SSE would silently corrupt it.
        res.destroy();
      }
    }

    try {
      if (!req.url.startsWith('/') || req.method === 'CONNECT') {
        throw new ProxyError(400, 'invalid_request_target', 'Only origin-form HTTP request paths are supported');
      }
      if (config.proxyToken && !tokenMatches(req.headers['x-proxy-token'], config.proxyToken)) {
        req.resume();
        throw new ProxyError(401, 'invalid_proxy_token', 'Missing or invalid X-Proxy-Token');
      }
      if (activeRequests >= config.maxConcurrentRequests) {
        req.resume();
        throw new ProxyError(503, 'relay_busy', 'Relay concurrency limit reached; retry later');
      }
      activeRequests++;
      admitted = true;
      body = await readBody(req, config.maxRequestBytes, signal, bytes => {
        if (bufferedRequestBytes + bytes > config.maxBufferedRequestBytes) return false;
        bufferedRequestBytes += bytes;
        requestMemoryBytes += bytes;
        return true;
      });
      if (signal.aborted) throw signal.reason;
      hint = requestHint(req, body);
      const pathname = req.url.split('?', 1)[0];
      const eligible = config.heartbeatMs > 0 && !['HEAD', 'OPTIONS'].includes(req.method) && !req.headers.range &&
        req.headers['x-proxy-heartbeat'] !== 'off' &&
        (config.heartbeatPrefixes.length === 0 || config.heartbeatPrefixes.some(prefix => pathname.startsWith(prefix)));
      const headers = filterHeaders(req.headers);
      delete headers['x-proxy-token'];
      delete headers['x-proxy-heartbeat'];
      headers.host = target.host;
      if (body.length || req.headers['content-length'] !== undefined || req.headers['transfer-encoding'] !== undefined) {
        headers['content-length'] = String(body.length);
      }
      // An injected plain LF must not be followed by compressed response bytes.
      if (eligible) headers['accept-encoding'] = 'identity';
      phase = 'waiting_headers';
      if (eligible) scheduleHeartbeat(config.firstHeartbeatMs);
      if (config.totalTimeoutMs > 0) {
        totalTimer = setTimeout(() => abort(new ProxyError(504, 'upstream_timeout', 'Upstream request exceeded UPSTREAM_TIMEOUT_SECONDS')), config.totalTimeoutMs);
        totalTimer.unref();
      }
      connectTimer = setTimeout(() => abort(new ProxyError(504, 'connect_timeout', 'Upstream connection timed out')), config.connectTimeoutMs);
      connectTimer.unref();

      upstream = await new Promise((resolve, reject) => {
        const transport = target.protocol === 'https:' ? https : http;
        outgoing = transport.request({
          protocol: target.protocol,
          hostname: target.hostname.replace(/^\[|\]$/g, ''),
          port: target.port || undefined,
          method: req.method,
          path: basePath + req.url,
          headers,
          agent: agents[target.protocol],
          signal,
        }, incoming => {
          // Cancellation can happen during async temp-file setup, before pipeline
          // attaches its own listener. Keep an error sink for that narrow window.
          incoming.on('error', () => {});
          clearTimeout(connectTimer);
          resolve(incoming);
        });
        outgoing.on('socket', socket => {
          if (!socket.connecting) clearTimeout(connectTimer);
          else socket.once(target.protocol === 'https:' ? 'secureConnect' : 'connect', () => clearTimeout(connectTimer));
        });
        outgoing.on('error', reject);
        outgoing.once('finish', releaseRequestMemory);
        outgoing.once('close', releaseRequestMemory);
        outgoing.on('upgrade', (_response, socket) => {
          socket.destroy();
          reject(new ProxyError(502, 'unsupported_upgrade', 'Upstream protocol upgrades are not supported'));
        });
        outgoing.end(body);
      });

      const kind = eligible ? responseKind(upstream, req.method) : null;
      if (committedKind && (kind !== committedKind || (committedKind === 'sse' && upstream.statusCode !== 200))) {
        upstream.destroy();
        throw new ProxyError(502, 'incompatible_upstream_response', `Upstream returned HTTP ${upstream.statusCode} with a format incompatible with the already-started ${committedKind} response`);
      }
      if (committedKind && upstream.statusCode !== res.statusCode) {
        logger.warn?.(JSON.stringify({ event: 'late_upstream_status', upstream_status: upstream.statusCode, downstream_status: res.statusCode }));
      }

      if (kind === 'json') {
        phase = 'buffering_json';
        try {
          await mkdir(config.tempDirectory, { recursive: true, mode: 0o700 });
          temporaryDirectory = await mkdtemp(join(config.tempDirectory, 'ai-relay-'));
        } catch {
          throw new ProxyError(503, 'temporary_storage_unavailable', 'Relay temporary storage is unavailable');
        }
        const filename = join(temporaryDirectory, 'response');
        let hasJsonContent = false;
        const limiter = new Transform({
          transform(chunk, _encoding, callback) {
            receivedBodyBytes += chunk.length;
            if (!hasJsonContent) hasJsonContent = chunk.some(byte => byte !== 9 && byte !== 10 && byte !== 13 && byte !== 32);
            if (receivedBodyBytes > config.maxJsonResponseBytes) {
              callback(new ProxyError(502, 'response_too_large', 'JSON response exceeds MAX_JSON_RESPONSE_BYTES'));
            } else callback(null, chunk);
          },
        });
        await pipeline(upstream, limiter, createWriteStream(filename, { flags: 'wx', mode: 0o600 }), { signal });
        if (!hasJsonContent) throw new ProxyError(502, 'empty_upstream_response', 'Upstream returned an empty or whitespace-only JSON body');
        phase = 'sending_json';
        commit('json', Boolean(committedKind));
        actualBodyStarted = receivedBodyBytes > 0;
        await pipeline(createReadStream(filename), res, { signal });
      } else if (kind === 'sse') {
        phase = 'sse';
        commit('sse');
        // Headers alone do not count as activity; the timer still emits blanks.
        for await (const chunk of upstream) {
          receivedBodyBytes += chunk.length;
          actualBodyStarted = true;
          sseBoundary.update(chunk);
          lastOutputAt = performance.now();
          await writeChunk(res, chunk, signal);
        }
        if (receivedBodyBytes === 0) throw new ProxyError(502, 'empty_upstream_response', 'Upstream returned an empty SSE body');
        res.end();
      } else {
        // Binary, compressed, no-body and explicitly bypassed responses stay opaque.
        phase = 'passthrough';
        commit(null, false);
        await pipeline(upstream, res, { signal });
      }
      phase = 'done';
    } catch (caught) {
      const error = signal.aborted ? signal.reason : caught;
      if (!res.destroyed && error?.status !== 499) {
        logger.error?.(JSON.stringify({ event: 'relay_error', code: error?.code || 'upstream_connection_error', status: error?.status || 502, phase, syscall: error?.syscall }));
      }
      sendFailure(error instanceof ProxyError ? error : new ProxyError(502, 'upstream_connection_error', 'Upstream connection failed or response was interrupted'));
      abort(error);
      upstream?.destroy();
    } finally {
      clearTimeout(heartbeatTimer);
      clearTimeout(totalTimer);
      clearTimeout(connectTimer);
      if (outgoing && !outgoing.writableFinished) outgoing.destroy();
      releaseRequestMemory();
      if (admitted) activeRequests--;
      if (temporaryDirectory) {
        await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => logger.error?.('{"event":"temporary_file_cleanup_failed"}'));
      }
    }
  };

  const server = http.createServer((req, res) => {
    void handler(req, res).catch(() => {
      // A final guard: no unexpected handler rejection may terminate the process.
      logger.error?.('{"event":"unexpected_handler_error"}');
      res.destroy();
    });
  });
  server.requestTimeout = 120_000; // Incoming upload deadline, not inference duration.
  server.headersTimeout = 60_000;
  server.timeout = 0;
  server.keepAliveTimeout = 65_000;
  server.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'));
  server.on('connect', (_req, socket) => socket.end('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'));
  return {
    server,
    destroyAgents() { for (const agent of Object.values(agents)) agent.destroy(); },
  };
}
