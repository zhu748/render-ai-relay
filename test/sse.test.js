import test from 'node:test';
import assert from 'node:assert/strict';
import { createSseBuffer } from '../src/sse.js';

function buffer(maxEventBytes = 1024, budget = 4096) {
  let held = 0;
  const stream = createSseBuffer({
    maxEventBytes,
    reserve(bytes) { if (held + bytes > budget) return false; held += bytes; return true; },
    release(bytes) { held -= bytes; assert.ok(held >= 0); },
  });
  return { stream, held: () => held };
}

test('SSE buffering preserves UTF-8, BOM and every two-chunk split for all line endings', () => {
  for (const ending of ['\n', '\r', '\r\n']) {
    const raw = Buffer.from('\uFEFF' + [': keep-alive', '', 'id: 1', 'data: 中文🙂', 'data: second line', '', 'data: [DONE]', '', ''].join(ending));
    for (let split = 0; split <= raw.length; split++) {
      const f = buffer();
      const output = [];
      for (const chunk of [raw.subarray(0, split), raw.subarray(split)].filter(b => b.length)) {
        const complete = f.stream.push(chunk, false);
        output.push(complete);
        f.stream.acknowledge(complete.length);
      }
      f.stream.finish();
      assert.deepEqual(Buffer.concat(output), raw);
      assert.equal(f.held(), 0);
      f.stream.dispose();
    }
  }
});

test('a partial SSE field remains private until its entire event is available', () => {
  const f = buffer();
  assert.equal(f.stream.push(Buffer.from('data: {"text":"par'), false).length, 0);
  assert.equal(f.held(), Buffer.byteLength('data: {"text":"par'));
  const output = f.stream.push(Buffer.from('tial"}\n\n'), false);
  assert.equal(output.toString(), 'data: {"text":"partial"}\n\n');
  assert.equal(f.held(), output.length, 'Queued complete events remain budgeted until acknowledged');
  f.stream.acknowledge(output.length);
  assert.equal(f.held(), 0);
  f.stream.finish();
});

test('many small complete events can exceed the per-event limit in aggregate', () => {
  const f = buffer(10);
  const raw = Buffer.from('data:x\n\n'.repeat(100));
  const output = f.stream.push(raw, false);
  assert.deepEqual(output, raw);
  f.stream.acknowledge(output.length);
  f.stream.finish();
  assert.equal(f.held(), 0);
});

test('event limits include final framing bytes and reset at each boundary', () => {
  for (const ending of ['\n', '\r', '\r\n']) {
    const raw = Buffer.from(`data:x${ending}${ending}`);
    for (const split of [1, raw.length - 1]) {
      const f = buffer(raw.length - 1);
      assert.throws(() => {
        f.stream.push(raw.subarray(0, split), false);
        f.stream.push(raw.subarray(split), false);
      }, { code: 'sse_event_too_large' });
      f.stream.dispose();
      assert.equal(f.held(), 0);
    }
  }
});

test('unfinished events and incomplete UTF-8 BOM prefixes cannot finish successfully', () => {
  for (const raw of [Buffer.from('data: lost'), Buffer.from('data: lost\n'), Buffer.from([0xef, 0xbb])]) {
    const f = buffer();
    assert.equal(f.stream.push(raw, false).length, 0);
    assert.throws(() => f.stream.finish(), { code: 'incomplete_sse_event' });
    f.stream.dispose();
    assert.equal(f.held(), 0);
  }
});

test('memory limit rejection and disposal never leak or double-release capacity', () => {
  const f = buffer(100, 10);
  f.stream.push(Buffer.from('data:'), false);
  assert.throws(() => f.stream.push(Buffer.from('123456'), false), { code: 'sse_memory_limit' });
  assert.equal(f.held(), 5);
  f.stream.dispose();
  f.stream.dispose();
  assert.equal(f.held(), 0);
});

test('comment-only keepalives can pass immediately without splitting a pending data event', () => {
  const f = buffer();
  const comment = Buffer.from(': heartbeat\n');
  const output = f.stream.push(comment, false);
  assert.deepEqual(output, comment);
  f.stream.acknowledge(output.length);
  f.stream.finish();
  const partial = 'event: custom\ndata: hello\n: comment in event\n';
  assert.equal(f.stream.push(Buffer.from(partial), false).length, 0);
  const complete = f.stream.push(Buffer.from('\n'), false);
  assert.equal(complete.toString(), partial + '\n');
  f.stream.acknowledge(complete.length);
  f.stream.finish();
  assert.equal(f.held(), 0);
});

test('events spanning many tiny chunks and multiple buffer blocks stay byte exact', () => {
  const raw = Buffer.from('data: ' + 'x'.repeat(140 * 1024) + '\n\n');
  const f = buffer(raw.length, raw.length);
  const chunks = [];
  for (let i = 0; i < raw.length; i += 37) {
    const output = f.stream.push(raw.subarray(i, i + 37), false);
    if (output.length) chunks.push(output);
    f.stream.acknowledge(output.length);
  }
  f.stream.finish();
  assert.deepEqual(Buffer.concat(chunks), raw);
  assert.equal(f.held(), 0);
});
