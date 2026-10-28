import { monitorEventLoopDelay } from 'node:perf_hooks';
import { getHeapStatistics } from 'node:v8';

const bounds = [100, 500, 1000, 5000, 30000, 120000, 600000, 1800000];

export function createMetrics() {
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  const outcomes = {}, statuses = {}, errors = {}, phases = {};
  const latency = { count: 0, sum_ms: 0, max_ms: 0, buckets: Object.fromEntries([...bounds, 'inf'].map(bound => [bound, 0])) };
  const increment = (object, key) => { object[key] = (object[key] || 0) + 1; };
  return {
    observe(record, outcome, errorCode) {
      increment(outcomes, outcome);
      if (Number.isInteger(record.upstream_status)) increment(statuses, record.upstream_status);
      if (errorCode) increment(errors, Object.hasOwn(errors, errorCode) || Object.keys(errors).length < 64 ? errorCode : 'other');
      latency.count++; latency.sum_ms += record.elapsed_ms; latency.max_ms = Math.max(latency.max_ms, record.elapsed_ms);
      for (const bound of bounds) if (record.elapsed_ms <= bound) latency.buckets[bound]++;
      latency.buckets.inf++;
      for (const [name, value] of Object.entries(record.timings_ms || {})) {
        if (value === null) continue;
        phases[name] ||= { count: 0, sum_ms: 0, max_ms: 0 };
        phases[name].count++; phases[name].sum_ms += value; phases[name].max_ms = Math.max(phases[name].max_ms, value);
      }
    },
    snapshot() {
      let memory;
      try {
        const value = process.memoryUsage();
        memory = { rss_bytes: value.rss, heap_used_bytes: value.heapUsed, heap_total_bytes: value.heapTotal, external_bytes: value.external, array_buffers_bytes: value.arrayBuffers };
      } catch {
        // Some restricted runtimes cannot read RSS. Heap metrics remain useful.
        const value = getHeapStatistics();
        memory = { rss_bytes: null, heap_used_bytes: value.used_heap_size, heap_total_bytes: value.total_heap_size, external_bytes: value.external_memory, array_buffers_bytes: null };
      }
      return {
        memory,
        event_loop: { mean_ms: Number.isFinite(loop.mean) ? loop.mean / 1e6 : 0, p99_ms: loop.percentile(99) / 1e6, max_ms: loop.max / 1e6 },
        outcomes: { ...outcomes }, upstream_statuses: { ...statuses }, errors: { ...errors },
        latency: { ...latency, buckets: { ...latency.buckets } },
        phases: Object.fromEntries(Object.entries(phases).map(([key, value]) => [key, { ...value }])),
      };
    },
    stop() { loop.disable(); },
  };
}
