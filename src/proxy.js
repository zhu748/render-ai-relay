import http from 'node:http';
import https from 'node:https';
import { timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline, finished } from 'node:stream/promises';
import { createDiagnostics, VERSION } from './diagnostics.js';
import { ProxyError, classifyError } from './errors.js';
import { createTemporaryStorage } from './storage.js';
import { createSseBuffer } from './sse.js';
import { createKeepalive } from './keepalive.js';
import { createJsonValidator } from './json.js';
import { readBody } from './request.js';
import { jsonType, requestHint, heartbeatPolicy, isAdminHostname, applyCors, handleCorsPreflight } from './policy.js';

export { ProxyError } from './errors.js';

const HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'proxy-connection',
]);
const REPRESENTATION_HEADERS = [
  'content-length', 'content-encoding', 'content-md5', 'digest',
  'content-digest', 'repr-digest', 'etag', 'last-modified', 'accept-ranges',
];

export { loadConfig } from './config.js';

function filterHeaders(headers) {
  const blocked = new Set(HOP_HEADERS);
  for (const token of String(headers.connection || '').split(',')) blocked.add(token.trim().toLowerCase());
  return Object.fromEntries(Object.entries(headers).filter(([key, value]) => !blocked.has(key.toLowerCase()) && value !== undefined));
}

function utf8Type(value) {
  const charset = /;\s*charset\s*=\s*(?:"([^"]*)"|([^;\s]*))/i.exec(String(value || ''));
  return !charset || /^(?:utf-?8|us-ascii)$/i.test(charset[1] ?? charset[2]);
}

function responseKind(upstream, method) {
  if (method === 'HEAD' || [204, 205, 206, 304].includes(upstream.statusCode) || upstream.headers['content-range']) return null;
  const encoding = String(upstream.headers['content-encoding'] || 'identity').trim().toLowerCase();
  if (encoding !== 'identity') return null;
  if (jsonType(upstream.headers['content-type']) && utf8Type(upstream.headers['content-type'])) return 'json';
  if (String(upstream.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase() === 'text/event-stream') return 'sse';
  return null;
}

function originMatches(value, target) {
  if (!value) return null;
  try { return new URL(value).origin === target.origin; } catch { return false; }
}

function tokenMatches(actual, expected) {
  const left = Buffer.from(actual || '');
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function writeChunk(res, chunk, signal, downstream = true) {
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
    const onClose = () => onError(downstream ? new ProxyError(499, 'client_disconnected', 'Client disconnected') : new ProxyError(502, 'upstream_connection_error', 'Upstream connection closed during upload'));
    const onAbort = () => onError(signal.reason);
    res.once('drain', onDrain);
    res.once('close', onClose);
    res.once('error', onError);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function createProxy(config, { logger = console, storageOperations = {} } = {}) {
  const storage = createTemporaryStorage(config, { logger, operations: storageOperations });
  const agentOptions = {
    keepAlive: true,
    keepAliveMsecs: config.tcpKeepAliveMs,
    timeout: config.upstreamIdleSocketMs,
    maxSockets: config.maxConcurrentRequests,
    maxFreeSockets: Math.min(16, config.maxConcurrentRequests),
    scheduling: 'lifo',
  };
  const agents = {
    'http:': new http.Agent(agentOptions),
    'https:': new https.Agent(agentOptions),
  };
  let activeRequests = 0;
  let bufferedRequestBytes = 0;
  let bufferedResponseBytes = 0;
  let bufferedSseBytes = 0;
  const releaseResponseStorage = bytes => { bufferedResponseBytes -= bytes; };
  let draining = false;
  const controllers = new Set();
  const idleWaiters = new Set();
  const keepalive = createKeepalive(config, { logger });
  const diagnostics = createDiagnostics(config, logger, () => ({
    active_requests: activeRequests,
    max_concurrent_requests: config.maxConcurrentRequests,
    buffered_request_bytes: bufferedRequestBytes,
    max_buffered_request_bytes: config.maxBufferedRequestBytes,
    buffered_response_bytes: bufferedResponseBytes,
    max_buffered_response_bytes: config.maxBufferedResponseBytes,
    buffered_sse_bytes: bufferedSseBytes,
    max_buffered_sse_bytes: config.maxBufferedSseBytes,
    temporary_storage: storage.status(),
    draining,
  }), keepalive);
  const target = config.target;
  const basePath = target.pathname === '/' ? '' : target.pathname.replace(/\/+$/, '');

  const handler = async (req, res) => {
    // The stream may emit another error after request collection was canceled.
    req.on('error', () => {});
    if (req.url.split('?', 1)[0] === '/keepalive') {
      req.resume();
      const allowed = ['GET', 'HEAD'].includes(req.method);
      res.writeHead(allowed ? (draining ? 503 : 200) : 405, {
        'content-length': '0', 'cache-control': 'no-store', ...(allowed ? {} : { allow: 'GET, HEAD' }),
      });
      res.end();
      return;
    }
    if (req.url.split('?', 1)[0] === '/__proxy_health' && ['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(draining ? 503 : 200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ ok: !draining, version: VERSION, diagnostics: '/__proxy/' }) + '\n');
      return;
    }
    if (diagnostics.handle(req, res)) return;
    if (isAdminHostname(req, config) || (!config.allowUpstreamServiceWorkers &&
        (req.headers['service-worker'] !== undefined || req.headers['sec-fetch-dest'] === 'serviceworker'))) {
      if (!req.complete) res.setHeader('connection', 'close');
      req.resume();
      res.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: { code: isAdminHostname(req, config) ? 'admin_host_only' : 'service_worker_blocked', message: 'This endpoint is not available on this host' } }));
      return;
    }

    if (handleCorsPreflight(req, res, config)) return;

    const controller = new AbortController();
    controllers.add(controller);
    const { signal } = controller;
    let heartbeatTimer, totalTimer, connectTimer, stallTimer, temporaryDirectory, outgoing, body;
    let stallBegan = 0;
    let phase = 'reading_request';
    let upstream, committedKind = null, sentKind = null, receivedBodyBytes = 0;
    let responseSourceFailure;
    let actualBodyStarted = false, lastOutputAt = 0, hint = 'json';
    let admitted = false, requestMemoryBytes = 0, responseStorageBytes = 0;
    let mode = 'off';
    let heartbeats = 0, firstHeartbeatMs = null, eligible = false, reason = 'reading_request', outcome = 'completed';
    const forwarding = {
      received_header_names: Object.keys(req.headers).sort(),
      forwarded_header_names: null,
      changed_header_names: [],
      removed_header_names: [],
      added_header_names: [],
      request_body_bytes: null,
      request_body_sent: false,
      origin_matches_target: originMatches(req.headers.origin, target),
      referer_matches_target: originMatches(req.headers.referer, target),
    };
    const sseBuffer = createSseBuffer({
      maxEventBytes: config.maxSseEventBytes,
      reserve(bytes) {
        if (bufferedSseBytes + bytes > config.maxBufferedSseBytes) return false;
        bufferedSseBytes += bytes;
        return true;
      },
      release(bytes) { bufferedSseBytes -= bytes; },
    });
    const began = performance.now();
    const timings = { upload_ms: null, classification_ms: null, upstream_headers_ms: null, receive_ms: null, send_ms: null };
    let phaseBegan = began;
    function enterPhase(next) {
      const now = performance.now();
      const key = { reading_request: 'upload_ms', classifying_request: 'classification_ms', waiting_headers: 'upstream_headers_ms', buffering_json: 'receive_ms', sse: 'receive_ms', passthrough: 'receive_ms', sending_json: 'send_ms' }[phase];
      if (key) timings[key] = Math.round(now - phaseBegan);
      phaseBegan = now; phase = next;
    }
    const trace = diagnostics.begin(req, () => ({
      phase,
      timings_ms: { ...timings },
      heartbeat_mode: mode,
      heartbeats,
      first_heartbeat_ms: firstHeartbeatMs,
      heartbeat_enabled: eligible,
      heartbeat_reason: reason,
      upstream_status: upstream?.statusCode ?? null,
      downstream_status: res.headersSent ? res.statusCode : null,
      upstream_body_bytes: receivedBodyBytes,
      buffered_sse_bytes: sseBuffer.bufferedBytes,
      upstream_reused_socket: outgoing?.reusedSocket ?? false,
      downstream_backpressure: res.writableNeedDrain,
      ...forwarding,
    }));
    res.setHeader('x-render-relay-request-id', trace.id);
    res.setHeader('x-render-relay-version', VERSION);

    const abort = reason => { if (!signal.aborted) controller.abort(reason); };
    const onClientClose = () => {
      if (!res.writableFinished) abort(new ProxyError(499, 'client_disconnected', 'Client disconnected'));
    };
    res.once('close', onClientClose);
    // Socket/stream errors are handled by the request's catch, not as uncaught events.
    res.on('error', () => abort(new ProxyError(499, 'client_disconnected', 'Client disconnected')));
    const onDrain = () => { stallBegan = 0; };
    res.on('drain', onDrain);
    const onSourceError = error => {
      // pipeline() may destroy the downstream after its source fails. Record
      // the original cause before that close can look like a client cancel.
      if (!signal.aborted) responseSourceFailure = error;
    };

    function releaseRequestMemory() {
      bufferedRequestBytes -= requestMemoryBytes;
      requestMemoryBytes = 0;
      if (body?.chunks) body.chunks.length = 0;
      body = undefined;
    }

    function commit(kind, modifying = true) {
      if (res.headersSent) return;
      const headers = applyCors(req, config, upstream ? filterHeaders(upstream.headers) : {});
      if (modifying) {
        for (const name of REPRESENTATION_HEADERS) delete headers[name];
        headers['cache-control'] = 'no-store, no-transform';
        headers['x-accel-buffering'] = 'no';
      }
      if (!upstream) headers['content-type'] = kind === 'sse' ? 'text/event-stream; charset=utf-8' : 'application/json; charset=utf-8';
      headers['x-render-relay-request-id'] = trace.id;
      headers['x-render-relay-version'] = VERSION;
      sentKind = kind;
      res.writeHead(upstream?.statusCode || 200, headers);
      if (modifying) res.flushHeaders();
    }

    function heartbeat() {
      if (signal.aborted || res.destroyed || res.writableEnded) return null;
      if (!['waiting_headers', 'buffering_json', 'sse'].includes(phase)) return null;
      if (res.writableNeedDrain || res.writableLength) return config.heartbeatMs;
      const remaining = config.heartbeatMs - (performance.now() - lastOutputAt);
      if (lastOutputAt && remaining > 0) return remaining;
      const kind = phase === 'waiting_headers' ? hint : responseKind(upstream, req.method);
      if (!kind) return null;
      commit(kind);
      committedKind = kind;
      // LF LF is valid JSON whitespace and an ignored blank SSE event.
      res.write('\n\n');
      lastOutputAt = performance.now();
      heartbeats++;
      if (heartbeats === 1) {
        firstHeartbeatMs = Math.round(lastOutputAt - began);
        trace.event('heartbeat_started');
      }
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
      if (res.destroyed || error.status === 499) return;
      if (res.writableEnded) {
        // finished() cancellation stops waiting, but does not destroy a stream
        // whose end() is still waiting for the final downstream write to flush.
        if (!res.writableFinished) res.destroy();
        return;
      }
      if (error.code === 'downstream_stalled') { res.destroy(); return; }
      const payload = JSON.stringify({ error: {
        message: error.message,
        type: 'relay_error',
        code: error.code || 'upstream_connection_error',
        status: error.status || 502,
      } });
      if (!res.headersSent) {
        // Do not drain an unlimited upload after rejecting it. Close only after
        // flushing the error response so clients still receive the real status.
        if (!req.complete) {
          res.setHeader('connection', 'close');
          req.resume();
        }
        if (error.status === 503) res.setHeader('retry-after', '1');
        res.writeHead(error.status || 502, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(payload);
      } else if (sentKind === 'json' && !actualBodyStarted) {
        res.end(payload);
      } else if (sentKind === 'sse') {
        res.end(`event: error\ndata: ${payload}\n\n`);
      } else {
        // Appending an error inside partial JSON/SSE would silently corrupt it.
        res.destroy();
      }
    }

    try {
      if (draining) throw new ProxyError(503, 'server_shutting_down', 'Relay is shutting down');
      if (!req.url.startsWith('/') || req.method === 'CONNECT') {
        throw new ProxyError(400, 'invalid_request_target', 'Only origin-form HTTP request paths are supported');
      }
      if (config.proxyToken && !tokenMatches(req.headers['x-proxy-token'], config.proxyToken)) {
        req.resume();
        throw new ProxyError(401, 'invalid_proxy_token', 'Missing or invalid X-Proxy-Token');
      }
      if (Number(req.headers['content-length']) > config.maxRequestBytes) {
        throw new ProxyError(413, 'request_too_large', 'Request body exceeds MAX_REQUEST_BYTES');
      }
      if (activeRequests >= config.maxConcurrentRequests) {
        req.resume();
        throw new ProxyError(503, 'relay_busy', 'Relay concurrency limit reached; retry later');
      }
      activeRequests++;
      admitted = true;
      body = await readBody(req, {
        maxBytes: config.maxRequestBytes, signal, chunked: true, tooLargeMessage: 'Request body exceeds MAX_REQUEST_BYTES',
        reserve(bytes) {
          if (bufferedRequestBytes + bytes > config.maxBufferedRequestBytes) return false;
          bufferedRequestBytes += bytes;
          requestMemoryBytes += bytes;
          return true;
        },
      });
      if (signal.aborted) throw signal.reason;
      forwarding.request_body_bytes = body.length;
      enterPhase('classifying_request');
      ({ mode, reason } = heartbeatPolicy(req, config));
      eligible = mode !== 'off';
      if (eligible && mode === 'early') hint = await requestHint(req, body, signal);
      if (signal.aborted) throw signal.reason;
      const headers = filterHeaders(req.headers);
      delete headers['x-proxy-token'];
      delete headers['x-proxy-heartbeat'];
      delete headers['x-admin-token'];
      headers.host = target.host;
      if (body.length || req.headers['content-length'] !== undefined || req.headers['transfer-encoding'] !== undefined) {
        headers['content-length'] = String(body.length);
      }
      // An injected plain LF must not be followed by compressed response bytes.
      if (eligible) headers['accept-encoding'] = 'identity';
      forwarding.forwarded_header_names = Object.keys(headers).sort();
      forwarding.changed_header_names = Object.keys(headers).filter(name => req.headers[name] !== undefined && String(req.headers[name]) !== String(headers[name])).sort();
      forwarding.removed_header_names = Object.keys(req.headers).filter(name => headers[name] === undefined).sort();
      forwarding.added_header_names = Object.keys(headers).filter(name => req.headers[name] === undefined).sort();
      enterPhase('waiting_headers');
      trace.event('upstream_request');
      if (config.downstreamStallMs > 0) {
        stallTimer = setInterval(() => {
          if (!res.writableNeedDrain && !res.writableLength) { stallBegan = 0; return; }
          const now = performance.now();
          if (!stallBegan) stallBegan = now;
          else if (now - stallBegan >= config.downstreamStallMs) {
            abort(new ProxyError(504, 'downstream_stalled', 'Client did not drain the response before DOWNSTREAM_STALL_TIMEOUT_SECONDS'));
          }
        }, Math.max(1, Math.min(1000, Math.ceil(config.downstreamStallMs / 4))));
        stallTimer.unref();
      }
      if (eligible && mode === 'early' && hint) scheduleHeartbeat(config.firstHeartbeatMs);
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
          incoming.on('error', onSourceError);
          clearTimeout(connectTimer);
          resolve(incoming);
        });
        outgoing.on('socket', socket => {
          // Pool expiry applies only between requests; a long active AI call
          // is bounded by the explicit total/connect deadlines instead.
          socket.setTimeout(0);
          socket.setKeepAlive(true, config.tcpKeepAliveMs);
          if (!socket.connecting) clearTimeout(connectTimer);
          else socket.once(target.protocol === 'https:' ? 'secureConnect' : 'connect', () => clearTimeout(connectTimer));
        });
        outgoing.on('error', reject);
        outgoing.once('finish', () => { forwarding.request_body_sent = true; releaseRequestMemory(); });
        outgoing.once('close', releaseRequestMemory);
        outgoing.on('upgrade', (_response, socket) => {
          socket.destroy();
          reject(new ProxyError(502, 'unsupported_upgrade', 'Upstream protocol upgrades are not supported'));
        });
        void (async () => {
          for (const chunk of body.chunks) await writeChunk(outgoing, chunk, signal, false);
          outgoing.end();
        })().catch(reject);
      });

      trace.event('upstream_headers');
      const kind = eligible ? responseKind(upstream, req.method) : null;
      if (committedKind && (kind !== committedKind || (committedKind === 'sse' && upstream.statusCode !== 200))) {
        upstream.destroy();
        throw new ProxyError(502, 'incompatible_upstream_response', `Upstream returned HTTP ${upstream.statusCode} with a format incompatible with the already-started ${committedKind} response`);
      }
      if (committedKind && upstream.statusCode !== res.statusCode) {
        trace.event('late_upstream_status', {}, 'warn');
      }

      if (eligible && (mode === 'after-headers' || !hint) && kind) scheduleHeartbeat(config.firstHeartbeatMs);

      if (kind === 'json') {
        if (Number(upstream.headers['content-length']) > config.maxJsonResponseBytes) {
          throw new ProxyError(502, 'response_too_large', 'JSON response exceeds MAX_JSON_RESPONSE_BYTES');
        }
        enterPhase('buffering_json');
        temporaryDirectory = await storage.create();
        const filename = join(temporaryDirectory, 'response');
        let hasJsonContent = false;
        const validator = createJsonValidator({ maxDepth: config.maxJsonDepth });
        const limiter = new Transform({
          transform(chunk, _encoding, callback) {
            receivedBodyBytes += chunk.length;
            if (!hasJsonContent) hasJsonContent = chunk.some(byte => byte !== 9 && byte !== 10 && byte !== 13 && byte !== 32);
            if (receivedBodyBytes > config.maxJsonResponseBytes) {
              callback(new ProxyError(502, 'response_too_large', 'JSON response exceeds MAX_JSON_RESPONSE_BYTES'));
            } else if (bufferedResponseBytes + chunk.length > config.maxBufferedResponseBytes) {
              callback(new ProxyError(503, 'response_storage_limit', 'Relay response storage limit reached; retry later'));
            } else {
              try { validator.write(chunk); } catch (error) { callback(error); return; }
              bufferedResponseBytes += chunk.length;
              responseStorageBytes += chunk.length;
              callback(null, chunk);
            }
          },
        });
        await pipeline(upstream, limiter, storage.writeStream(filename), { signal });
        if (!hasJsonContent) throw new ProxyError(502, 'empty_upstream_response', 'Upstream returned an empty or whitespace-only JSON body');
        validator.finish();
        enterPhase('sending_json');
        commit('json', Boolean(committedKind));
        actualBodyStarted = receivedBodyBytes > 0;
        const file = storage.readStream(filename);
        file.on('error', onSourceError);
        await pipeline(file, res, { signal });
      } else if (kind === 'sse') {
        enterPhase('sse');
        commit('sse');
        // Headers alone do not count as activity; the timer still emits blanks.
        for await (const chunk of upstream) {
          receivedBodyBytes += chunk.length;
          const output = sseBuffer.push(chunk, heartbeats > 0);
          if (!output.length) continue;
          actualBodyStarted = true;
          lastOutputAt = performance.now();
          await writeChunk(res, output, signal);
          sseBuffer.acknowledge(output.length);
        }
        sseBuffer.finish();
        if (receivedBodyBytes === 0) throw new ProxyError(502, 'empty_upstream_response', 'Upstream returned an empty SSE body');
        res.end();
        await finished(res, { signal, cleanup: true });
      } else {
        // Binary, compressed, no-body and explicitly bypassed responses stay opaque.
        if (eligible) { eligible = false; reason = 'upstream_format'; }
        enterPhase('passthrough');
        commit(null, false);
        const counter = new Transform({
          transform(chunk, _encoding, callback) {
            receivedBodyBytes += chunk.length;
            callback(null, chunk);
          },
        });
        await pipeline(upstream, counter, res, { signal });
      }
      enterPhase('done');
    } catch (caught) {
      enterPhase(phase);
      const error = signal.aborted
        ? (signal.reason?.status === 499 && responseSourceFailure ? responseSourceFailure : signal.reason)
        : caught;
      outcome = error?.status === 499 ? 'client_disconnected' : 'relay_error';
      if (error?.status !== 499) {
        const classified = classifyError(error, phase);
        trace.event('relay_error', { code: error?.code || classified.code, relay_code: classified.code, status: classified.status, syscall: error?.syscall }, 'error');
      }
      sendFailure(classifyError(error, phase));
      abort(error);
      upstream?.destroy();
    } finally {
      clearTimeout(heartbeatTimer);
      clearTimeout(totalTimer);
      clearTimeout(connectTimer);
      clearInterval(stallTimer);
      res.off('drain', onDrain);
      sseBuffer.dispose();
      if (outgoing && !outgoing.writableFinished) outgoing.destroy();
      releaseRequestMemory();
      trace.end(outcome);
      if (temporaryDirectory) await storage.cleanup(temporaryDirectory, responseStorageBytes, releaseResponseStorage.bind(null, responseStorageBytes));
      if (admitted) activeRequests--;
      controllers.delete(controller);
      if (!controllers.size) {
        for (const resolve of idleWaiters) resolve();
        idleWaiters.clear();
      }
    }
  };

  const server = http.createServer({ keepAlive: true, keepAliveInitialDelay: config.tcpKeepAliveMs }, (req, res) => {
    void handler(req, res).catch(() => {
      // A final guard: no unexpected handler rejection may terminate the process.
      try { logger.error?.('{"event":"unexpected_handler_error"}'); } catch { /* logging is best effort */ }
      res.destroy();
    });
  });
  server.requestTimeout = 120_000; // Incoming upload deadline, not inference duration.
  server.once('listening', () => keepalive.start());
  server.once('close', () => { keepalive.stop(); diagnostics.stop(); });
  server.headersTimeout = 60_000;
  server.timeout = 0;
  server.keepAliveTimeout = 65_000;
  function rejectTunnel(socket, status) {
    socket.on('error', () => socket.destroy());
    // Upgrade/CONNECT detach the HTTP parser, including its upload deadline.
    // A half-open peer must not retain a rejected connection forever.
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy());
  }
  server.on('upgrade', (_req, socket) => rejectTunnel(socket, '426 Upgrade Required'));
  server.on('connect', (_req, socket) => rejectTunnel(socket, '405 Method Not Allowed'));
  return {
    server,
    beginShutdown() { draining = true; keepalive.stop(); },
    abortRequests() {
      draining = true;
      keepalive.stop();
      const reason = new ProxyError(503, 'server_shutting_down', 'Relay shutdown grace period expired');
      for (const controller of controllers) if (!controller.signal.aborted) controller.abort(reason);
      diagnostics.abortRequests(reason);
    },
    async whenIdle() {
      await Promise.all([
        controllers.size ? new Promise(resolve => idleWaiters.add(resolve)) : Promise.resolve(),
        diagnostics.whenIdle(),
      ]);
    },
    destroyAgents() { keepalive.stop(); diagnostics.stop(); for (const agent of Object.values(agents)) agent.destroy(); return storage.stop(); },
  };
}
