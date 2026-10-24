import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createKeepalive } from '../src/keepalive.js';
import { loadConfig } from '../src/proxy.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check) {
  const deadline = performance.now() + 2000;
  while (performance.now() < deadline) {
    if (check()) return;
    await delay(10);
  }
  assert.fail('Keepalive state did not settle');
}

async function origin(t, handler) {
  const server = http.createServer(handler);
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

function service(t, url, overrides = {}) {
  const entries = [];
  const logger = Object.fromEntries(['info', 'warn', 'error'].map(level => [level, text => entries.push(JSON.parse(text))]));
  const config = {
    ...loadConfig({ TARGET_URL: 'https://upstream.example', ADMIN_TOKEN: 'admin-secret', PROXY_TOKEN: 'proxy-secret' }),
    keepaliveUrl: url, keepaliveIntervalMs: 40, keepaliveTimeoutMs: 500,
    ...overrides,
  };
  const keepalive = createKeepalive(config, { logger });
  t.after(() => keepalive.stop());
  return { keepalive, entries };
}

test('keepalive is opt-in and configuration errors never echo URL credentials', async t => {
  const config = loadConfig({ TARGET_URL: 'http://localhost' });
  assert.equal(config.keepaliveUrl, '');
  assert.equal(config.keepaliveIntervalMs, 60000);
  assert.equal(config.keepaliveTimeoutMs, 30000);
  assert.deepEqual(config.keepaliveEnvLocks, { url: false, interval: false });
  for (const value of ['ftp://host', 'http://user:URL_SECRET@host', 'http://host/#fragment', 'http://host/\r\nx: y']) {
    assert.throws(() => loadConfig({ TARGET_URL: 'http://localhost', KEEPALIVE_URL: value }), error => {
      assert.match(error.message, /KEEPALIVE_URL/);
      assert.ok(!error.message.includes('URL_SECRET'));
      return true;
    });
  }
  for (const [key, value] of [['KEEPALIVE_INTERVAL', '4'], ['KEEPALIVE_INTERVAL', '86401'], ['KEEPALIVE_TIMEOUT_SECONDS', '0']]) {
    assert.throws(() => loadConfig({ TARGET_URL: 'http://localhost', [key]: value }), new RegExp(key));
  }
  const f = service(t, '');
  f.keepalive.start();
  await delay(60);
  assert.equal(f.keepalive.status().running, false);
  assert.equal(f.keepalive.status().attempts, 0);
  assert.deepEqual(f.entries, []);
});

test('keepalive sends periodic GETs without forwarding relay credentials or logging its URL', async t => {
  const seen = [];
  const url = await origin(t, (req, res) => {
    seen.push({ method: req.method, path: req.url, headers: req.headers });
    req.resume(); res.end();
  });
  const f = service(t, url + '/health?token=PRIVATE_QUERY');
  f.keepalive.start();
  f.keepalive.start();
  await waitFor(() => seen.length >= 2 && f.entries.filter(entry => entry.event === 'keepalive_result').length >= 2);
  f.keepalive.stop();
  assert.ok(seen.length >= 2);
  for (const request of seen) {
    assert.equal(request.method, 'GET');
    assert.equal(request.path, '/health?token=PRIVATE_QUERY');
    for (const key of ['authorization', 'cookie', 'x-admin-token', 'x-proxy-token']) assert.equal(request.headers[key], undefined);
    assert.match(request.headers['cache-control'], /no-cache/);
  }
  assert.equal(f.keepalive.status().last_status, 200);
  assert.ok(!JSON.stringify([f.entries, f.keepalive.status()]).includes('PRIVATE_QUERY'));
  assert.equal(f.keepalive.settings().url, url + '/health?token=PRIVATE_QUERY');
  const count = seen.length;
  await delay(80);
  assert.equal(seen.length, count);
});

test('slow probes do not overlap and failed HTTP statuses recover on the next interval', async t => {
  let active = 0, maximum = 0, hits = 0;
  const url = await origin(t, (req, res) => {
    req.resume();
    const hit = ++hits;
    maximum = Math.max(maximum, ++active);
    const timer = setTimeout(() => { res.writeHead(hit === 1 ? 503 : 200); res.end(); }, 70);
    res.once('close', () => { active--; clearTimeout(timer); });
  });
  const f = service(t, url);
  f.keepalive.start();
  await waitFor(() => f.keepalive.status().attempts >= 2 && f.keepalive.status().last_ok);
  f.keepalive.stop();
  assert.equal(maximum, 1);
  assert.equal(f.keepalive.status().consecutive_failures, 0);
  assert.ok(f.entries.some(entry => entry.event === 'keepalive_result' && entry.last_status === 503 && entry.last_ok === false));
});

test('the total probe deadline closes silent connections and stop cancels the next timer', async t => {
  let closed = false;
  const url = await origin(t, (req, res) => { req.resume(); res.once('close', () => { closed = true; }); });
  const f = service(t, url, { keepaliveTimeoutMs: 40 });
  f.keepalive.start();
  await waitFor(() => f.keepalive.status().last_error_code === 'keepalive_timeout');
  f.keepalive.stop();
  await waitFor(() => closed);
  assert.equal(f.keepalive.status().last_ok, false);
  const attempts = f.keepalive.status().attempts;
  await delay(80);
  assert.equal(f.keepalive.status().attempts, attempts);
});

test('keepalive needs only headers and does not download an unfinished response body', async t => {
  let closed = false;
  const url = await origin(t, (req, res) => {
    req.resume(); res.writeHead(200); res.write('an indefinitely unfinished body');
    res.once('close', () => { closed = true; });
  });
  const f = service(t, url);
  f.keepalive.start();
  await waitFor(() => closed && f.keepalive.status().last_ok);
  f.keepalive.stop();
});

test('redirects are reported without calling the redirected endpoint', async t => {
  let redirected = 0;
  const url = await origin(t, (req, res) => {
    req.resume();
    if (req.url === '/private') { redirected++; res.end(); }
    else { res.writeHead(302, { location: '/private' }); res.end(); }
  });
  const f = service(t, url + '/redirect');
  f.keepalive.start();
  await waitFor(() => f.keepalive.status().last_status === 302);
  f.keepalive.stop();
  assert.equal(redirected, 0);
  assert.equal(f.keepalive.status().last_error_code, 'keepalive_http_error');
});

test('live settings updates cancel old probes and never overwrite a newer result', async t => {
  let oldClosed = false, oldSeen = false, newHits = 0;
  const oldUrl = await origin(t, (req, res) => { oldSeen = true; req.resume(); res.once('close', () => { oldClosed = true; }); });
  const newUrl = await origin(t, (req, res) => { newHits++; req.resume(); res.end(); });
  const f = service(t, oldUrl);
  f.keepalive.start();
  await waitFor(() => oldSeen);
  f.keepalive.update({ url: newUrl, interval_seconds: 5 });
  await waitFor(() => newHits === 1 && f.keepalive.status().last_ok);
  await waitFor(() => oldClosed);
  assert.equal(f.keepalive.status().attempts, 1);
  assert.equal(f.keepalive.status().last_error_code, null);
  f.keepalive.update({ url: '', interval_seconds: 5 });
  assert.equal(f.keepalive.status().running, false);
  assert.equal(f.keepalive.status().configured, false);
});

test('non-empty environment variables lock their settings while invalid updates preserve the current state', t => {
  const f = service(t, 'https://example.com/keepalive', { keepaliveIntervalMs: 60000, keepaliveEnvLocks: { url: true, interval: true } });
  for (const value of [
    { url: 'https://other.example/keepalive', interval_seconds: 60 },
    { url: 'https://example.com/keepalive', interval_seconds: 90 },
  ]) assert.throws(() => f.keepalive.update(value), { code: 'keepalive_environment_locked' });
  assert.throws(() => f.keepalive.update({ url: 'file:///etc/passwd', interval_seconds: 60 }), { code: 'invalid_keepalive_url' });
  assert.equal(f.keepalive.settings().url, 'https://example.com/keepalive');
});

test('saving unchanged keepalive settings preserves the schedule and existing statistics', async t => {
  let hits = 0;
  const url = await origin(t, (req, res) => { hits++; req.resume(); res.end(); });
  const f = service(t, url, { keepaliveIntervalMs: 5000 });
  f.keepalive.start();
  await waitFor(() => f.keepalive.status().last_ok === true);
  const before = f.keepalive.status();
  f.keepalive.update({ url, interval_seconds: 5 });
  assert.equal(f.keepalive.status().attempts, before.attempts);
  assert.equal(f.keepalive.status().last_attempt_at, before.last_attempt_at);
  await delay(80);
  assert.equal(hits, 1, 'Saving the same configuration must not trigger another immediate GET');
});

test('configuration revisions survive no-op saves and differ across changes and process instances', t => {
  const f = service(t, '');
  const initial = f.keepalive.settings().revision;
  f.keepalive.update({ url: '', interval_seconds: 5 });
  const revision = f.keepalive.settings().revision;
  assert.notEqual(initial, revision);
  assert.equal(f.keepalive.update({ url: '', interval_seconds: 5, expected_revision: revision }).revision, revision);
  assert.throws(() => f.keepalive.update({ url: '', interval_seconds: 10, expected_revision: initial }), { status: 412 });
  assert.throws(() => f.keepalive.update({ url: '', interval_seconds: 10, expected_revision: null }), { status: 400 });
  assert.notEqual(service(t, '').keepalive.settings().revision, initial);
});

test('a protocol upgrade is closed and classified immediately instead of waiting for a timeout', async t => {
  const url = await origin(t, (req, res) => {
    req.resume();
    res.writeHead(101, { connection: 'Upgrade', upgrade: 'websocket' });
    res.end();
  });
  const f = service(t, url);
  f.keepalive.start();
  await waitFor(() => f.keepalive.status().last_error_code !== null);
  f.keepalive.stop();
  assert.equal(f.keepalive.status().last_error_code, 'keepalive_unsupported_upgrade');
  assert.equal(f.keepalive.status().last_status, 101);
});
