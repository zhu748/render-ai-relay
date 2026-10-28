import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mediaQuality, requestHint, heartbeatPolicy } from '../src/policy.js';
import { loadConfig } from '../src/config.js';

const body = raw => ({ length: Buffer.byteLength(raw), chunks: [Buffer.from(raw)] });
const request = headers => ({ method: 'POST', url: '/v1/chat/completions', headers: { 'content-type': 'application/json', ...headers } });

test('media preferences respect q=0, parameters, case and quoted delimiters', () => {
  for (const accept of ['application/json, text/event-stream;q=0', 'TEXT/EVENT-STREAM; Q=0.000', 'text/event-stream;q=invalid']) assert.equal(mediaQuality(accept, 'text/event-stream'), 0);
  assert.equal(mediaQuality('application/json; profile="a,b;c", text/event-stream; q=0.8', 'text/event-stream'), 0.8);
  assert.equal(mediaQuality('*/*', 'text/event-stream'), undefined);
  assert.equal(mediaQuality('text/event-stream;q=0, text/event-stream;q=0.7', 'text/event-stream'), 0.7);
});

test('bounded classification handles escaped top-level keys, nested decoys and duplicate keys', async () => {
  const cases = [
    ['{"stream":true}', 'sse'], ['{"str\\u0065am":true}', 'sse'],
    ['{"nested":{"stream":true}}', 'json'], ['{"stream":"true"}', 'json'],
    ['{"stream":true,"stream":false}', 'json'], ['{"stream":false,"stream":true}', 'sse'],
    ['{"stream":true,"stream":{}}', 'json'], ['{"stream":true}garbage', null],
    ['{"stream":true,"unfinished":', null], ['[true, {"stream":true}]', 'json'],
  ];
  for (const [raw, expected] of cases) {
    const bytes = Buffer.from(raw);
    for (let cut = 0; cut <= bytes.length; cut++) assert.equal(await requestHint(request(), { length: bytes.length, chunks: [bytes.subarray(0, cut), bytes.subarray(cut)] }), expected, `${raw} at ${cut}`);
  }
  assert.equal(await requestHint(request({ accept: 'application/json, text/event-stream;q=0' }), body('{"stream":false}')), 'json');
  assert.equal(await requestHint(request({ accept: 'text/event-stream;q=0' }), body('{"stream":true}')), null);
  assert.equal(await requestHint(request({ 'content-encoding': 'identity' }), body('{"stream":true}')), 'sse');
  assert.equal(await requestHint(request({ 'content-encoding': 'gzip', accept: 'text/event-stream' }), body('compressed bytes')), 'sse');
});

test('large classification yields to other requests and honors cancellation', async () => {
  const raw = body('{"items":[' + '{},'.repeat(100000) + '{}],"stream":true}');
  const controller = new AbortController();
  const reason = new Error('cancelled');
  setImmediate(() => controller.abort(reason));
  await assert.rejects(requestHint(request(), raw, controller.signal), error => error === reason);
});

test('a six-megabyte object-dense request can be classified with a 64 MiB heap', async () => {
  const source = `import {requestHint} from ${JSON.stringify(new URL('../src/policy.js', import.meta.url).href)};
    const raw = Buffer.from('{"items":[' + '{},'.repeat(1999999) + '{}],"stream":true}');
    console.log(await requestHint({headers:{'content-type':'application/json'}}, {chunks:[raw],length:raw.length}));`;
  const { stdout } = await promisify(execFile)(process.execPath, ['--max-old-space-size=64', '--input-type=module', '-e', source], { timeout: 15000 });
  assert.equal(stdout.trim(), 'sse');
});

test('longest route prefix selects a heartbeat mode while safety bypasses still win', () => {
  const config = loadConfig({ TARGET_URL: 'https://example.com', HEARTBEAT_MODE: 'after-headers', HEARTBEAT_ROUTES: '[{"prefix":"/v1/","mode":"early"},{"prefix":"/v1/files/","mode":"off"}]' });
  assert.equal(heartbeatPolicy(request(), config).mode, 'early');
  assert.equal(heartbeatPolicy({ ...request(), url: '/v1/files/upload' }, config).mode, 'off');
  assert.equal(heartbeatPolicy({ ...request(), url: '/other' }, config).mode, 'after-headers');
  assert.equal(heartbeatPolicy(request({ 'x-proxy-heartbeat': 'off' }), config).mode, 'off');
  assert.equal(heartbeatPolicy(request({ accept: 'text/html;q=0,application/json' }), config).mode, 'early');
  for (const env of [{ HEARTBEAT_MODE: 'invalid' }, { HEARTBEAT_ROUTES: '{}' }, { HEARTBEAT_ROUTES: '[{"prefix":"/","mode":"early","unknown":1}]' }, { HEARTBEAT_ROUTES: '[{"prefix":"/","mode":"off"},{"prefix":"/","mode":"early"}]' }, { ADMIN_HOSTS: 'https://admin.example.com' }, { ADMIN_HOSTS: 'admin.example.com/path' }, { CORS_ORIGINS: '*' }, { CORS_ORIGINS: 'https://client.example/path' }, { ALLOW_UPSTREAM_SERVICE_WORKERS: 'true', ADMIN_TOKEN: 'secret' }]) {
    assert.throws(() => loadConfig({ TARGET_URL: 'https://example.com', ...env }));
  }
});
