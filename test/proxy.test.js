import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { Readable, PassThrough, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { once } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createProxy, loadConfig } from '../src/proxy.js';
import { VERSION } from '../src/diagnostics.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const silentLogger = { error() {}, warn() {} };

async function waitFor(check) {
  const deadline = performance.now() + 2000;
  while (performance.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(10);
  }
  assert.fail('Timed out waiting for observable resource state');
}

async function fixture(t, handle, overrides = {}, logger = silentLogger, dependencies = {}) {
  const origin = http.createServer((req, res) => {
    Promise.resolve(handle(req, res)).catch(error => res.destroy(error));
  });
  let relay, directory;
  // Register cleanup before setup: a failed temp-directory/listen step must
  // not leave a listening server keeping the entire test process alive.
  t.after(async () => {
    if (relay) {
      relay.server.closeAllConnections();
      relay.destroyAgents();
      await new Promise(resolve => relay.server.close(resolve));
    }
    origin.closeAllConnections();
    await new Promise(resolve => origin.close(resolve));
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  origin.listen(0, '127.0.0.1');
  await once(origin, 'listening');
  directory = await mkdtemp(join(tmpdir(), 'relay-test-'));
  const config = {
    ...loadConfig({
      TARGET_URL: `http://127.0.0.1:${origin.address().port}`,
      HEARTBEAT_START_DELAY_SECONDS: '0.025',
      HEARTBEAT_INTERVAL_SECONDS: '0.035',
      UPSTREAM_TIMEOUT_SECONDS: '5',
    }),
    tempDirectory: directory,
    ...overrides,
  };
  relay = createProxy(config, { logger, ...dependencies });
  relay.server.listen(0, '127.0.0.1');
  await once(relay.server, 'listening');
  return { url: `http://127.0.0.1:${relay.server.address().port}`, originUrl: `http://127.0.0.1:${origin.address().port}`, origin, relay, server: relay.server, config, directory };
}

function request(url, { method = 'POST', body = '{"model":"custom-model","stream":false}', headers = {}, onChunk, rawPath } = {}) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const outgoing = http.request(url, {
      method,
      ...(rawPath ? { path: rawPath } : {}),
      headers: { ...(body === null ? {} : { 'content-type': 'application/json' }), ...headers },
    }, response => {
      const chunks = [];
      const times = [];
      response.on('data', chunk => {
        chunks.push(chunk);
        times.push(performance.now() - started);
        onChunk?.(chunk, outgoing);
      });
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks), times }));
    });
    outgoing.on('error', reject);
    outgoing.end(body === null ? undefined : body);
  });
}

async function collect(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

test('slow JSON starts blank heartbeats before upstream headers, then returns original JSON', async t => {
  const raw = Buffer.from('{ "model":"anything", "reply":"中文🙂", "usage": {"x":1} }\n');
  const f = await fixture(t, async (_req, res) => {
    await delay(190);
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': raw.length, etag: 'original-hash' });
    res.end(raw);
  });
  const result = await request(f.url + '/custom/endpoint');
  assert.equal(result.status, 200);
  assert.match(result.headers['content-type'], /application\/json/);
  assert.ok(result.times[0] < 150, 'heartbeat must arrive while the upstream is still silent');
  assert.ok(result.times.length >= 3);
  assert.match(result.body.toString(), /^\n\n/);
  assert.deepEqual(result.body.subarray(result.body.length - raw.length), raw);
  assert.deepEqual(JSON.parse(result.body), JSON.parse(raw));
  assert.equal(result.headers['content-length'], undefined);
  assert.equal(result.headers.etag, undefined);
});

test('partial JSON is buffered, so idle heartbeats never appear inside a JSON string', async t => {
  const raw = '{"text":"first second","tools":[{"x":1}]}';
  const f = await fixture(t, async (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/problem+json' });
    res.write('{"text":"first');
    await delay(160);
    res.end(' second","tools":[{"x":1}]}');
  });
  const result = await request(f.url + '/v1/chat/completions');
  assert.equal(result.body.toString().trimStart(), raw);
  assert.equal(JSON.parse(result.body).text, 'first second');
  assert.ok(result.times.length >= 3);
});

test('raw body, model, stream, credential headers, raw path and duplicate query parameters survive', async t => {
  const raw = Buffer.from(' {\n "stream" : false, "model" : "my-unlisted-model", "extra": "\\u4e2d" } ');
  let seen;
  const f = await fixture(t, async (req, res) => {
    seen = { method: req.method, path: req.url, headers: req.headers, body: await collect(req) };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  }, { firstHeartbeatMs: 500 });
  const result = await request(f.url + '/anything/%2Fcase?x=1&x=2&encoded=%2f', {
    method: 'PATCH', body: raw,
    headers: { authorization: 'Bearer original-test-token', cookie: 'session=test', 'x-api-key': 'custom-test-key', 'x-custom': 'unchanged', 'accept-encoding': 'gzip' },
  });
  assert.equal(result.status, 200);
  assert.equal(seen.method, 'PATCH');
  assert.equal(seen.path, '/anything/%2Fcase?x=1&x=2&encoded=%2f');
  assert.deepEqual(seen.body, raw);
  assert.equal(seen.headers.authorization, 'Bearer original-test-token');
  assert.equal(seen.headers['x-api-key'], 'custom-test-key');
  assert.equal(seen.headers.cookie, 'session=test');
  assert.equal(seen.headers['x-custom'], 'unchanged');
  assert.equal(seen.headers['accept-encoding'], 'identity');
  assert.equal(seen.headers['content-length'], String(raw.length));
  assert.match(seen.headers.host, /^127\.0\.0\.1:/);
});

test('target path prefix is appended without decoding client path or changing destination', async t => {
  let seen;
  const origin = http.createServer((req, res) => { seen = { path: req.url, host: req.headers.host }; res.end('ok'); });
  origin.listen(0, '127.0.0.1');
  await once(origin, 'listening');
  const config = loadConfig({ TARGET_URL: `http://127.0.0.1:${origin.address().port}/base/`, HEARTBEAT_INTERVAL_SECONDS: '0' });
  const relay = createProxy(config, { logger: silentLogger });
  relay.server.listen(0, '127.0.0.1');
  await once(relay.server, 'listening');
  t.after(async () => {
    relay.server.closeAllConnections(); relay.destroyAgents();
    await new Promise(resolve => relay.server.close(resolve));
    origin.closeAllConnections(); await new Promise(resolve => origin.close(resolve));
  });
  await request(`http://127.0.0.1:${relay.server.address().port}`, { rawPath: '//other.example/%2e%2e?q=%2F' });
  assert.equal(seen.path, '/base//other.example/%2e%2e?q=%2F');
  assert.equal(seen.host, `127.0.0.1:${origin.address().port}`);
});

test('stream:true receives blank heartbeats before upstream headers and exact SSE events later', async t => {
  const events = 'event: answer\ndata: {"text":"hi"}\n\ndata: [DONE]\n\n';
  const f = await fixture(t, async (_req, res) => {
    await delay(120);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(events);
  });
  const result = await request(f.url + '/custom/stream', { body: '{"stream" : true,"model":"whatever"}' });
  assert.match(result.headers['content-type'], /text\/event-stream/);
  assert.ok(result.times[0] < 100);
  assert.match(result.body.toString(), /^\n\n/);
  assert.equal(result.body.toString().trimStart(), events);
});

test('SSE idle gaps get blanks only between complete events, never inside a split data line', async t => {
  const f = await fixture(t, async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"text":"hel');
    await delay(100);
    res.write('lo"}\r\n\r\n');
    await delay(100);
    res.end('data: [DONE]\n\n');
  });
  const result = await request(f.url + '/stream', { body: '{"stream":true}' });
  const body = result.body.toString();
  assert.ok(body.includes('data: {"text":"hello"}\r\n\r\n'));
  assert.match(body, /hello"}\r\n\r\n\n\n/);
  assert.ok(body.endsWith('data: [DONE]\n\n'));
});

test('fast failures retain status, body, custom headers and multiple Set-Cookie values', async t => {
  const raw = '{"error":{"message":"original failure"}}';
  const f = await fixture(t, (_req, res) => {
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '10', 'set-cookie': ['a=1', 'b=2'] });
    res.end(raw);
  }, { firstHeartbeatMs: 500 });
  const result = await request(f.url + '/v1/messages');
  assert.equal(result.status, 429);
  assert.equal(result.body.toString(), raw);
  assert.equal(result.headers['retry-after'], '10');
  assert.deepEqual(result.headers['set-cookie'], ['a=1', 'b=2']);
});

test('late upstream JSON error keeps its exact JSON under already committed 200', async t => {
  const raw = '{"error":{"message":"upstream quota exceeded","code":"quota"}}';
  const f = await fixture(t, async (_req, res) => {
    await delay(110);
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(raw);
  });
  const result = await request(f.url + '/v1/responses');
  assert.equal(result.status, 200);
  assert.equal(result.body.toString().trimStart(), raw);
});

test('late HTML or compressed responses cannot corrupt an already started JSON response', async t => {
  for (const compressed of [false, true]) {
    await t.test(compressed ? 'gzip' : 'html', async sub => {
      const f = await fixture(sub, async (_req, res) => {
        await delay(90);
        res.writeHead(502, compressed ? { 'content-type': 'application/json', 'content-encoding': 'gzip' } : { 'content-type': 'text/html' });
        res.end(compressed ? gzipSync('{"ok":true}') : '<html>bad gateway</html>');
      });
      const result = await request(f.url + '/api');
      assert.equal(JSON.parse(result.body).error.code, 'incompatible_upstream_response');
    });
  }
});

test('binary and compressed responses known before heartbeat remain exact passthrough', async t => {
  const raw = gzipSync(Buffer.from([0, 1, 2, 255, 3, 10]));
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-encoding': 'gzip', 'content-length': raw.length, etag: 'original' });
    res.flushHeaders();
    setTimeout(() => res.end(raw), 100);
  });
  const result = await request(f.url + '/download');
  assert.deepEqual(result.body, raw);
  assert.equal(result.headers['content-encoding'], 'gzip');
  assert.equal(result.headers.etag, 'original');
});

test('explicit heartbeat bypass preserves binary even if response headers are very slow', async t => {
  const raw = Buffer.from([0, 255, 10, 4]);
  let bypassLeaked;
  const f = await fixture(t, async (req, res) => {
    bypassLeaked = req.headers['x-proxy-heartbeat'];
    await delay(110);
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(raw);
  });
  const result = await request(f.url + '/download', { headers: { 'x-proxy-heartbeat': 'off' } });
  assert.deepEqual(result.body, raw);
  assert.equal(bypassLeaked, undefined);
});

test('GET requests also heartbeat without needing stream or a JSON request body', async t => {
  const f = await fixture(t, async (_req, res) => {
    await delay(110);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"models":[]}');
  });
  const result = await request(f.url + '/models', { method: 'GET', body: null });
  assert.match(result.body.toString(), /^\n\n/);
  assert.deepEqual(JSON.parse(result.body), { models: [] });
});

test('HEAD, OPTIONS, 204 and Range requests never acquire illegal blank body bytes', async t => {
  const f = await fixture(t, async (req, res) => {
    await delay(80);
    if (req.method === 'HEAD') { res.writeHead(200, { 'content-length': '20' }); res.end(); }
    else if (req.headers.range) { res.writeHead(206, { 'content-range': 'bytes 0-2/6' }); res.end('abc'); }
    else { res.writeHead(204); res.end(); }
  });
  const head = await request(f.url + '/api', { method: 'HEAD', body: null });
  assert.equal(head.body.length, 0);
  assert.equal(head.headers['content-length'], '20');
  const options = await request(f.url + '/api', { method: 'OPTIONS', body: null });
  assert.equal(options.status, 204);
  assert.equal(options.body.length, 0);
  const range = await request(f.url + '/api', { method: 'GET', body: null, headers: { range: 'bytes=0-2' } });
  assert.equal(range.status, 206);
  assert.equal(range.body.toString(), 'abc');
});

test('optional relay token is separate from target Authorization and never reaches upstream', async t => {
  let seen, calls = 0;
  const f = await fixture(t, async (req, res) => {
    calls++;
    seen = req.headers;
    await collect(req);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  }, { proxyToken: 'relay-secret', firstHeartbeatMs: 500 });
  const refused = await request(f.url + '/api');
  assert.equal(refused.status, 401);
  assert.equal(calls, 0);
  const health = await request(f.url + '/__proxy_health', { method: 'GET', body: null });
  assert.equal(health.status, 200);
  await request(f.url + '/api', { headers: { 'x-proxy-token': 'relay-secret', authorization: 'Bearer target-secret' } });
  assert.equal(calls, 1);
  assert.equal(seen.authorization, 'Bearer target-secret');
  assert.equal(seen['x-proxy-token'], undefined);
});

test('total timeout still terminates an indefinitely silent upstream after heartbeats', async t => {
  const f = await fixture(t, (_req, res) => { res.on('close', () => {}); }, { totalTimeoutMs: 125 });
  const result = await request(f.url + '/api');
  assert.equal(result.status, 200);
  assert.equal(JSON.parse(result.body).error.code, 'upstream_timeout');
  assert.equal(JSON.parse(result.body).error.status, 504);
});

test('timeout before first heartbeat can still return real HTTP 504', async t => {
  const f = await fixture(t, () => {}, { totalTimeoutMs: 50, firstHeartbeatMs: 500 });
  const result = await request(f.url + '/api');
  assert.equal(result.status, 504);
  assert.equal(JSON.parse(result.body).error.code, 'upstream_timeout');
});

test('request size limit returns 413 without contacting the upstream', async t => {
  let calls = 0;
  const f = await fixture(t, (_req, res) => { calls++; res.end(); }, { maxRequestBytes: 8 });
  const result = await request(f.url + '/api', { body: 'x'.repeat(100) });
  assert.equal(result.status, 413);
  assert.equal(calls, 0);
});

test('response size limit produces a valid JSON error and removes temp files', async t => {
  const f = await fixture(t, async (_req, res) => {
    await delay(70);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"text":"' + 'x'.repeat(100) + '"}');
  }, { maxJsonResponseBytes: 40 });
  const result = await request(f.url + '/api');
  assert.equal(JSON.parse(result.body).error.code, 'response_too_large');
  await delay(30);
  assert.deepEqual(await readdir(f.directory), []);
});

test('client disconnect cancels upstream and deletes an in-progress JSON temp file', async t => {
  let closed;
  const wasClosed = new Promise(resolve => { closed = resolve; });
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"text":"');
    res.on('close', closed);
  });
  await new Promise((resolve, reject) => {
    const outgoing = http.request(f.url + '/api', { method: 'POST', headers: { 'content-type': 'application/json' } }, response => {
      response.once('data', () => { outgoing.destroy(); resolve(); });
      response.on('error', () => {});
    });
    outgoing.on('error', reject);
    outgoing.end('{"stream":false}');
  });
  await Promise.race([wasClosed, delay(500).then(() => { throw new Error('Upstream was not canceled'); })]);
  await delay(40);
  assert.deepEqual(await readdir(f.directory), []);
});

test('redirects are returned unchanged and are never automatically followed', async t => {
  let calls = 0;
  const f = await fixture(t, (_req, res) => {
    calls++;
    res.writeHead(307, { location: 'https://other.example/new' });
    res.end();
  }, { firstHeartbeatMs: 500 });
  const result = await request(f.url + '/api');
  assert.equal(result.status, 307);
  assert.equal(result.headers.location, 'https://other.example/new');
  assert.equal(calls, 1);
});

test('concurrent requests get isolated response files and exact respective bodies', async t => {
  const f = await fixture(t, async (req, res) => {
    const input = await collect(req);
    await delay(80);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(input);
  });
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) => request(f.url + '/api', { body: `{"id":${index}}` })));
  results.forEach((result, index) => assert.equal(JSON.parse(result.body).id, index));
  await delay(40);
  assert.deepEqual(await readdir(f.directory), []);
});

test('configuration rejects unsupported targets and invalid timeout values', () => {
  for (const target of ['ftp://host', 'https://user:secret@host', 'https://host?q=1', 'https://host/#fragment']) {
    assert.throws(() => loadConfig({ TARGET_URL: target }));
  }
  assert.throws(() => loadConfig({ TARGET_URL: 'https://host', HEARTBEAT_INTERVAL_SECONDS: '125' }));
  assert.throws(() => loadConfig({ TARGET_URL: 'https://host', PORT: '-1' }));
  for (const [name, value] of Object.entries({ TCP_KEEPALIVE_SECONDS: '0', UPSTREAM_IDLE_SOCKET_TIMEOUT_SECONDS: '0', DOWNSTREAM_STALL_TIMEOUT_SECONDS: '-1', SHUTDOWN_GRACE_SECONDS: '301', MAX_SSE_EVENT_BYTES: '0', MAX_BUFFERED_SSE_BYTES: '0', ADMIN_REQUEST_TIMEOUT_SECONDS: '121', MAX_JSON_DEPTH: '16385' })) {
    assert.throws(() => loadConfig({ TARGET_URL: 'https://host', [name]: value }), new RegExp(name));
  }
  for (const name of ['ADMIN_REQUEST_TIMEOUT_SECONDS', 'MAX_JSON_DEPTH']) {
    assert.throws(() => loadConfig({ TARGET_URL: 'https://host', [name]: '0' }), new RegExp(name));
  }
  assert.throws(() => loadConfig({ TARGET_URL: 'https://host', MAX_JSON_DEPTH: '1.5' }), /MAX_JSON_DEPTH/);
});

test('defaults use one-second heartbeats and bounded request resources', () => {
  const config = loadConfig({ TARGET_URL: 'https://custom.example' });
  assert.equal(config.heartbeatMs, 1000);
  assert.equal(config.firstHeartbeatMs, 1000);
  assert.equal(config.maxConcurrentRequests, 32);
  assert.equal(config.maxBufferedRequestBytes, 64 * 1024 * 1024);
  assert.equal(config.maxBufferedResponseBytes, 512 * 1024 * 1024);
  assert.equal(config.tcpKeepAliveMs, 15000);
  assert.equal(config.upstreamIdleSocketMs, 15000);
  assert.equal(config.downstreamStallMs, 120000);
  assert.equal(config.shutdownGraceMs, 25000);
  assert.equal(config.maxSseEventBytes, 16 * 1024 * 1024);
  assert.equal(config.maxBufferedSseBytes, 64 * 1024 * 1024);
  assert.equal(config.maxJsonDepth, 1024);
  assert.equal(config.adminRequestTimeoutMs, 15000);
  assert.throws(() => loadConfig({ TARGET_URL: 'https://host', MAX_CONCURRENT_REQUESTS: '0' }));
});

test('empty and whitespace-only JSON responses become useful errors instead of empty successes', async t => {
  for (const raw of ['', ' \t\r\n']) {
    await t.test(raw ? 'whitespace only' : 'zero bytes', async sub => {
      const f = await fixture(sub, (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(raw);
      }, { firstHeartbeatMs: 500 });
      const result = await request(f.url + '/api');
      assert.equal(result.status, 502);
      assert.equal(JSON.parse(result.body).error.code, 'empty_upstream_response');
    });
  }
});

test('an empty SSE response reports a valid SSE error even before the first heartbeat', async t => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end();
  }, { firstHeartbeatMs: 500 });
  const result = await request(f.url + '/stream', { body: '{"stream":true}' });
  assert.match(result.headers['content-type'], /text\/event-stream/);
  assert.match(result.body.toString(), /event: error/);
  assert.ok(result.body.toString().includes('empty_upstream_response'));
});

test('an upstream SSE disconnect at a safe boundary emits an error event without waiting for a heartbeat', async t => {
  const f = await fixture(t, async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"text":"first"}\n\n');
    await delay(30);
    res.destroy();
  }, { firstHeartbeatMs: 500 });
  const result = await request(f.url + '/stream', { body: '{"stream":true}' });
  assert.ok(result.body.toString().startsWith('data: {"text":"first"}\n\n'));
  assert.ok(result.body.toString().includes('event: error\ndata: {"error":'));
});

test('concurrency limit rejects excess requests but keeps health checks and later requests working', async t => {
  let entered;
  const originEntered = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, async (_req, res) => {
    entered();
    await delay(100);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  }, { maxConcurrentRequests: 1 });
  const first = request(f.url + '/api');
  await originEntered;
  const rejected = await request(f.url + '/api');
  assert.equal(rejected.status, 503);
  assert.equal(rejected.headers['retry-after'], '1');
  assert.equal(JSON.parse(rejected.body).error.code, 'relay_busy');
  assert.equal((await request(f.url + '/__proxy_health', { method: 'GET', body: null })).status, 200);
  await first;
  await delay(10);
  assert.equal(JSON.parse((await request(f.url + '/api')).body).ok, true);
});

test('global request memory budget is enforced during partial uploads and released afterward', async t => {
  const f = await fixture(t, async (req, res) => {
    await collect(req);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  }, { maxBufferedRequestBytes: 16, firstHeartbeatMs: 500 });
  let first;
  const firstResult = new Promise((resolve, reject) => {
    first = http.request(f.url + '/api', { method: 'POST' }, async res => {
      try { resolve({ status: res.statusCode, body: await collect(res) }); } catch (error) { reject(error); }
    });
    first.on('error', reject);
    first.write('12345678');
  });
  await delay(30);
  const rejected = await request(f.url + '/api', { body: '123456789' });
  assert.equal(rejected.status, 503);
  assert.equal(JSON.parse(rejected.body).error.code, 'request_memory_limit');
  first.end();
  assert.equal((await firstResult).status, 200);
  await delay(10);
  assert.equal((await request(f.url + '/api', { body: '123456789' })).status, 200);
});

test('client cancellation during a partial upload releases its concurrency slot', async t => {
  const f = await fixture(t, async (req, res) => {
    await collect(req);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  }, { maxConcurrentRequests: 1 });
  const upload = http.request(f.url + '/api', { method: 'POST' });
  upload.on('error', () => {});
  upload.write('partial');
  await delay(30);
  upload.destroy();
  await delay(30);
  const result = await request(f.url + '/api');
  assert.equal(JSON.parse(result.body).ok, true);
});

test('request memory is released after forwarding rather than being held throughout AI inference', async t => {
  let entered;
  const originEntered = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, async (req, res) => {
    await collect(req);
    entered();
    await delay(80);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  }, { maxBufferedRequestBytes: 32 });
  const first = request(f.url + '/api', { body: 'x'.repeat(30) });
  await originEntered;
  const second = request(f.url + '/api', { body: 'y'.repeat(30) });
  for (const result of await Promise.all([first, second])) assert.equal(JSON.parse(result.body).ok, true);
});

test('SSE activity resets the heartbeat deadline without skipping a full interval', async t => {
  const f = await fixture(t, async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"n":1}\n\n');
    await delay(411);
    res.write('data: {"n":2}\n\n');
    await delay(669);
    res.end('data: [DONE]\n\n');
  }, { heartbeatMs: 300, firstHeartbeatMs: 20 });
  const result = await request(f.url + '/stream', { body: '{"stream":true}' });
  const gaps = result.times.slice(1).map((time, i) => time - result.times[i]);
  assert.ok(Math.max(...gaps) < 450, `unexpected heartbeat gap: ${Math.max(...gaps)}ms`);
});

test('missing temporary storage directories are created automatically', async t => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  }, { firstHeartbeatMs: 500 });
  await rm(f.directory, { recursive: true, force: true });
  const result = await request(f.url + '/api');
  assert.equal(JSON.parse(result.body).ok, true);
  await delay(20);
  assert.deepEqual(await readdir(f.directory), []);
});

test('the diagnostics page is independent of the target and protects its data with ADMIN_TOKEN', async t => {
  let hits = 0;
  const f = await fixture(t, (_req, res) => { hits++; res.end('target'); }, { adminToken: 'admin-secret', proxyToken: 'proxy-secret' });
  const get = (path, headers = {}) => request(f.url + path, { method: 'GET', body: null, headers });
  const page = await get('/__proxy/');
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /text\/html/);
  assert.match(page.body.toString(), /AI 中转 · 运行诊断/);
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal((await get('/__proxy/admin.js')).status, 200);
  assert.equal((await get('/__proxy/status')).status, 401);
  assert.equal((await get('/__proxy/status?token=admin-secret')).status, 401);
  assert.equal((await get('/__proxy/status', { 'x-proxy-token': 'proxy-secret' })).status, 401);
  const status = await get('/__proxy/status', { 'x-admin-token': 'admin-secret' });
  assert.equal(status.status, 200);
  assert.equal(JSON.parse(status.body).total_requests, 0);
  assert.equal((await get('/__proxy/not-found')).status, 404);
  assert.equal((await request(f.url + '/__proxy/status')).status, 405);
  assert.equal(hits, 0);
  const health = JSON.parse((await get('/__proxy_health')).body);
  assert.equal(health.diagnostics, '/__proxy/');
  assert.equal(health.version, VERSION);
});

test('request diagnostics are disabled unless an ADMIN_TOKEN is configured', async t => {
  const f = await fixture(t, (_req, res) => res.end('target'));
  for (const path of ['/__proxy/status', '/__proxy/probe?seconds=0.1']) {
    const result = await request(f.url + path, { method: 'GET', body: null });
    assert.equal(result.status, 503);
    assert.match(JSON.parse(result.body).error, /ADMIN_TOKEN/);
  }
});

test('live diagnostics identify heartbeats and upstream errors without recording secrets', async t => {
  const log = [];
  const logger = Object.fromEntries(['info', 'warn', 'error'].map(level => [level, value => log.push(JSON.parse(value))]));
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  let upstreamHeaders;
  const f = await fixture(t, async (req, res) => {
    upstreamHeaders = req.headers;
    await collect(req);
    await gate;
    res.writeHead(503, { 'content-type': 'application/json', 'x-render-relay-request-id': 'upstream-cannot-spoof-id' });
    res.end('{"error":"upstream-error-body-secret"}');
  }, { adminToken: 'management-secret', maxConcurrentRequests: 1 }, logger);
  const status = async () => JSON.parse((await request(f.url + '/__proxy/status', {
    method: 'GET', body: null, headers: { 'x-admin-token': 'management-secret' },
  })).body);
  let firstHeartbeat;
  const first = new Promise(resolve => { firstHeartbeat = resolve; });
  const pending = request(f.url + '/api/slow?api_key=query-secret', {
    body: '{"prompt":"request-body-secret"}',
    headers: { authorization: 'Bearer authorization-secret', cookie: 'session=cookie-secret', 'x-goog-api-key': 'api-key-secret', 'x-admin-token': 'management-secret' },
    onChunk: () => firstHeartbeat(),
  });
  await first;
  const live = await status();
  assert.equal(live.active.length, 1);
  assert.equal(live.active[0].phase, 'waiting_headers');
  assert.ok(live.active[0].heartbeats >= 1);
  assert.ok(live.active[0].first_heartbeat_ms >= 0);
  assert.equal(live.active[0].heartbeat_enabled, true);
  assert.equal(live.active[0].path, '/api/slow');
  assert.equal(live.active[0].upstream_status, null);
  release();
  const response = await pending;
  await delay(15);
  const final = await status();
  assert.equal(final.active.length, 0);
  assert.equal(final.total_requests, 1);
  assert.equal(response.headers['x-render-relay-request-id'], live.active[0].request_id);
  const finished = final.events.find(e => e.event === 'request_finished');
  assert.equal(finished.upstream_status, 503);
  assert.equal(finished.downstream_status, 200);
  assert.ok(final.events.some(e => e.event === 'late_upstream_status'));
  assert.equal(upstreamHeaders['x-admin-token'], undefined);
  assert.equal(upstreamHeaders.authorization, 'Bearer authorization-secret');
  const recorded = JSON.stringify([live, final, log]);
  for (const secret of ['query-secret', 'request-body-secret', 'authorization-secret', 'cookie-secret', 'api-key-secret', 'management-secret', 'upstream-error-body-secret']) {
    assert.ok(!recorded.includes(secret), `diagnostics leaked ${secret}`);
  }
  assert.ok(log.some(e => e.event === 'heartbeat_started'));
});

test('a late upstream timeout is visible even when downstream heartbeats already committed HTTP 200', async t => {
  const f = await fixture(t, async (_req, res) => {
    await delay(110);
    res.writeHead(524, { 'content-type': 'text/html' });
    res.end('<p>upstream timeout</p>');
  }, { adminToken: 'admin-secret' });
  const response = await request(f.url + '/api');
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.body).error.code, 'incompatible_upstream_response');
  const data = JSON.parse((await request(f.url + '/__proxy/status', { method: 'GET', body: null, headers: { 'x-admin-token': 'admin-secret' } })).body);
  const error = data.events.find(e => e.event === 'relay_error');
  assert.equal(error.upstream_status, 524);
  assert.equal(error.downstream_status, 200);
  assert.equal(error.phase, 'waiting_headers');
  assert.equal(error.code, 'incompatible_upstream_response');
});

test('slow website navigation and static resources stay byte exact and never acquire speculative JSON', async t => {
  for (const headers of [
    { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
    { 'sec-fetch-mode': 'navigate' },
    { 'sec-fetch-dest': 'script' },
    { 'sec-fetch-dest': 'image' },
  ]) {
    await t.test(JSON.stringify(headers), async sub => {
      const raw = '<!doctype html><title>Unchanged target</title><script>fetch("https://original.example/api")</script>';
      const f = await fixture(sub, async (_req, res) => {
        await delay(80);
        res.writeHead(200, { 'content-type': 'text/html', 'content-length': Buffer.byteLength(raw) });
        res.end(raw);
      });
      const response = await request(f.url + '/', { method: 'GET', body: null, headers });
      assert.equal(response.status, 200);
      assert.equal(response.body.toString(), raw);
      assert.match(response.headers['content-type'], /text\/html/);
      assert.equal(Number(response.headers['content-length']), Buffer.byteLength(raw));
    });
  }
});

test('authenticated heartbeat probes stream blanks without calling the target', async t => {
  let hits = 0;
  const f = await fixture(t, (_req, res) => { hits++; res.end('target'); }, { adminToken: 'admin-secret' });
  const result = await request(f.url + '/__proxy/probe?seconds=0.16', {
    method: 'GET', body: null, headers: { 'x-admin-token': 'admin-secret' },
  });
  assert.equal(result.status, 200);
  assert.ok(result.times.length >= 3);
  assert.match(result.body.toString(), /^\n\n/);
  const data = JSON.parse(result.body);
  assert.equal(data.probe, true);
  assert.ok(data.heartbeats >= 2);
  assert.equal(hits, 0);
  for (const seconds of ['0', '181', 'NaN']) {
    const invalid = await request(f.url + '/__proxy/probe?seconds=' + seconds, { method: 'GET', body: null, headers: { 'x-admin-token': 'admin-secret' } });
    assert.equal(invalid.status, 400);
  }
});

test('diagnostics retain only a bounded recent event history', async t => {
  const f = await fixture(t, (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); }, { adminToken: 'admin-secret', firstHeartbeatMs: 500 });
  for (let i = 0; i < 55; i++) await request(f.url + '/api');
  const data = JSON.parse((await request(f.url + '/__proxy/status', { method: 'GET', body: null, headers: { 'x-admin-token': 'admin-secret' } })).body);
  assert.equal(data.events.length, 200);
  assert.equal(data.total_requests, 55);
});

test('cancelled diagnostic probes release their concurrency slots', async t => {
  const f = await fixture(t, (_req, res) => res.end('target'), { adminToken: 'admin-secret' });
  const probes = [];
  t.after(() => probes.forEach(req => req.destroy()));
  async function start() {
    return new Promise((resolve, reject) => {
      const req = http.get(f.url + '/__proxy/probe?seconds=2', { headers: { 'x-admin-token': 'admin-secret' } }, res => {
        res.on('error', () => {});
        res.once('data', () => resolve(req));
        res.resume();
      });
      req.on('error', reject);
      probes.push(req);
    });
  }
  const first = await start();
  const second = await start();
  const get = () => request(f.url + '/__proxy/probe?seconds=0.08', { method: 'GET', body: null, headers: { 'x-admin-token': 'admin-secret' } });
  assert.equal((await get()).status, 429);
  first.destroy();
  second.destroy();
  await delay(20);
  assert.equal((await get()).status, 200);
});

test('direct and relayed requests preserve the reported AI Studio headers, raw JSON and Origin / Referer values', async t => {
  const seen = [];
  const f = await fixture(t, async (req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers, body: await collect(req) });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  }, { firstHeartbeatMs: 500, adminToken: 'admin-secret' });
  const path = '/custom/%2Fgenerate?alt=json&key=query-secret&x=1&x=2';
  const body = Buffer.from(' {\n "model":"gemini-4-argon", "stream":false, "contents":[{"text":"中文\\n原始格式"}], "proof":"proof-secret"\n} ');
  const headers = {
    'x-aistudio-g1-tier': 'test-tier',
    'x-aistudio-visit-id': 'test-visit-id',
    'x-goog-api-key': 'api-key-secret',
    'x-goog-authuser': '0',
    authorization: 'Bearer authorization-secret',
    'content-type': 'application/json; charset=utf-8',
    'x-user-agent': 'test-client/1.0',
    cookie: 'session=cookie-secret',
    origin: 'https://browser-origin.example',
    referer: 'https://browser-origin.example/app?session=referer-secret',
    'user-agent': 'test-browser-agent',
    'accept-encoding': 'gzip, br',
    connection: 'keep-alive, x-hop-only',
    'x-hop-only': 'connection-specific',
  };
  await request(f.originUrl + path, { body, headers });
  await request(f.url + path, { body, headers });
  const [direct, relayed] = seen;
  assert.equal(relayed.method, direct.method);
  assert.equal(relayed.url, direct.url);
  assert.deepEqual(relayed.body, direct.body);
  assert.deepEqual(relayed.body, body);
  for (const name of Object.keys(headers).filter(name => !['accept-encoding', 'connection', 'x-hop-only'].includes(name))) {
    assert.equal(relayed.headers[name], direct.headers[name], `changed business header ${name}`);
  }
  assert.equal(relayed.headers['accept-encoding'], 'identity');
  assert.equal(relayed.headers['x-hop-only'], undefined);
  const data = JSON.parse((await request(f.url + '/__proxy/status', { method: 'GET', body: null, headers: { 'x-admin-token': 'admin-secret' } })).body);
  const final = data.events.find(e => e.event === 'request_finished');
  assert.equal(final.request_body_bytes, body.length);
  assert.equal(final.request_body_sent, true);
  assert.equal(final.origin_matches_target, false);
  assert.equal(final.referer_matches_target, false);
  assert.ok(final.changed_header_names.includes('host'));
  assert.ok(final.changed_header_names.includes('accept-encoding'));
  assert.ok(final.removed_header_names.includes('x-hop-only'));
  for (const name of ['authorization', 'x-goog-api-key', 'x-goog-authuser', 'x-aistudio-g1-tier', 'x-aistudio-visit-id', 'x-user-agent', 'cookie', 'origin', 'referer']) {
    assert.ok(final.forwarded_header_names.includes(name));
    assert.ok(!final.changed_header_names.includes(name));
    assert.ok(!final.removed_header_names.includes(name));
  }
  for (const secret of ['api-key-secret', 'authorization-secret', 'cookie-secret', 'referer-secret', 'proof-secret', 'query-secret']) {
    assert.ok(!JSON.stringify(data).includes(secret));
  }
});

test('compressed request bodies remain the original bytes without stream re-serialization', async t => {
  const raw = gzipSync(' { "stream":false, "model":"custom", "proof":"original" } ');
  let seen;
  const f = await fixture(t, async (req, res) => {
    seen = { headers: req.headers, body: await collect(req) };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  }, { firstHeartbeatMs: 500 });
  await request(f.url + '/api', { body: raw, headers: { 'content-encoding': 'gzip' } });
  assert.deepEqual(seen.body, raw);
  assert.equal(seen.headers['content-encoding'], 'gzip');
  assert.equal(Number(seen.headers['content-length']), raw.length);
});

test('a split SSE BOM cannot hide the first event after speculative heartbeats', async t => {
  const events = 'data: {"first":true}\n\ndata: [DONE]\n\n';
  const f = await fixture(t, async (_req, res) => {
    await delay(80);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const byte of [0xef, 0xbb, 0xbf]) {
      res.write(Buffer.from([byte]));
      await delay(10);
    }
    res.end(events);
  });
  const result = await request(f.url + '/stream', { body: '{"stream":true}' });
  assert.match(result.body.toString(), /^\n\n/);
  assert.ok(!result.body.includes(Buffer.from([0xef, 0xbb, 0xbf])));
  assert.equal(result.body.toString().trimStart(), events);
});

test('an initial SSE BOM stays intact and does not block idle heartbeats', async t => {
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const f = await fixture(t, async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(bom);
    await delay(140);
    res.end('data: [DONE]\n\n');
  });
  const result = await request(f.url + '/stream', { body: '{"stream":true}' });
  assert.deepEqual(result.body.subarray(0, 3), bom);
  assert.match(result.body.subarray(3).toString(), /^\n\n/);
  assert.ok(result.times.length >= 3);
});

test('JSON with a non-UTF-8 charset stays opaque instead of receiving ASCII heartbeats', async t => {
  const raw = Buffer.from('{"ok":true}', 'utf16le');
  const f = await fixture(t, async (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json; charset="utf-16le"', 'content-length': raw.length });
    res.flushHeaders();
    await delay(100);
    res.end(raw);
  });
  const result = await request(f.url + '/api');
  assert.deepEqual(result.body, raw);
  assert.equal(Number(result.headers['content-length']), raw.length);
});

test('oversized Content-Length is rejected before the client uploads its body', async t => {
  let hits = 0;
  const f = await fixture(t, (_req, res) => { hits++; res.end(); }, { maxRequestBytes: 8 });
  const result = await new Promise((resolve, reject) => {
    const outgoing = http.request(f.url + '/api', { method: 'POST', headers: { 'content-length': '1000' } }, async res => {
      try { resolve({ status: res.statusCode, headers: res.headers, body: await collect(res) }); } catch (error) { reject(error); }
    });
    outgoing.on('error', reject);
    const deadline = setTimeout(() => outgoing.destroy(new Error('Oversized upload was not rejected from its headers')), 500);
    t.after(() => { clearTimeout(deadline); outgoing.destroy(); });
    outgoing.flushHeaders();
  });
  assert.equal(result.status, 413);
  assert.equal(result.headers.connection, 'close');
  assert.equal(JSON.parse(result.body).error.code, 'request_too_large');
  assert.equal(hits, 0);
});

test('configuration rejects integer limits outside the safe numeric range', () => {
  for (const name of ['MAX_REQUEST_BYTES', 'MAX_JSON_RESPONSE_BYTES', 'MAX_BUFFERED_REQUEST_BYTES', 'MAX_BUFFERED_RESPONSE_BYTES', 'MAX_SSE_EVENT_BYTES', 'MAX_BUFFERED_SSE_BYTES']) {
    assert.throws(() => loadConfig({ TARGET_URL: 'http://localhost', [name]: '9007199254740992' }), new RegExp(name));
  }
});

test('concurrent JSON responses share a disk budget and release it after cleanup', async t => {
  let entered;
  const firstChunk = new Promise(resolve => { entered = resolve; });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const raw = '{"ok":true}';
  const f = await fixture(t, async (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url === '/first') {
      res.write(raw);
      entered();
      await gate;
      res.end();
    } else res.end(raw);
  }, { maxBufferedResponseBytes: 16, adminToken: 'admin-secret' });
  const first = request(f.url + '/first');
  await firstChunk;
  await waitFor(async () => {
    const data = JSON.parse((await request(f.url + '/__proxy/status', {
      method: 'GET', body: null, headers: { 'x-admin-token': 'admin-secret' },
    })).body);
    return data.resources.buffered_response_bytes === Buffer.byteLength(raw);
  });
  const refused = await request(f.url + '/second');
  assert.equal(JSON.parse(refused.body).error.code, 'response_storage_limit');
  assert.equal(JSON.parse(refused.body).error.status, 503);
  release();
  assert.equal(JSON.parse((await first).body).ok, true);
  await delay(30);
  assert.equal(JSON.parse((await request(f.url + '/third')).body).ok, true);
  await delay(30);
  assert.deepEqual(await readdir(f.directory), []);
});

test('cancelling a buffered JSON response releases its disk budget and admission slot', async t => {
  const f = await fixture(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"ok":true}');
    if (req.url !== '/cancel') res.end();
  }, { maxBufferedResponseBytes: 16, maxConcurrentRequests: 1, adminToken: 'admin-secret' });
  const status = async () => JSON.parse((await request(f.url + '/__proxy/status', {
    method: 'GET', body: null, headers: { 'x-admin-token': 'admin-secret' },
  })).body);
  let cancel;
  const began = new Promise((resolve, reject) => {
    cancel = http.get(f.url + '/cancel', res => {
      res.on('error', () => {});
      res.once('data', resolve);
      res.resume();
    });
    cancel.on('error', reject);
  });
  t.after(() => cancel.destroy());
  await began;
  await waitFor(async () => (await status()).resources.buffered_response_bytes === 11);
  cancel.destroy();
  const resources = await waitFor(async () => {
    const data = (await status()).resources;
    return data.active_requests === 0 && data;
  });
  assert.equal(resources.active_requests, 0);
  assert.equal(resources.buffered_request_bytes, 0);
  assert.equal(resources.buffered_response_bytes, 0);
  assert.equal(JSON.parse((await request(f.url + '/next')).body).ok, true);
});

test('opaque response diagnostics count bytes without changing the response', async t => {
  const raw = Buffer.from([0, 255, 1, 2, 3, 10]);
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': raw.length });
    res.end(raw);
  }, { adminToken: 'admin-secret' });
  const result = await request(f.url + '/download');
  assert.deepEqual(result.body, raw);
  const status = JSON.parse((await request(f.url + '/__proxy/status', {
    method: 'GET', body: null, headers: { 'x-admin-token': 'admin-secret' },
  })).body);
  const finished = status.events.find(event => event.event === 'request_finished');
  assert.equal(finished.upstream_body_bytes, raw.length);
});

test('a truncated BOM prefix in SSE reports an error and explicit bypass still preserves bytes', async t => {
  const raw = Buffer.from([0xef, 0xbb]);
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(raw);
  }, { firstHeartbeatMs: 500 });
  const result = await request(f.url + '/stream', { body: '{"stream":true}' });
  assert.match(result.body.toString(), /incomplete_sse_event/);
  const bypassed = await request(f.url + '/stream', { body: '{"stream":true}', headers: { 'x-proxy-heartbeat': 'off' } });
  assert.deepEqual(bypassed.body, raw);
});

test('unsupported upgrades and CONNECT cannot keep rejected sockets open indefinitely', async t => {
  for (const upgrade of [true, false]) {
    await t.test(upgrade ? 'Upgrade' : 'CONNECT', async sub => {
      let socket;
      sub.after(() => socket?.destroy());
      const f = await fixture(sub, (_req, res) => res.end('target'));
      const data = await new Promise((resolve, reject) => {
        socket = net.connect({ host: '127.0.0.1', port: f.server.address().port, allowHalfOpen: true });
        const chunks = [];
        socket.on('data', chunk => chunks.push(chunk));
        socket.on('error', reject);
        socket.once('end', () => resolve(Buffer.concat(chunks).toString()));
        socket.once('connect', () => socket.write(upgrade
          ? 'GET /socket HTTP/1.1\r\nHost: relay.local\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'
          : 'CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n'));
      });
      assert.match(data, upgrade ? /^HTTP\/1.1 426 / : /^HTTP\/1.1 405 /);
      assert.equal(socket.writableEnded, false, 'The peer deliberately has not closed its sending side');
      let count;
      for (let i = 0; i < 50; i++) {
        count = await new Promise((resolve, reject) => f.server.getConnections((error, value) => error ? reject(error) : resolve(value)));
        if (count === 0) break;
        await delay(10);
      }
      assert.equal(count, 0, 'Rejected sockets must close without waiting for the peer to send FIN');
    });
  }
});

test('heartbeats continue through a long pause inside an upstream SSE data field', async t => {
  const f = await fixture(t, async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"text":"first');
    await delay(450);
    res.end(' second"}\n\ndata: [DONE]\n\n');
  }, { firstHeartbeatMs: 10, heartbeatMs: 20 });
  const result = await request(f.url + '/stream', { body: '{"stream":true}' });
  assert.ok(result.times.length >= 5);
  const gaps = result.times.slice(1).map((time, index) => time - result.times[index]);
  assert.ok(Math.max(...gaps) < 200, `Lost heartbeats during partial event: ${Math.max(...gaps)}ms`);
  assert.equal(result.body.toString().trimStart(), 'data: {"text":"first second"}\n\ndata: [DONE]\n\n');
});

test('clean EOF and TCP reset during a partial SSE event produce parseable errors', async t => {
  for (const reset of [false, true]) {
    await t.test(reset ? 'reset' : 'clean EOF', async sub => {
      let hits = 0;
      const f = await fixture(sub, async (_req, res) => {
        hits++;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"incomplete":');
        await delay(70);
        if (reset) res.destroy(); else res.end();
      });
      const result = await request(f.url + '/stream', { body: '{"stream":true}' });
      assert.ok(!result.body.toString().includes('"incomplete"'));
      const frame = result.body.toString().trimStart();
      assert.match(frame, /^event: error\ndata: /);
      const error = JSON.parse(frame.split('\n')[1].slice(6)).error;
      assert.equal(error.code, reset ? 'upstream_connection_error' : 'incomplete_sse_event');
      assert.equal(hits, 1, 'A failed AI request must never be replayed automatically');
    });
  }
});

test('oversized SSE events fail at a safe boundary and release their memory', async t => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: ' + 'x'.repeat(100) + '\n\n');
  }, { maxSseEventBytes: 32, adminToken: 'admin-secret' });
  const result = await request(f.url + '/stream', { body: '{"stream":true}' });
  assert.match(result.body.toString().trimStart(), /^event: error\ndata: /);
  assert.match(result.body.toString(), /sse_event_too_large/);
  const status = JSON.parse((await request(f.url + '/__proxy/status', {
    method: 'GET', body: null, headers: { 'x-admin-token': 'admin-secret' },
  })).body);
  assert.equal(status.resources.buffered_sse_bytes, 0);
});

test('SSE buffers share a budget, and cancellation frees capacity for another stream', async t => {
  let cancel;
  t.after(() => cancel?.destroy());
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: 1234567890');
  }, { maxBufferedSseBytes: 25, adminToken: 'admin-secret' });
  const stats = async () => JSON.parse((await request(f.url + '/__proxy/status', {
    method: 'GET', body: null, headers: { 'x-admin-token': 'admin-secret' },
  })).body).resources;
  await new Promise((resolve, reject) => {
    cancel = http.get(f.url + '/stream', res => { res.on('error', () => {}); res.resume(); resolve(); });
    cancel.on('error', reject);
  });
  await waitFor(async () => (await stats()).buffered_sse_bytes === 16);
  const rejected = await request(f.url + '/stream', { body: '{"stream":true}' });
  assert.match(rejected.body.toString(), /sse_memory_limit/);
  assert.equal((await stats()).buffered_sse_bytes, 16);
  cancel.destroy();
  await waitFor(async () => (await stats()).active_requests === 0);
  assert.equal((await stats()).buffered_sse_bytes, 0);
});

test('idle upstream sockets expire while active slow requests outlive the pool timeout', async t => {
  const sockets = [];
  const f = await fixture(t, async (req, res) => {
    sockets.push(req.socket);
    if (req.url === '/slow') await delay(650);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  }, { upstreamIdleSocketMs: 500 });
  await request(f.url + '/warmup');
  const slow = await request(f.url + '/slow');
  assert.equal(JSON.parse(slow.body).ok, true);
  assert.equal(sockets[0], sockets[1], 'The active request should use the still-fresh pooled socket');
  await waitFor(() => sockets[1].destroyed);
  await request(f.url + '/fresh');
  assert.notEqual(sockets[1], sockets[2]);
});

test('a client that stops draining a response cannot retain its upstream and relay slot', async t => {
  let client;
  t.after(() => client?.destroy());
  const f = await fixture(t, async (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    const chunk = Buffer.alloc(64 * 1024);
    await pipeline(Readable.from((function* () { for (let i = 0; i < 2048; i++) yield chunk; })()), res);
  }, { downstreamStallMs: 80, adminToken: 'admin-secret', totalTimeoutMs: 0 });
  await new Promise((resolve, reject) => {
    client = http.get(f.url + '/large', { headers: { 'x-proxy-heartbeat': 'off' } }, res => { res.on('error', () => {}); res.pause(); resolve(); });
    client.on('error', reject);
  });
  let lastStatus;
  const final = await waitFor(async () => {
    const status = JSON.parse((await request(f.url + '/__proxy/status', {
      method: 'GET', body: null, headers: { 'x-admin-token': 'admin-secret' },
    })).body);
    lastStatus = status;
    return status.events.some(event => event.code === 'downstream_stalled') && status.resources.active_requests === 0 && status;
  }).catch(error => {
    throw new Error(`${error.message}; resources=${JSON.stringify(lastStatus?.resources)}; events=${JSON.stringify(lastStatus?.events.map(event => ({ event: event.event, code: event.code, phase: event.phase, outcome: event.outcome, bytes: event.upstream_body_bytes })))}`, { cause: error });
  });
  assert.equal(final.resources.buffered_request_bytes, 0);
  assert.equal(final.resources.buffered_sse_bytes, 0);
});

test('draining marks readiness unhealthy and rejects new forwarding without touching the target', async t => {
  let hits = 0;
  const f = await fixture(t, (_req, res) => { hits++; res.end('target'); });
  f.relay.beginShutdown();
  const health = await request(f.url + '/__proxy_health', { method: 'GET', body: null });
  assert.equal(health.status, 503);
  assert.equal(JSON.parse(health.body).ok, false);
  const rejected = await request(f.url + '/api');
  assert.equal(rejected.status, 503);
  assert.equal(JSON.parse(rejected.body).error.code, 'server_shutting_down');
  assert.equal(hits, 0);
  await f.relay.whenIdle();
});

test('forced draining finishes diagnostic probes with JSON instead of silently disconnecting', async t => {
  const f = await fixture(t, (_req, res) => res.end(), { adminToken: 'admin-secret' });
  let first;
  const started = new Promise(resolve => { first = resolve; });
  const pending = request(f.url + '/__proxy/probe?seconds=10', {
    method: 'GET', body: null, headers: { 'x-admin-token': 'admin-secret' }, onChunk: first,
  });
  await started;
  f.relay.abortRequests();
  assert.equal(JSON.parse((await pending).body).error.code, 'server_shutting_down');
  const rejected = await request(f.url + '/__proxy/probe?seconds=1', {
    method: 'GET', body: null, headers: { 'x-admin-token': 'admin-secret' },
  });
  assert.equal(rejected.status, 503);
});

test('upstream resets remain upstream failures in diagnostics and never replay an AI request', async t => {
  for (const binary of [false, true]) {
    await t.test(binary ? 'opaque response' : 'buffered JSON', async sub => {
      let hits = 0;
      const f = await fixture(sub, async (_req, res) => {
        hits++;
        res.writeHead(200, { 'content-type': binary ? 'application/octet-stream' : 'application/json' });
        res.write(binary ? 'partial bytes' : '{"unfinished":');
        await delay(70);
        res.destroy();
      }, { adminToken: 'admin-secret' });
      if (binary) await assert.rejects(request(f.url + '/api'), /aborted|reset|closed/i);
      else assert.equal(JSON.parse((await request(f.url + '/api')).body).error.code, 'upstream_connection_error');
      const status = await waitFor(async () => {
        const data = JSON.parse((await request(f.url + '/__proxy/status', {
          method: 'GET', body: null, headers: { 'x-admin-token': 'admin-secret' },
        })).body);
        return data.resources.active_requests === 0 && data;
      });
      assert.equal(hits, 1);
      assert.equal(status.events.find(event => event.event === 'request_finished').outcome, 'relay_error');
      assert.ok(status.events.some(event => ['ECONNRESET', 'ERR_STREAM_PREMATURE_CLOSE'].includes(event.code)));
      assert.deepEqual(await readdir(f.directory), []);
    });
  }
});

test('the public keepalive endpoint is lightweight, method-limited and independent of proxy authentication', async t => {
  let hits = 0;
  const f = await fixture(t, (_req, res) => { hits++; res.end('target'); }, { proxyToken: 'proxy-secret' });
  for (const method of ['GET', 'HEAD']) {
    const response = await request(f.url + '/keepalive?ignored=1', { method, body: null });
    assert.equal(response.status, 200);
    assert.equal(response.body.length, 0);
    assert.equal(response.headers['cache-control'], 'no-store');
  }
  const rejected = await request(f.url + '/keepalive');
  assert.equal(rejected.status, 405);
  assert.equal(rejected.headers.allow, 'GET, HEAD');
  assert.equal(hits, 0);
  f.relay.beginShutdown();
  assert.equal((await request(f.url + '/keepalive', { method: 'GET', body: null })).status, 503);
});

test('keepalive settings require ADMIN_TOKEN and apply immediately without calling the AI target', async t => {
  let hits = 0;
  const f = await fixture(t, (_req, res) => { hits++; res.end('target'); }, { adminToken: 'admin-secret', proxyToken: 'proxy-secret' });
  const path = f.url + '/__proxy/keepalive';
  const admin = { 'x-admin-token': 'admin-secret' };
  const settings = { url: f.url + '/keepalive', interval_seconds: 5 };
  assert.equal((await request(path, { method: 'GET', body: null })).status, 401);
  assert.equal((await request(path + '?token=admin-secret', { method: 'GET', body: null })).status, 401);
  assert.equal((await request(path, { method: 'PUT', body: JSON.stringify(settings) })).status, 401);
  const saved = await request(path, { method: 'PUT', headers: admin, body: JSON.stringify(settings) });
  assert.equal(saved.status, 200);
  assert.equal(JSON.parse(saved.body).url, settings.url);
  const status = async () => JSON.parse((await request(f.url + '/__proxy/status', { method: 'GET', body: null, headers: admin })).body);
  await waitFor(async () => (await status()).keepalive.last_ok === true);
  const data = await status();
  assert.equal(data.total_requests, 0);
  assert.equal(data.keepalive.last_status, 200);
  assert.equal(data.keepalive.url, undefined);
  assert.equal(hits, 0);
  const stopped = await request(path, { method: 'PUT', headers: admin, body: JSON.stringify({ url: '', interval_seconds: 5 }) });
  assert.equal(JSON.parse(stopped.body).status.running, false);
  f.relay.beginShutdown();
  assert.equal((await request(path, { method: 'PUT', headers: admin, body: JSON.stringify(settings) })).status, 503);
});

test('keepalive environment locks prevent changes and public status does not expose configured query secrets', async t => {
  const configured = 'http://127.0.0.1:1/health?token=keepalive-private-value';
  const f = await fixture(t, (_req, res) => res.end('target'), {
    adminToken: 'admin-secret', keepaliveUrl: configured, keepaliveEnvLocks: { url: true, interval: true },
  });
  const admin = { 'x-admin-token': 'admin-secret' };
  const response = await request(f.url + '/__proxy/keepalive', { method: 'GET', body: null, headers: admin });
  assert.equal(JSON.parse(response.body).url, configured);
  assert.equal(JSON.parse(response.body).locked.url, true);
  const changed = await request(f.url + '/__proxy/keepalive', {
    method: 'PUT', headers: admin, body: JSON.stringify({ url: '', interval_seconds: 60 }),
  });
  assert.equal(changed.status, 409);
  const status = await request(f.url + '/__proxy/status', { method: 'GET', body: null, headers: admin });
  assert.ok(!status.body.toString().includes('keepalive-private-value'));
  assert.equal((await request(f.url + '/__proxy/keepalive', { method: 'HEAD', body: null, headers: admin })).body.length, 0);
});

test('invalid and oversized keepalive settings are rejected without starting a background request', async t => {
  const f = await fixture(t, (_req, res) => res.end('target'), { adminToken: 'admin-secret' });
  const admin = { 'x-admin-token': 'admin-secret' };
  const path = f.url + '/__proxy/keepalive';
  for (const body of ['{broken', '[]', '{"url":"file:///etc/passwd","interval_seconds":60}', '{"url":"","interval_seconds":1}', '{"url":"","interval_seconds":60,"extra":true}']) {
    assert.equal((await request(path, { method: 'PUT', headers: admin, body })).status, 400);
  }
  assert.equal((await request(path, { method: 'PUT', headers: { ...admin, 'content-type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await request(path, { method: 'PUT', headers: admin, body: 'x'.repeat(9000) })).status, 413);
  assert.equal((await request(path, { method: 'DELETE', headers: admin, body: null })).status, 405);
  const current = JSON.parse((await request(path, { method: 'GET', headers: admin, body: null })).body);
  assert.equal(current.status.configured, false);
  assert.equal(current.status.attempts, 0);
});

test('whitespace-only numeric environment variables retain their documented defaults', () => {
  const config = loadConfig({ TARGET_URL: 'https://example.com', PORT: ' ', UPSTREAM_TIMEOUT_SECONDS: '  ', HEARTBEAT_INTERVAL_SECONDS: '\t', MAX_REQUEST_BYTES: ' ' });
  assert.equal(config.port, 10000);
  assert.equal(config.totalTimeoutMs, 1800000);
  assert.equal(config.heartbeatMs, 1000);
  assert.equal(config.maxRequestBytes, 33554432);
});

test('incomplete or invalid JSON cannot be returned as a completed upstream result', async t => {
  for (const raw of ['{"private_result":"unfinished', '{"items":[1,2', '{"ok":true}unexpected', '{"wrong":01}']) {
    await t.test(raw, async sub => {
      const f = await fixture(sub, (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write(raw);
        res.end();
      }, { firstHeartbeatMs: 500 });
      const result = await request(f.url + '/api');
      assert.equal(result.status, 502);
      assert.equal(JSON.parse(result.body).error.code, 'invalid_upstream_json');
      assert.ok(!result.body.toString().includes('private_result'));
      await waitFor(async () => (await readdir(f.directory)).length === 0);
    });
  }
});

test('shutdown cancellation includes an unfinished authenticated settings upload', async t => {
  let upload;
  t.after(() => upload?.destroy());
  const f = await fixture(t, (_req, res) => res.end(), { adminToken: 'admin-secret' });
  const pending = new Promise((resolve, reject) => {
    upload = http.request(f.url + '/__proxy/keepalive', { method: 'PUT', headers: { 'x-admin-token': 'admin-secret', 'content-type': 'application/json' } }, async res => {
      try { resolve({ status: res.statusCode, body: await collect(res) }); } catch (error) { reject(error); }
    });
    upload.on('error', reject);
    upload.write('{"url":');
  });
  await delay(40);
  f.relay.beginShutdown();
  f.relay.abortRequests();
  const result = await Promise.race([pending, delay(500).then(() => { throw new Error('Settings upload was not cancelled during shutdown'); })]);
  assert.equal(result.status, 503);
  assert.equal(JSON.parse(result.body).code, 'server_shutting_down');
});

test('stale conditional settings writes cannot replace a newer administrator update', async t => {
  const f = await fixture(t, (_req, res) => res.end(), { adminToken: 'admin-secret' });
  const headers = { 'x-admin-token': 'admin-secret' };
  const path = f.url + '/__proxy/keepalive';
  const initial = await request(path, { method: 'GET', body: null, headers });
  const expected_revision = JSON.parse(initial.body).revision;
  const first = await request(path, { method: 'PUT', headers, body: JSON.stringify({ url: '', interval_seconds: 90, expected_revision }) });
  assert.equal(first.status, 200);
  const second = await request(path, { method: 'PUT', headers, body: JSON.stringify({ url: '', interval_seconds: 120, expected_revision }) });
  assert.equal(second.status, 412);
  const current = await request(path, { method: 'GET', body: null, headers });
  assert.equal(JSON.parse(current.body).interval_seconds, 90);
});

test('SSE admission and cancellation remain active until the response actually finishes', async t => {
  let response;
  t.after(() => response?.destroy());
  const f = await fixture(t, (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: [DONE]\n\n'); }, { maxConcurrentRequests: 1, adminToken: 'admin-secret' });
  let ending;
  const finalizing = new Promise(resolve => { ending = resolve; });
  class DelayedResponse extends Writable {
    constructor() { super(); this.headersSent = false; this.statusCode = 200; }
    setHeader() { return this; }
    writeHead(status) { this.statusCode = status; this.headersSent = true; return this; }
    flushHeaders() {}
    _write(_chunk, _encoding, callback) { callback(); }
    _final(callback) { this.finishResponse = callback; ending(); }
  }
  response = new DelayedResponse();
  const incoming = new PassThrough();
  Object.assign(incoming, { url: '/stream', method: 'POST', headers: { 'content-type': 'application/json' }, complete: true });
  f.server.emit('request', incoming, response);
  incoming.end('{"stream":true}');
  await finalizing;
  try {
    const status = JSON.parse((await request(f.url + '/__proxy/status', { method: 'GET', body: null, headers: { 'x-admin-token': 'admin-secret' } })).body);
    assert.equal(status.resources.active_requests, 1);
    assert.equal(status.active.length, 1);
    assert.equal(response.writableFinished, false);
  } finally { response.finishResponse(); }
});

test('late malformed JSON becomes a parseable error after previously emitted heartbeats', async t => {
  const f = await fixture(t, async (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"answer":"partial');
    await delay(110);
    res.end();
  });
  const result = await request(f.url + '/api');
  assert.equal(result.status, 200);
  assert.match(result.body.toString(), /^\n\n/);
  assert.equal(JSON.parse(result.body).error.code, 'invalid_upstream_json');
  await waitFor(async () => (await readdir(f.directory)).length === 0);
});

test('JSON response nesting and UTF-8 are validated while explicit bypass stays opaque', async t => {
  const raw = Buffer.from('{"a":[[1]]}');
  const f = await fixture(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(req.url === '/utf8' ? Buffer.from([34, 0xff, 34]) : raw);
  }, { maxJsonDepth: 2, firstHeartbeatMs: 500 });
  assert.equal(JSON.parse((await request(f.url + '/deep')).body).error.code, 'json_nesting_limit');
  assert.equal(JSON.parse((await request(f.url + '/utf8')).body).error.code, 'invalid_upstream_json');
  const bypassed = await request(f.url + '/deep', { headers: { 'x-proxy-heartbeat': 'off' } });
  assert.deepEqual(bypassed.body, raw);
});

test('settings upload deadlines release their admission slot and close incomplete connections', async t => {
  let upload;
  t.after(() => upload?.destroy());
  const f = await fixture(t, (_req, res) => res.end(), { adminToken: 'admin-secret', adminRequestTimeoutMs: 70 });
  const result = await new Promise((resolve, reject) => {
    upload = http.request(f.url + '/__proxy/keepalive', { method: 'PUT', headers: { 'x-admin-token': 'admin-secret', 'content-type': 'application/json' } }, async res => {
      try { resolve({ status: res.statusCode, headers: res.headers, body: await collect(res) }); } catch (error) { reject(error); }
    });
    upload.on('error', reject);
    upload.write('{');
  });
  assert.equal(result.status, 408);
  assert.equal(JSON.parse(result.body).code, 'admin_request_timeout');
  assert.equal(result.headers.connection, 'close');
  const status = JSON.parse((await request(f.url + '/__proxy/status', { method: 'GET', body: null, headers: { 'x-admin-token': 'admin-secret' } })).body);
  assert.equal(status.diagnostics.active_settings_updates, 0);
});

test('settings uploads have an independent concurrency limit and cancel without holding idle waiters', async t => {
  const uploads = [];
  t.after(() => uploads.forEach(upload => upload.destroy()));
  const f = await fixture(t, (_req, res) => res.end(), { adminToken: 'admin-secret' });
  const admin = { 'x-admin-token': 'admin-secret' };
  for (let i = 0; i < 2; i++) {
    const upload = http.request(f.url + '/__proxy/keepalive', { method: 'PUT', headers: { ...admin, 'content-type': 'application/json' } });
    upload.on('error', () => {});
    upload.write('{');
    uploads.push(upload);
  }
  const status = async () => JSON.parse((await request(f.url + '/__proxy/status', { method: 'GET', body: null, headers: admin })).body);
  await waitFor(async () => (await status()).diagnostics.active_settings_updates === 2);
  const busy = await request(f.url + '/__proxy/keepalive', { method: 'PUT', headers: admin, body: '{"url":"","interval_seconds":60}' });
  assert.equal(busy.status, 429);
  assert.equal(busy.headers['retry-after'], '1');
  let idle = false;
  const settled = f.relay.whenIdle().then(() => { idle = true; });
  await delay(10);
  assert.equal(idle, false);
  uploads.forEach(upload => upload.destroy());
  await settled;
  assert.equal((await status()).diagnostics.active_settings_updates, 0);
  assert.equal((await request(f.url + '/__proxy/keepalive', { method: 'PUT', headers: admin, body: '{"url":"","interval_seconds":60}' })).status, 200);
});

test('SSE final write queues are destroyed on a stall or shutdown cancellation', async t => {
  for (const mode of ['stall', 'shutdown']) {
    await t.test(mode, async sub => {
      let response;
      sub.after(() => response?.destroy());
      const f = await fixture(sub, (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('data: [DONE]\n\n');
      }, { downstreamStallMs: mode === 'stall' ? 50 : 0 });
      class StalledResponse extends Writable {
        constructor() { super(); this.headersSent = false; this.statusCode = 200; }
        setHeader() { return this; }
        writeHead(status) { this.statusCode = status; this.headersSent = true; return this; }
        flushHeaders() {}
        _write() { /* Keep a small final write queued, below highWaterMark. */ }
      }
      response = new StalledResponse();
      const incoming = new PassThrough();
      Object.assign(incoming, { url: '/stream', method: 'POST', headers: { 'content-type': 'application/json' }, complete: true });
      f.server.emit('request', incoming, response);
      incoming.end('{"stream":true}');
      await waitFor(() => response.writableEnded);
      assert.equal(response.writableNeedDrain, false);
      assert.ok(response.writableLength > 0);
      if (mode === 'shutdown') f.relay.abortRequests();
      await f.relay.whenIdle();
      assert.equal(response.destroyed, true);
    });
  }
});

test('Accept q=0 does not turn a delayed JSON success into an incompatible SSE response', async t => {
  const f = await fixture(t, async (_req, res) => {
    await delay(90);
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
  });
  const result = await request(f.url + '/v1/chat/completions', { headers: { accept: 'application/json, text/event-stream;q=0' } });
  assert.match(result.headers['content-type'], /application\/json/);
  assert.deepEqual(JSON.parse(result.body), { ok: true });
});

test('heartbeat bypass skips request classification and keeps object-dense input byte exact', async t => {
  const raw = Buffer.from('{"items":[' + '{},'.repeat(100000) + '{}],"stream":true}');
  let received;
  const f = await fixture(t, async (req, res) => { received = await collect(req); res.end('opaque'); });
  const parse = JSON.parse;
  let largeParses = 0;
  JSON.parse = input => { if (typeof input === 'string' && input.length > 1000) largeParses++; return parse(input); };
  try {
    const result = await request(f.url + '/v1/chat/completions', { body: raw, headers: { 'x-proxy-heartbeat': 'off' } });
    assert.equal(result.body.toString(), 'opaque');
    assert.deepEqual(received, raw);
    assert.equal(largeParses, 0);
  } finally { JSON.parse = parse; }
});

test('after-headers mode preserves a delayed 429 and headers while heartbeating a partial JSON body', async t => {
  const f = await fixture(t, async (_req, res) => {
    await delay(80);
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '10', 'x-custom': 'preserved' });
    res.write('{"error":');
    await delay(100);
    res.end('"limited"}');
  }, { heartbeatMode: 'after-headers' });
  const result = await request(f.url + '/v1/chat/completions');
  assert.equal(result.status, 429);
  assert.equal(result.headers['retry-after'], '10');
  assert.equal(result.headers['x-custom'], 'preserved');
  assert.ok(result.times.length >= 2);
  assert.deepEqual(JSON.parse(result.body), { error: 'limited' });
});

test('a route can bypass heartbeat and JSON validation without changing other routes', async t => {
  const f = await fixture(t, async (_req, res) => {
    await delay(80); res.writeHead(200, { 'content-type': 'application/json' }); res.end('nonstandard json');
  }, { heartbeatRoutes: [{ prefix: '/raw/', mode: 'off' }] });
  const raw = await request(f.url + '/raw/custom');
  assert.equal(raw.body.toString(), 'nonstandard json');
  const checked = await request(f.url + '/checked');
  assert.equal(JSON.parse(checked.body).error.code, 'invalid_upstream_json');
});

test('isolated management hosts serve no upstream content and management paths reject the API host', async t => {
  let hits = 0;
  const f = await fixture(t, (_req, res) => { hits++; res.end('upstream'); }, { adminHosts: ['admin.example'], adminToken: 'secret' });
  assert.equal((await request(f.url + '/__proxy/', { method: 'GET', body: null })).status, 403);
  assert.equal((await request(f.url + '/__proxy/status', { method: 'GET', body: null, headers: { host: 'admin.example', 'x-admin-token': 'secret' } })).status, 200);
  assert.equal((await request(f.url + '/sw.js', { method: 'GET', body: null, headers: { host: 'admin.example' } })).status, 403);
  assert.equal((await request(f.url + '/', { method: 'GET', body: null, headers: { host: 'admin.example' } })).status, 403);
  for (const host of ['ADMIN.EXAMPLE:443', 'admin.example.', 'admin.example:8080']) {
    assert.equal((await request(f.url + '/sw.js', { method: 'GET', body: null, headers: { host } })).status, 403);
  }
  assert.equal(hits, 0);
  assert.equal((await request(f.url + '/page', { method: 'GET', body: null, headers: { accept: 'text/html' } })).body.toString(), 'upstream');
});

test('upstream service-worker script requests are blocked before contacting the target', async t => {
  let hits = 0;
  const f = await fixture(t, (_req, res) => { hits++; res.end('script'); });
  for (const headers of [{ 'service-worker': 'script' }, { 'sec-fetch-dest': 'serviceworker' }]) {
    const result = await request(f.url + '/sw.js', { method: 'GET', body: null, headers });
    assert.equal(result.status, 403);
    assert.equal(JSON.parse(result.body).error.code, 'service_worker_blocked');
  }
  assert.equal(hits, 0);
});

test('configured CORS survives early heartbeats and handles preflight without calling upstream', async t => {
  let hits = 0;
  const origin = 'https://client.example';
  const f = await fixture(t, async (_req, res) => {
    hits++; await delay(80); res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end('{"ok":true}');
  }, { corsOrigins: [origin], adminToken: 'secret' });
  const preflight = await request(f.url + '/v1/chat/completions', { method: 'OPTIONS', body: null, headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'Authorization, Content-Type, X-Proxy-Token' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers['access-control-allow-origin'], origin);
  assert.match(preflight.headers['access-control-allow-headers'], /authorization/);
  assert.equal(hits, 0);
  const result = await request(f.url + '/v1/chat/completions', { headers: { origin } });
  assert.equal(result.headers['access-control-allow-origin'], origin);
  assert.deepEqual(JSON.parse(result.body), { ok: true });
  const denied = await request(f.url + '/v1/chat/completions', { method: 'OPTIONS', body: null, headers: { origin: 'https://untrusted.example', 'access-control-request-method': 'POST' } });
  assert.equal(denied.status, 403);
  const admin = await request(f.url + '/__proxy/status', { method: 'GET', body: null, headers: { origin, 'x-admin-token': 'secret' } });
  assert.equal(admin.headers['access-control-allow-origin'], undefined);
});

test('local response write failures return 503 with a storage code and release capacity', async t => {
  const f = await fixture(t, (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); }, { firstHeartbeatMs: 500, adminToken: 'secret' }, silentLogger, {
    storageOperations: { createWriteStream() { return new Writable({ write(_chunk, _encoding, callback) { callback(Object.assign(new Error('private/path'), { code: 'ENOSPC' })); } }); } },
  });
  const result = await request(f.url + '/test');
  assert.equal(result.status, 503);
  assert.equal(result.headers['retry-after'], '1');
  assert.equal(JSON.parse(result.body).error.code, 'temporary_storage_unavailable');
  await f.relay.whenIdle();
  assert.deepEqual(await readdir(f.directory), []);
  const status = JSON.parse((await request(f.url + '/__proxy/status', { method: 'GET', body: null, headers: { 'x-admin-token': 'secret' } })).body);
  assert.equal(status.resources.buffered_response_bytes, 0);
  assert.equal(status.metrics.errors.temporary_storage_unavailable, 1);
});

test('diagnostic cursors send only new events and cumulative metrics remain available', async t => {
  const f = await fixture(t, (_req, res) => res.end('ok'), { adminToken: 'secret' });
  const status = async suffix => JSON.parse((await request(f.url + '/__proxy/status' + suffix, { method: 'GET', body: null, headers: { 'x-admin-token': 'secret' } })).body);
  await request(f.url + '/first', { headers: { 'x-proxy-heartbeat': 'off' } });
  const first = await status('');
  const suffix = `?since=${first.event_cursor}&stream=${first.event_stream_id}`;
  assert.deepEqual((await status(suffix)).events, []);
  await request(f.url + '/second', { headers: { 'x-proxy-heartbeat': 'off' } });
  const second = await status(suffix);
  assert.ok(second.events.length > 0);
  assert.ok(second.events.every(event => event.path === '/second'));
  assert.equal(second.metrics.outcomes.completed, 2);
  assert.ok(second.metrics.memory.heap_used_bytes > 0);
  assert.equal((await status(`?since=${first.event_cursor}&stream=old-process`)).events_reset, true);
  assert.equal((await request(f.url + '/__proxy/metrics', { method: 'GET', body: null })).status, 401);
});
