import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { getEventListeners } from 'node:events';
import { readBody } from '../src/request.js';
import { ProxyError } from '../src/errors.js';

function incoming() {
  const req = new PassThrough();
  req.headers = {};
  req.on('error', () => {});
  return req;
}

test('an upload already aborted before collection rejects immediately', async () => {
  const req = incoming();
  req.destroy();
  await assert.rejects(readBody(req, { maxBytes: 100 }), { code: 'client_disconnected' });
  assert.equal(req.listenerCount('data'), 0);
});

test('request collection preserves bytes and removes signal and stream listeners', async () => {
  const req = incoming();
  const controller = new AbortController();
  const body = readBody(req, { maxBytes: 100, signal: controller.signal });
  const raw = Buffer.from('中文🙂');
  req.write(raw.subarray(0, 4));
  req.end(raw.subarray(4));
  assert.deepEqual(await body, raw);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  for (const event of ['data', 'end', 'aborted']) assert.equal(req.listenerCount(event), 0);
});

test('cancelled upload collection drops its listeners and rejects with the original reason', async () => {
  const req = incoming();
  const controller = new AbortController();
  const body = readBody(req, { maxBytes: 100, signal: controller.signal });
  req.write('partial');
  const reason = new ProxyError(503, 'server_shutting_down', 'Stopping');
  controller.abort(reason);
  await assert.rejects(body, error => error === reason);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  for (const event of ['data', 'end', 'aborted']) assert.equal(req.listenerCount(event), 0);
  req.destroy();
});
