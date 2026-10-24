import { ProxyError } from './errors.js';

const whitespace = byte => byte === 32 || byte === 9 || byte === 10 || byte === 13;
const digit = byte => byte >= 48 && byte <= 57;
const hex = byte => digit(byte) || (byte >= 65 && byte <= 70) || (byte >= 97 && byte <= 102);

// Validate incrementally without decoding, storing or reserializing the body.
// Only nesting state and the current token are retained, regardless of size.
export function createJsonValidator({ maxDepth = 1024 } = {}) {
  const root = { kind: 'root', state: 'value' };
  const stack = [];
  let token = '', numberState = '', literal = '', literalIndex = 0;
  let key = false, escaped = false, unicodeRemaining = 0;
  let utf8Remaining = 0, utf8Min = 128, utf8Max = 191;
  const current = () => stack.at(-1) || root;
  const invalid = () => { throw new ProxyError(502, 'invalid_upstream_json', 'Upstream returned invalid or incomplete UTF-8 JSON'); };
  function complete() { const frame = current(); frame.state = frame.kind === 'root' ? 'done' : 'comma'; }
  function open(kind) {
    if (stack.length >= maxDepth) throw new ProxyError(502, 'json_nesting_limit', 'JSON response exceeds MAX_JSON_DEPTH');
    stack.push({ kind, state: kind === 'object' ? 'first_key' : 'first_value' });
  }
  function close() { stack.pop(); complete(); }
  function stringByte(byte) {
    if (utf8Remaining) {
      if (byte < utf8Min || byte > utf8Max) invalid();
      utf8Remaining--;
      utf8Min = 128; utf8Max = 191;
    } else if (unicodeRemaining) {
      if (!hex(byte)) invalid();
      unicodeRemaining--;
    } else if (escaped) {
      escaped = false;
      if (byte === 117) unicodeRemaining = 4;
      else if (![34, 92, 47, 98, 102, 110, 114, 116].includes(byte)) invalid();
    } else if (byte === 34) {
      token = '';
      if (key) current().state = 'colon'; else complete();
    } else if (byte === 92) escaped = true;
    else if (byte < 32) invalid();
    else if (byte >= 128) {
      if (byte >= 194 && byte <= 223) utf8Remaining = 1;
      else if (byte >= 224 && byte <= 239) {
        utf8Remaining = 2;
        if (byte === 224) utf8Min = 160;
        if (byte === 237) utf8Max = 159;
      } else if (byte >= 240 && byte <= 244) {
        utf8Remaining = 3;
        if (byte === 240) utf8Min = 144;
        if (byte === 244) utf8Max = 143;
      } else invalid();
    }
  }
  function finishNumber() {
    if (!['zero', 'integer', 'fraction', 'exponent'].includes(numberState)) invalid();
    token = '';
    complete();
  }
  function numberByte(byte) {
    if (numberState === 'sign') {
      if (byte === 48) numberState = 'zero';
      else if (byte >= 49 && byte <= 57) numberState = 'integer';
      else invalid();
    } else if (numberState === 'dot') {
      if (!digit(byte)) invalid();
      numberState = 'fraction';
    } else if (numberState === 'e' || numberState === 'exponent_sign') {
      if (numberState === 'e' && (byte === 43 || byte === 45)) numberState = 'exponent_sign';
      else if (digit(byte)) numberState = 'exponent';
      else invalid();
    } else if (numberState !== 'zero' && digit(byte)) {
      // More digits in the integer, fraction or exponent.
    } else if (['zero', 'integer'].includes(numberState) && byte === 46) numberState = 'dot';
    else if (numberState !== 'exponent' && (byte === 101 || byte === 69)) numberState = 'e';
    else { finishNumber(); return false; }
    return true;
  }
  function value(byte) {
    if (byte === 123) open('object');
    else if (byte === 91) open('array');
    else if (byte === 34) { token = 'string'; key = false; }
    else if (byte === 45 || digit(byte)) {
      token = 'number';
      numberState = byte === 45 ? 'sign' : byte === 48 ? 'zero' : 'integer';
    } else if ([116, 102, 110].includes(byte)) {
      token = 'literal'; literal = byte === 116 ? 'true' : byte === 102 ? 'false' : 'null'; literalIndex = 1;
    } else invalid();
  }
  return {
    write(chunk) {
      for (const byte of chunk) {
        if (token === 'string') { stringByte(byte); continue; }
        if (token === 'literal') {
          if (byte !== literal.charCodeAt(literalIndex++)) invalid();
          if (literalIndex === literal.length) { token = ''; complete(); }
          continue;
        }
        if (token === 'number' && numberByte(byte)) continue;
        if (whitespace(byte)) continue;
        const frame = current();
        if (frame.state === 'value' || frame.state === 'first_value') {
          if (frame.state === 'first_value' && byte === 93) close();
          else value(byte);
        } else if (frame.state === 'key' || frame.state === 'first_key') {
          if (frame.state === 'first_key' && byte === 125) close();
          else if (byte === 34) { token = 'string'; key = true; }
          else invalid();
        } else if (frame.state === 'colon') {
          if (byte !== 58) invalid();
          frame.state = 'value';
        } else if (frame.state === 'comma') {
          if (byte === (frame.kind === 'object' ? 125 : 93)) close();
          else if (byte === 44) frame.state = frame.kind === 'object' ? 'key' : 'value';
          else invalid();
        } else invalid();
      }
    },
    finish() {
      if (token === 'number') finishNumber();
      if (token || stack.length || root.state !== 'done') invalid();
    },
  };
}
