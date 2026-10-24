import test from 'node:test';
import assert from 'node:assert/strict';
import { createJsonValidator } from '../src/json.js';

function accepts(raw, cut = 0, options) {
  const validator = createJsonValidator(options);
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  validator.write(bytes.subarray(0, cut));
  validator.write(bytes.subarray(cut));
  validator.finish();
}

test('incremental JSON validation accepts scalars, nested values, escapes and every byte split', () => {
  const values = [null, true, false, 0, -0, 12, -12.3, 1e-30, '', '中文🙂', '\\"\n\t\u0000', '\uD800', [], {}, { a: [1, { b: false }], '': 'x', '__proto__': null }];
  const examples = values.map(value => JSON.stringify(value)).concat([' \n\t {"a": 1, "a": 2} \r ', '-0.001E+020', '1e400', '"\\uD800\\uDC00"']);
  for (const raw of examples) {
    assert.doesNotThrow(() => JSON.parse(raw));
    for (let cut = 0; cut <= Buffer.byteLength(raw); cut++) assert.doesNotThrow(() => accepts(raw, cut), `${raw} at ${cut}`);
  }
});

test('invalid and truncated JSON is rejected at every split without exposing content', () => {
  const examples = ['', ' ', '{', '[', '"', '"SECRET_PARTIAL', '"bad\nline"', '"\\q"', '"\\u12"', '"\\u12xz"', '{"a"}', '{"a":}', '{a:1}', '{"a":1,}', '[,]', '[1,]', '[1 2]', 'true false', 'nullx', 'True', '+1', '01', '-01', '1.', '.1', '-', '1e', '1e+', '1e1e2', '1.e2', 'NaN', 'Infinity', '{}x', '[}', '{]'];
  for (const raw of examples) {
    assert.throws(() => JSON.parse(raw));
    for (let cut = 0; cut <= Buffer.byteLength(raw); cut++) {
      assert.throws(() => accepts(raw, cut), error => {
        assert.equal(error.code, 'invalid_upstream_json');
        assert.ok(!error.message.includes('SECRET_PARTIAL'));
        return true;
      }, `${raw} at ${cut}`);
    }
  }
});

test('UTF-8 validation rejects invalid leads, continuations, overlong and surrogate encodings', () => {
  const invalid = [[0x80], [0xc0, 0xaf], [0xc2], [0xe0, 0x80, 0x80], [0xed, 0xa0, 0x80], [0xf0, 0x80, 0x80, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xf5, 0x80, 0x80, 0x80], [0xc2, 0x22], [0xff]];
  for (const value of invalid) {
    const raw = Buffer.from([34, ...value, 34]);
    for (let cut = 0; cut <= raw.length; cut++) assert.throws(() => accepts(raw, cut), { code: 'invalid_upstream_json' });
  }
});

test('generated documents and syntax mutations agree with native JSON.parse', () => {
  let state = 147;
  const random = n => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % n; };
  function value(depth = 0) {
    const kind = random(depth < 4 ? 6 : 4);
    if (kind === 0) return null;
    if (kind === 1) return random(2) === 0;
    if (kind === 2) return (random(100000) - 50000) / 17;
    if (kind === 3) return ['中文🙂', '\\"\n', '[]{}:null', '', '\ud800'][random(5)];
    if (kind === 4) return Array.from({ length: random(4) }, () => value(depth + 1));
    return Object.fromEntries(Array.from({ length: random(4) }, (_, i) => [`key${i}`, value(depth + 1)]));
  }
  for (let i = 0; i < 240; i++) {
    const raw = JSON.stringify(value());
    const pos = random(raw.length);
    const examples = [raw, raw.slice(0, pos), raw + 'x', raw.slice(0, pos) + ',:'.charAt(random(2)) + raw.slice(pos + 1)];
    for (const text of examples) {
      const bytes = Buffer.from(text);
      let expected = true;
      try { JSON.parse(bytes.toString()); } catch { expected = false; }
      let actual = true;
      try { accepts(bytes, random(bytes.length + 1)); } catch { actual = false; }
      assert.equal(actual, expected, text);
    }
  }
});

test('nesting is bounded and large streamed strings do not require whole-body buffering', () => {
  accepts('{"a":[1]}', 5, { maxDepth: 2 });
  assert.throws(() => accepts('{"a":[[1]]}', 7, { maxDepth: 2 }), { code: 'json_nesting_limit' });
  const validator = createJsonValidator();
  validator.write(Buffer.from('{"data":"'));
  const chunk = Buffer.alloc(65536, 120);
  for (let i = 0; i < 32; i++) validator.write(chunk);
  validator.write(Buffer.from('"}'));
  validator.finish();
});
