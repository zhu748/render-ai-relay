import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createProxy, loadConfig } from '../src/proxy.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const silentLogger = { error() {}, warn() {} };

async function fixture(t, handle, overrides = {}, logger = silentLogger) {
  const origin = http.createServer((req, res) => {
    Promise.resolve(handle(req, res)).catch(error => res.destroy(error));
  });
  origin.listen(0, '127.0.0.1');
  await once(origin, 'listening');
  const directory = await mkdtemp(join(tmpdir(), 'relay-test-'));
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
  const relay = createProxy(config, { logger });
  relay.server.listen(0, '127.0.0.1');
  await once(relay.server, 'listening');
  t.after(async () => {
    relay.server.closeAllConnections();
    relay.destroyAgents();
    await new Promise(resolve => relay.server.close(resolve));
    origin.closeAllConnections();
    await new Promise(resolve => origin.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return { url: `http://127.0.0.1:${relay.server.address().port}`, originUrl: `http://127.0.0.1:${origin.address().port}`, config, directory };
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
});

test('defaults use one-second heartbeats and bounded request resources', () => {
  const config = loadConfig({ TARGET_URL: 'https://custom.example' });
  assert.equal(config.heartbeatMs, 1000);
  assert.equal(config.firstHeartbeatMs, 1000);
  assert.equal(config.maxConcurrentRequests, 32);
  assert.equal(config.maxBufferedRequestBytes, 64 * 1024 * 1024);
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
    await delay(137);
    res.write('data: {"n":2}\n\n');
    await delay(223);
    res.end('data: [DONE]\n\n');
  }, { heartbeatMs: 100, firstHeartbeatMs: 20 });
  const result = await request(f.url + '/stream', { body: '{"stream":true}' });
  const gaps = result.times.slice(1).map((time, i) => time - result.times[i]);
  assert.ok(Math.max(...gaps) < 150, `unexpected heartbeat gap: ${Math.max(...gaps)}ms`);
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
  assert.equal(health.version, '1.2.0');
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
