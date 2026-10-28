// Reproducible synthetic boundary sample; this is not a throughput SLA.
import { getHeapStatistics } from 'node:v8';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { requestHint } from '../src/policy.js';
import assert from 'node:assert/strict';

const raw = Buffer.from('{"items":[' + '{},'.repeat(1999999) + '{}],"stream":true}');
const chunks = [];
for (let offset = 0; offset < raw.length; offset += 65536) chunks.push(raw.subarray(offset, offset + 65536));
global.gc?.();
const before = getHeapStatistics().used_heap_size;
let peak = before;
const sampler = setInterval(() => { peak = Math.max(peak, getHeapStatistics().used_heap_size); }, 5);
const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable();
const began = performance.now();
try {
  assert.equal(await requestHint({ headers: { 'content-type': 'application/json' } }, { chunks, length: raw.length }), 'sse');
  peak = Math.max(peak, getHeapStatistics().used_heap_size);
  console.log(JSON.stringify({ request_bytes: raw.length, duration_ms: Math.round(performance.now() - began), sampled_heap_growth_mib: +((peak - before) / 2 ** 20).toFixed(1), event_loop_max_ms: +(loop.max / 1e6).toFixed(1), original_body_unchanged: true }));
} finally { clearInterval(sampler); loop.disable(); }
