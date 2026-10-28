import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProxy, loadConfig } from '../src/proxy.js';

const quiet = { info() {}, warn() {}, error() {} };
async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); }
async function stop(server) { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); }
async function get(server, path = '/test', headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port: server.address().port, path, agent: false, headers }, async res => {
      try { const chunks = []; for await (const chunk of res) chunks.push(chunk); resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); }
      catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

async function certificate(directory, name, san) {
  const key = join(directory, `${name}.key`), cert = join(directory, `${name}.pem`);
  await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=relay-test-only', '-addext', `subjectAltName=${san}`], { timeout: 15000 });
  return { key: await readFile(key), cert: await readFile(cert) };
}

test('HTTPS verifies trust and hostname, and reuses an authenticated upstream connection', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-tls-'));
  const defaults = tls.getCACertificates();
  const relays = [], origins = [];
  t.after(async () => {
    for (const relay of relays) { await relay.destroyAgents(); await stop(relay.server); }
    for (const origin of origins) await stop(origin);
    tls.setDefaultCACertificates(defaults);
    await rm(directory, { recursive: true, force: true });
  });
  const keys = await certificate(directory, 'trusted', 'IP:127.0.0.1');
  const origin = https.createServer(keys, (req, res) => { req.resume(); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"secure":true}'); });
  origins.push(origin); await listen(origin);
  async function relayFor(server) {
    const relay = createProxy({ ...loadConfig({ TARGET_URL: `https://127.0.0.1:${server.address().port}`, ADMIN_TOKEN: 'test-secret' }), tempDirectory: join(directory, 'bodies'), firstHeartbeatMs: 1000 }, { logger: quiet });
    relays.push(relay); await listen(relay.server); return relay;
  }
  const untrusted = await relayFor(origin);
  assert.equal((await get(untrusted.server)).body.error.code, 'upstream_connection_error');
  tls.setDefaultCACertificates([...defaults, keys.cert.toString()]);
  const trusted = await relayFor(origin);
  assert.deepEqual((await get(trusted.server)).body, { secure: true });
  assert.deepEqual((await get(trusted.server)).body, { secure: true });
  const status = (await get(trusted.server, '/__proxy/status', { 'x-admin-token': 'test-secret' })).body;
  assert.ok(status.events.some(event => event.upstream_reused_socket));
  const wrong = await certificate(directory, 'wrong-host', 'DNS:wrong.example');
  tls.setDefaultCACertificates([...defaults, keys.cert.toString(), wrong.cert.toString()]);
  const wrongOrigin = https.createServer(wrong, (_req, res) => res.end('must not be trusted'));
  origins.push(wrongOrigin); await listen(wrongOrigin);
  const mismatch = await relayFor(wrongOrigin);
  assert.equal((await get(mismatch.server)).status, 502);
  const mismatchStatus = (await get(mismatch.server, '/__proxy/status', { 'x-admin-token': 'test-secret' })).body;
  assert.ok(mismatchStatus.events.some(event => event.code === 'ERR_TLS_CERT_ALTNAME_INVALID'));
});

test('a TCP peer that never completes TLS is cancelled by the connection deadline', async t => {
  const sockets = new Set();
  const origin = net.createServer(socket => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); });
  await listen(origin);
  const relay = createProxy({ ...loadConfig({ TARGET_URL: `https://127.0.0.1:${origin.address().port}` }), connectTimeoutMs: 60, firstHeartbeatMs: 1000 }, { logger: quiet });
  t.after(async () => {
    await relay.destroyAgents(); await stop(relay.server);
    for (const socket of sockets) socket.destroy();
    await stop(origin);
  });
  await listen(relay.server);
  const result = await get(relay.server);
  assert.equal(result.status, 504);
  assert.equal(result.body.error.code, 'connect_timeout');
});
