import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../src/admin.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../src/admin.html', import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));

// Exercise the shipped script's connection lifecycle without a browser or a
// third-party DOM dependency. Network completion and timeout are controlled.
function page({ keepalive = { url: '', interval_seconds: 60, locked: { url: false, interval: false }, status: { configured: false, running: false, interval_seconds: 60, attempts: 0 } } } = {}) {
  function element() {
    return {
      value: '', disabled: false, children: [], textContent: '', listeners: new Map(),
      addEventListener(name, listener) { this.listeners.set(name, listener); },
      click() { if (!this.disabled) this.listeners.get('click')?.({}); },
      replaceChildren(...children) { this.children = children; this.value = ''; },
      append(...children) { this.children.push(...children); },
      insertRow() { const row = element(); this.append(row); return row; },
      insertCell() { const cell = element(); this.append(cell); return cell; },
      set innerHTML(_value) { throw new Error('Untrusted values must be rendered as text'); },
    };
  }
  const controls = new Map([...html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)].map(([tag, id]) => {
    const control = element();
    control.disabled = /\bdisabled\b/.test(tag);
    return [id, control];
  }));
  const calls = [];
  const timers = new Set();
  const deadlines = [];
  const documentListeners = new Map();
  const document = { hidden: false, getElementById: id => controls.get(id), createElement: element, createTextNode: text => ({ textContent: text }), addEventListener(name, listener) { documentListeners.set(name, listener); } };
  const fetch = (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    const call = {
      url, options, reject,
      json(data, status = 200) { resolve({ ok: status < 400, status, json: async () => data }); },
      stream(payload) {
        let sent = false;
        resolve({ ok: true, body: { getReader: () => ({ read: () => new Promise((resolveRead, fail) => {
          if (payload !== undefined) {
            const result = sent ? { done: true } : { done: false, value: Buffer.from(payload) };
            sent = true;
            resolveRead(result);
            return;
          }
          if (options.signal.aborted) fail(options.signal.reason);
          else options.signal.addEventListener('abort', () => fail(options.signal.reason), { once: true });
        }) }) } });
      },
    };
    calls.push(call);
    if (url === '/__proxy/keepalive' && options.method === 'GET') call.json(keepalive);
  });
  runInNewContext(source, {
    document,
    fetch, AbortController, TextDecoder, performance, location: { origin: 'https://relay.example' },
    AbortSignal: {
      any: signals => AbortSignal.any(signals),
      timeout(ms) { const controller = new AbortController(); deadlines.push({ ms, controller }); return controller.signal; },
    },
    setTimeout(callback, ms) { const timer = { callback, ms }; timers.add(timer); return timer; },
    clearTimeout(timer) { timers.delete(timer); },
  });
  return { get: id => controls.get(id), calls, timers, deadlines, document, documentListeners };
}

const emptyStatus = {
  version: 'test', active: [], events: [], total_requests: 0, uptime_seconds: 0,
  heartbeat_interval_ms: 1000, first_heartbeat_ms: 1000, target_origin: 'https://example.com',
  resources: { buffered_request_bytes: 0, max_buffered_request_bytes: 67108864, buffered_response_bytes: 0, max_buffered_response_bytes: 536870912, buffered_sse_bytes: 0, max_buffered_sse_bytes: 67108864 },
};

test('the admin can cancel its first connection before the status request finishes', async () => {
  const p = page();
  p.get('token').value = 'first-secret';
  p.get('connect').click();
  assert.equal(p.calls.length, 1);
  assert.equal(p.get('token').value, '');
  assert.equal(p.get('disconnect').disabled, false);
  p.get('disconnect').click();
  await flush();
  assert.equal(p.calls[0].options.signal.aborted, true);
  assert.equal(p.get('status').textContent, '已断开。');
  assert.equal(p.timers.size, 0);
});

test('admin reconnection aborts the previous fetch and auth failures do not poll', async () => {
  const p = page();
  p.get('token').value = 'old-secret';
  p.get('connect').click();
  p.get('token').value = 'new-secret';
  p.get('connect').click();
  assert.equal(p.calls[0].options.signal.aborted, true);
  assert.equal(p.calls[1].options.headers['X-Admin-Token'], 'new-secret');
  p.calls[1].json({ error: 'Invalid management token' }, 401);
  await flush();
  assert.equal(p.get('status').textContent, 'Invalid management token');
  assert.equal(p.get('disconnect').disabled, false);
  assert.equal(p.get('probe-short').disabled, true);
  assert.equal(p.timers.size, 0);
});

test('disconnect cancels a streaming probe and prevents stale results from replacing its status', async () => {
  const p = page();
  p.get('token').value = 'secret';
  p.get('connect').click();
  p.calls[0].json(emptyStatus);
  await flush();
  assert.equal(p.get('summary').children.length, 8);
  p.get('probe-short').click();
  const probe = p.calls.at(-1);
  probe.stream();
  await flush();
  p.get('disconnect').click();
  await flush();
  assert.equal(probe.options.signal.aborted, true);
  assert.equal(p.get('probe-result').textContent, '已断开，心跳测试已停止。');
  assert.equal(p.get('probe-stop').disabled, true);
  assert.equal(p.get('probe-short').disabled, true);
  assert.equal(p.get('summary').hidden, true);
  assert.equal(p.timers.size, 0);
});

test('a stalled heartbeat probe has a deadline and can be retried after timeout', async () => {
  const p = page();
  p.get('token').value = 'secret';
  p.get('connect').click();
  p.calls[0].json(emptyStatus);
  await flush();
  p.get('probe-short').click();
  assert.equal(p.deadlines.at(-1).ms, 25000);
  p.calls.at(-1).stream();
  await flush();
  p.deadlines.at(-1).controller.abort(new DOMException('Timed out', 'TimeoutError'));
  await flush();
  assert.match(p.get('probe-result').textContent, /测试超时/);
  assert.equal(p.get('probe-short').disabled, false);
  assert.equal(p.get('probe-stop').disabled, true);
});

test('admin draining state is visible and prevents new probes', async () => {
  const p = page();
  p.get('token').value = 'secret';
  p.get('connect').click();
  p.calls[0].json({ ...emptyStatus, resources: { ...emptyStatus.resources, draining: true } });
  await flush();
  assert.match(p.get('status').textContent, /正在退出/);
  assert.equal(p.get('probe-short').disabled, true);
  assert.equal(p.get('disconnect').disabled, false);
});

test('a shutdown error returned by a probe shows its actual reason', async () => {
  const p = page();
  p.get('token').value = 'secret';
  p.get('connect').click();
  p.calls[0].json(emptyStatus);
  await flush();
  p.get('probe-short').click();
  p.calls.at(-1).stream(JSON.stringify({ error: { message: 'Relay is shutting down', code: 'server_shutting_down' } }));
  await flush();
  assert.match(p.get('probe-result').textContent, /Relay is shutting down/);
});

test('admin can fill its public keepalive address and save runtime settings with its token', async () => {
  const p = page();
  p.get('token').value = 'admin-secret';
  p.get('connect').click();
  p.calls[0].json(emptyStatus);
  await flush();
  p.get('keepalive-current').click();
  assert.equal(p.get('keepalive-url').value, 'https://relay.example/keepalive');
  p.get('keepalive-interval').value = '90';
  p.get('keepalive-save').click();
  const save = p.calls.at(-1);
  assert.equal(save.options.method, 'PUT');
  assert.equal(save.options.headers['X-Admin-Token'], 'admin-secret');
  assert.deepEqual(JSON.parse(save.options.body), { url: 'https://relay.example/keepalive', interval_seconds: 90 });
  save.json({ url: 'https://relay.example/keepalive', interval_seconds: 90, locked: { url: false, interval: false }, status: { configured: true, running: true, interval_seconds: 90, attempts: 0 } });
  await flush();
  assert.match(p.get('keepalive-config-status').textContent, /已保存/);
  assert.match(p.get('keepalive-result').textContent, /运行中/);
});

test('admin marks environment-managed keepalive fields read-only', async () => {
  const p = page({ keepalive: { url: 'https://managed.example/keepalive', interval_seconds: 60, locked: { url: true, interval: true }, status: { configured: true, running: true, interval_seconds: 60, attempts: 0 } } });
  p.get('token').value = 'secret';
  p.get('connect').click();
  p.calls[0].json(emptyStatus);
  await flush();
  assert.equal(p.get('keepalive-url').readOnly, true);
  assert.equal(p.get('keepalive-interval').readOnly, true);
  assert.equal(p.get('keepalive-current').disabled, true);
  assert.equal(p.get('keepalive-save').disabled, true);
  assert.match(p.get('keepalive-config-status').textContent, /KEEPALIVE_URL/);
});

test('disconnect clears configured URLs and cancels a pending settings save', async () => {
  const p = page({ keepalive: { url: 'https://example.com/health?token=private-value', interval_seconds: 60, locked: { url: false, interval: false }, status: { configured: true, running: true, interval_seconds: 60, attempts: 0 } } });
  p.get('token').value = 'secret';
  p.get('connect').click();
  p.calls[0].json(emptyStatus);
  await flush();
  p.get('keepalive-save').click();
  const pending = p.calls.at(-1);
  p.get('disconnect').click();
  await flush();
  assert.equal(pending.options.signal.aborted, true);
  assert.equal(p.get('keepalive-url').value, '');
  assert.equal(p.get('keepalive-save').disabled, true);
});

test('conditional admin saves preserve unsaved edits on conflict and offer an explicit reload', async () => {
  const stored = { url: '', interval_seconds: 60, revision: 'initial-revision', locked: { url: false, interval: false }, status: { configured: false, running: false, interval_seconds: 60, attempts: 0 } };
  const p = page({ keepalive: stored });
  p.get('token').value = 'secret';
  p.get('connect').click();
  p.calls[0].json(emptyStatus);
  await flush();
  p.get('keepalive-interval').value = '90';
  p.get('keepalive-save').click();
  const save = p.calls.at(-1);
  assert.equal(JSON.parse(save.options.body).expected_revision, 'initial-revision');
  save.json({ error: 'Settings changed' }, 412);
  await flush();
  assert.equal(p.get('keepalive-interval').value, '90');
  assert.match(p.get('keepalive-config-status').textContent, /重新读取配置/);
  stored.interval_seconds = 120;
  stored.revision = 'new-revision';
  p.get('keepalive-reload').click();
  await flush();
  assert.equal(p.get('keepalive-interval').value, '120');
  p.get('keepalive-save').click();
  assert.equal(JSON.parse(p.calls.at(-1).options.body).expected_revision, 'new-revision');
  p.get('disconnect').click();
  await flush();
});

test('incremental event polling preserves older records and resets cleanly across instances', async () => {
  const p = page();
  const event = id => ({ request_id: id, method: 'POST', path: '/' + id, phase: 'done', elapsed_ms: 1, heartbeats: 0, event: 'request_finished', time: new Date().toISOString() });
  p.get('token').value = 'secret'; p.get('connect').click();
  p.calls[0].json({ ...emptyStatus, event_stream_id: 'one', event_cursor: 1, events_reset: true, events: [event('first')] });
  await flush();
  let poll = [...p.timers].at(-1); p.timers.delete(poll); poll.callback();
  assert.equal(p.calls.at(-1).url, '/__proxy/status?since=1&stream=one');
  p.calls.at(-1).json({ ...emptyStatus, event_stream_id: 'one', event_cursor: 2, events_reset: false, events: [event('second')] });
  await flush();
  assert.equal(p.get('events').children.length, 2);
  poll = [...p.timers].at(-1); p.timers.delete(poll); poll.callback();
  p.calls.at(-1).json({ ...emptyStatus, event_stream_id: 'two', event_cursor: 1, events_reset: true, events: [event('third')] });
  await flush();
  assert.equal(p.get('events').children.length, 1);
  assert.equal(p.get('events').children[0].children[1].textContent, 'third');
  p.get('disconnect').click();
  p.get('token').value = 'secret'; p.get('connect').click();
  assert.equal(p.calls.at(-1).url, '/__proxy/status');
});

test('hidden pages poll less often and visibility changes do not retry rejected credentials', async () => {
  const p = page();
  p.document.hidden = true;
  p.get('token').value = 'secret'; p.get('connect').click();
  p.calls[0].json(emptyStatus);
  await flush();
  assert.equal([...p.timers].at(-1).ms, 30000);
  p.document.hidden = false;
  p.documentListeners.get('visibilitychange')();
  const last = p.calls.at(-1);
  last.json({ error: 'invalid token' }, 401);
  await flush();
  const count = p.calls.length;
  p.documentListeners.get('visibilitychange')();
  assert.equal(p.calls.length, count);
  assert.equal(p.timers.size, 0);
});
