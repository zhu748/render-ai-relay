// Optional real-browser checks. Install playwright and Chromium as documented.
import http from 'node:http';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProxy, loadConfig } from '../src/proxy.js';

let playwright;
try { playwright = await import('playwright'); }
catch (error) {
  if (!process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES) throw error;
  playwright = await import(`${process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES}/playwright/index.mjs`);
}

const quiet = { info() {}, warn() {}, error() {} };
const directory = await mkdtemp(join(tmpdir(), 'relay-browser-'));
let leaks = 0, workerHits = 0, browser;
const pageErrors = [];
const origin = http.createServer((req, res) => {
  req.resume();
  if (req.url === '/sw.js') {
    workerHits++;
    res.writeHead(200, { 'content-type': 'text/javascript' });
    res.end(`self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
      self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
      self.addEventListener('fetch', event => {
        if (event.request.headers.has('x-admin-token')) event.waitUntil(fetch('/leak'));
      });`);
  } else if (req.url === '/leak') { leaks++; res.end('leaked'); }
  else { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>Upstream test page</title><p>Upstream page</p>'); }
});
origin.listen(0, '127.0.0.1'); await once(origin, 'listening');
const config = { ...loadConfig({ TARGET_URL: `http://127.0.0.1:${origin.address().port}`, ADMIN_TOKEN: 'browser-test-token', ADMIN_HOSTS: '127.0.0.2:1' }), tempDirectory: directory, firstHeartbeatMs: 25, heartbeatMs: 35 };
const relay = createProxy(config, { logger: quiet });
relay.server.listen(0, '0.0.0.0'); await once(relay.server, 'listening');
const port = relay.server.address().port;
config.adminHosts = [`127.0.0.2:${port}`];
const apiUrl = `http://127.0.0.1:${port}`, adminUrl = `http://127.0.0.2:${port}`;
try {
  browser = await playwright.chromium.launch({ headless: true, args: ['--no-proxy-server'] });
  const context = await browser.newContext();
  context.on('page', page => page.on('pageerror', error => pageErrors.push(error.message)));
  const api = await context.newPage();
  await api.goto(apiUrl);
  const blocked = await api.evaluate(async () => {
    try { await navigator.serviceWorker.register('/sw.js'); return false; } catch { return true; }
  });
  assert.equal(blocked, true);
  assert.equal(workerHits, 0);

  // With explicit opt-in and an isolated admin host, a real upstream worker
  // may control the API page but must never control management or see its key.
  config.allowUpstreamServiceWorkers = true;
  await api.evaluate(async () => { await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready; });
  await api.reload();
  assert.equal(await api.evaluate(() => Boolean(navigator.serviceWorker.controller)), true);
  assert.equal((await api.goto(apiUrl + '/__proxy/')).status(), 403);
  const admin = await context.newPage();
  assert.equal((await admin.goto(adminUrl + '/__proxy/')).status(), 200);
  assert.equal(await admin.evaluate(() => navigator.serviceWorker.controller), null);
  await admin.locator('#token').fill('browser-test-token');
  await admin.locator('#connect').click();
  await admin.locator('#status').filter({ hasText: '已连接' }).waitFor();
  assert.equal(await admin.locator('#token').inputValue(), '');
  await admin.locator('#keepalive-interval').fill('61');
  await admin.locator('#keepalive-save').click();
  await admin.locator('#keepalive-config-status').filter({ hasText: '已保存并应用' }).waitFor();
  await admin.locator('#probe-short').click();
  await admin.locator('#probe-result').filter({ hasText: '测试完成' }).waitFor({ timeout: 15000 });
  assert.equal(leaks, 0);
  assert.equal((await admin.goto(adminUrl + '/sw.js')).status(), 403);
  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({ verified: true, service_worker_blocked_by_default: true, admin_origin_isolated: true, admin_token_leaks: leaks, settings_save: true, heartbeat_probe: true, browser_errors: pageErrors.length }));
} finally {
  await browser?.close();
  relay.server.closeAllConnections(); await relay.destroyAgents();
  await new Promise(resolve => relay.server.close(resolve));
  origin.closeAllConnections(); await new Promise(resolve => origin.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
