// Real-duration local verification. No external AI service, API keys or CF account.
import http from 'node:http';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { createProxy, loadConfig } from '../src/proxy.js';

const delaySeconds = Number(process.env.SMOKE_DELAY_SECONDS || 135);
const verbose = process.env.SMOKE_VERBOSE === '1';
if (!Number.isFinite(delaySeconds) || delaySeconds < 1) throw new Error('Invalid SMOKE_DELAY_SECONDS');
const expected = JSON.stringify({ model: 'custom-model', response: 'slow response completed', delay_seconds: delaySeconds });
const timers = new Set();
const origin = http.createServer((req, res) => {
  req.resume();
  const timer = setTimeout(() => {
    timers.delete(timer);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(expected);
  }, delaySeconds * 1000);
  timers.add(timer);
  res.once('close', () => { clearTimeout(timer); timers.delete(timer); });
});
origin.listen(0, '127.0.0.1');
await once(origin, 'listening');
const relay = createProxy(loadConfig({ TARGET_URL: `http://127.0.0.1:${origin.address().port}` }));
relay.server.listen(0, '127.0.0.1');
await once(relay.server, 'listening');
const started = performance.now();
const times = [];

try {
  const result = await new Promise((resolve, reject) => {
    const outgoing = http.request({
      hostname: '127.0.0.1', port: relay.server.address().port, path: '/arbitrary/ai/path?test=1',
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer test-only' },
    }, response => {
      const chunks = [];
      response.on('data', chunk => {
        chunks.push(chunk);
        const elapsed = performance.now() - started;
        times.push(elapsed);
        if (verbose) console.log(JSON.stringify({ elapsed_seconds: +(elapsed / 1000).toFixed(2), received_bytes: chunk.length }));
      });
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    // A real read-idle deadline shorter than the overall upstream wait.
    outgoing.setTimeout(3_000, () => outgoing.destroy(new Error('3-second read-idle timeout')));
    outgoing.on('error', reject);
    outgoing.end('{ "model": "custom-model", "stream": false }');
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.trimStart(), expected);
  assert.deepEqual(JSON.parse(result.body), JSON.parse(expected));
  assert.ok(times[0] < 5000);
  const gaps = times.map((time, index) => time - (index ? times[index - 1] : 0));
  assert.ok(Math.max(...gaps) < 3_000);
  console.log(JSON.stringify({
    verified: true,
    duration_seconds: +((performance.now() - started) / 1000).toFixed(2),
    first_byte_ms: Math.round(times[0]),
    max_gap_ms: Math.round(Math.max(...gaps)),
    received_chunks: times.length,
    json_body_unchanged: true,
  }));
} finally {
  for (const timer of timers) clearTimeout(timer);
  relay.server.closeAllConnections();
  relay.destroyAgents();
  await new Promise(resolve => relay.server.close(resolve));
  origin.closeAllConnections();
  await new Promise(resolve => origin.close(resolve));
}
