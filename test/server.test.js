import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VERSION } from '../src/diagnostics.js';

function processFixture(t, env) {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: new URL('../', import.meta.url),
    env: { ...process.env, PORT: '0', PROXY_TOKEN: '', KEEPALIVE_URL: '', KEEPALIVE_INTERVAL: '60', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 3000);
  t.after(() => {
    clearTimeout(watchdog);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  return { child, exited, events: [], stderr: () => stderr };
}

function listening(p) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    p.child.once('error', reject);
    p.child.stdout.on('data', chunk => {
      buffer += chunk;
      while (buffer.includes('\n')) {
        const end = buffer.indexOf('\n');
        const event = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        p.events.push(event);
        if (event.event === 'listening') resolve(event.port);
      }
    });
    p.exited.then(() => reject(new Error('Server exited before listening')));
  });
}

test('SIGTERM drains an active heartbeat response and exits without waiting for keep-alive', async t => {
  const origin = http.createServer((req, res) => {
    req.resume();
    const timer = setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    }, 150);
    res.once('close', () => clearTimeout(timer));
  });
  t.after(async () => {
    origin.closeAllConnections();
    await new Promise(resolve => origin.close(resolve));
  });
  origin.listen(0, '127.0.0.1');
  await once(origin, 'listening');
  const p = processFixture(t, {
    TARGET_URL: `http://127.0.0.1:${origin.address().port}`,
    HEARTBEAT_START_DELAY_SECONDS: '0.025',
  });
  const port = await listening(p);
  const health = await fetch(`http://127.0.0.1:${port}/__proxy_health`);
  assert.equal((await health.json()).version, VERSION);
  const response = await fetch(`http://127.0.0.1:${port}/api`, { method: 'POST', body: '{}' });
  p.child.kill('SIGTERM');
  assert.deepEqual(await response.json(), { ok: true });
  const [code, signal] = await p.exited;
  assert.equal(code, 0, `exit signal=${signal}; events=${p.events.map(e => e.event).join(',')}; stderr=${p.stderr()}`);
  assert.equal(signal, null);
  assert.ok(p.events.some(e => e.event === 'shutdown'));
});

test('invalid startup configuration fails fast without exposing credentials', async t => {
  const p = processFixture(t, { TARGET_URL: 'https://user:DO_NOT_LOG_THIS@localhost' });
  p.child.stdout.resume();
  const [code, signal] = await p.exited;
  assert.equal(code, 1);
  assert.equal(signal, null);
  assert.match(p.stderr(), /Configuration error/);
  assert.ok(!p.stderr().includes('DO_NOT_LOG_THIS'));
});

test('shutdown grace expiry sends a parseable failure and cleans up active JSON / SSE requests', async t => {
  for (const sse of [false, true]) {
    await t.test(sse ? 'SSE partial event' : 'JSON partial body', async sub => {
      const directory = await mkdtemp(join(tmpdir(), 'relay-shutdown-'));
      sub.after(() => rm(directory, { recursive: true, force: true }));
      let closed = false;
      const origin = http.createServer((req, res) => {
        req.resume();
        res.writeHead(200, { 'content-type': sse ? 'text/event-stream' : 'application/json' });
        res.write(sse ? 'data: {"partial":' : '{"partial":');
        res.once('close', () => { closed = true; });
      });
      sub.after(async () => {
        origin.closeAllConnections();
        await new Promise(resolve => origin.close(resolve));
      });
      origin.listen(0, '127.0.0.1');
      await once(origin, 'listening');
      const p = processFixture(sub, {
        TARGET_URL: `http://127.0.0.1:${origin.address().port}`,
        TEMP_DIRECTORY: directory,
        HEARTBEAT_START_DELAY_SECONDS: '0.01',
        SHUTDOWN_GRACE_SECONDS: '0.05',
      });
      const port = await listening(p);
      const response = await fetch(`http://127.0.0.1:${port}/api`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stream: sse }),
      });
      p.child.kill('SIGTERM');
      const body = (await response.text()).trimStart();
      const result = sse ? JSON.parse(body.split('\n')[1].slice(6)) : JSON.parse(body);
      assert.equal(result.error.code, 'server_shutting_down');
      assert.equal(result.error.status, 503);
      const [code, signal] = await p.exited;
      assert.equal(code, 0, p.stderr());
      assert.equal(signal, null);
      assert.ok(p.events.some(event => event.event === 'shutdown_grace_expired'));
      assert.equal(closed, true);
      assert.deepEqual(await readdir(directory), []);
    });
  }
});

test('environment-configured keepalive starts after listening and SIGTERM cancels a hanging probe', async t => {
  let seen;
  const requested = new Promise(resolve => { seen = resolve; });
  let closed = false;
  const origin = http.createServer((req, res) => {
    req.resume();
    res.once('close', () => { closed = true; });
    seen({ method: req.method, headers: req.headers, path: req.url });
    // Deliberately never send headers: shutdown must cancel this request.
  });
  t.after(async () => {
    origin.closeAllConnections();
    await new Promise(resolve => origin.close(resolve));
  });
  origin.listen(0, '127.0.0.1');
  await once(origin, 'listening');
  const p = processFixture(t, {
    TARGET_URL: 'http://127.0.0.1:1',
    ADMIN_TOKEN: 'admin-secret', PROXY_TOKEN: 'proxy-secret',
    KEEPALIVE_URL: `http://127.0.0.1:${origin.address().port}/health`, KEEPALIVE_INTERVAL: '5',
  });
  await listening(p);
  const probe = await requested;
  assert.equal(probe.method, 'GET');
  assert.equal(probe.path, '/health');
  assert.equal(probe.headers['x-admin-token'], undefined);
  assert.equal(probe.headers['x-proxy-token'], undefined);
  p.child.kill('SIGTERM');
  const [code, signal] = await p.exited;
  assert.equal(code, 0, p.stderr());
  assert.equal(signal, null);
  assert.equal(closed, true);
});
