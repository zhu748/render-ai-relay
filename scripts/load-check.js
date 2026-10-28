// Real local HTTP admission, backpressure and resource-release check.
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { createProxy, loadConfig } from '../src/proxy.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const payload = Buffer.from('{"prompt":"' + 'x'.repeat(1024 * 1024) + '","stream":false}');
const origin = http.createServer(async (req, res) => {
  let bytes = 0; for await (const chunk of req) bytes += chunk.length;
  await pause(1000);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ path: req.url, bytes }));
});
origin.listen(0, '127.0.0.1'); await once(origin, 'listening');
const directory = await mkdtemp(join(tmpdir(), 'relay-load-'));
const config = { ...loadConfig({ TARGET_URL: `http://127.0.0.1:${origin.address().port}`, ADMIN_TOKEN: 'load-test-only' }), tempDirectory: directory, firstHeartbeatMs: 50, heartbeatMs: 50 };
const relay = createProxy(config, { logger: { info() {}, warn() {}, error() {} } });
relay.server.listen(0, '127.0.0.1'); await once(relay.server, 'listening');
function call(path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: relay.server.address().port, path, method: body ? 'POST' : 'GET', agent: false, headers: { 'content-type': 'application/json', 'x-admin-token': 'load-test-only' } }, async res => {
      try { const chunks = []; for await (const chunk of res) chunks.push(chunk); resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); }
      catch (error) { reject(error); }
    });
    req.setTimeout(10000, () => req.destroy(new Error('Load-check client timeout')));
    req.on('error', reject); req.end(body);
  });
}
const began = performance.now();
try {
  const completion = Promise.allSettled(Array.from({ length: 32 }, (_, index) => call('/load/' + index, payload)));
  let active = 0;
  for (let i = 0; i < 200; i++) {
    const { body } = await call('/__proxy/status');
    active = body.resources.active_requests;
    if (active === 32) break;
    await pause(5);
  }
  assert.equal(active, 32);
  const rejected = await call('/excess');
  assert.equal(rejected.status, 503);
  assert.equal(rejected.body.error.code, 'relay_busy');
  const healthBegan = performance.now();
  assert.equal((await call('/__proxy_health')).status, 200);
  const healthMs = Math.round(performance.now() - healthBegan);
  const settled = await completion;
  const results = settled.map(result => { if (result.status === 'rejected') throw result.reason; return result.value; });
  for (let i = 0; i < results.length; i++) {
    assert.equal(results[i].status, 200);
    assert.deepEqual(results[i].body, { path: '/load/' + i, bytes: payload.length });
  }
  await relay.whenIdle();
  const final = (await call('/__proxy/status')).body;
  for (const name of ['active_requests', 'buffered_request_bytes', 'buffered_response_bytes', 'buffered_sse_bytes']) assert.equal(final.resources[name], 0);
  console.log(JSON.stringify({ verified: true, concurrency: 32, body_bytes_each: payload.length, health_check_ms: healthMs, excess_request_status: rejected.status, resource_counters_after_completion: 'all zero', duration_ms: Math.round(performance.now() - began) }));
} finally {
  relay.server.closeAllConnections(); await relay.destroyAgents(); await new Promise(resolve => relay.server.close(resolve));
  origin.closeAllConnections(); await new Promise(resolve => origin.close(resolve)); await rm(directory, { recursive: true, force: true });
}
