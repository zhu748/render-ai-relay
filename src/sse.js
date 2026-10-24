import { ProxyError } from './errors.js';

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const EMPTY = Buffer.alloc(0);

// Keep partial events on this side of the connection. Outputs end after an
// event or a comment-only prefix, where heartbeats cannot interrupt a field.
export function createSseBuffer({ maxEventBytes, reserve, release }) {
  let atStart = true;
  let prefix = EMPTY;
  let parts = [];
  let pendingBytes = 0;
  let allocated = 0;
  let eventBytes = 0;
  let lastEventBytes = 0;
  let lineHasBytes = false;
  let lineIsComment = false;
  let eventHasLines = false;
  let previousCR = false;
  const blockSize = Math.min(64 * 1024, maxEventBytes);

  function append(chunk) {
    let offset = 0;
    while (offset < chunk.length) {
      let part = parts.at(-1);
      if (!part || part.used === part.buffer.length) {
        part = { buffer: Buffer.allocUnsafe(blockSize), used: 0 };
        parts.push(part);
      }
      const bytes = Math.min(chunk.length - offset, part.buffer.length - part.used);
      chunk.copy(part.buffer, part.used, offset, offset + bytes);
      part.used += bytes;
      offset += bytes;
    }
    pendingBytes += chunk.length;
  }

  function acknowledge(bytes) {
    allocated -= bytes;
    release(bytes);
  }

  return {
    get bufferedBytes() { return allocated; },
    push(input, stripBom) {
      if (!reserve(input.length)) {
        throw new ProxyError(503, 'sse_memory_limit', 'Relay SSE memory limit reached; retry later');
      }
      allocated += input.length;
      let chunk = input;
      let preamble = EMPTY;
      if (atStart) {
        if (prefix.length) chunk = Buffer.concat([prefix, chunk]);
        const isBom = chunk.subarray(0, 3).every((byte, index) => byte === BOM[index]);
        if (isBom && chunk.length < 3) {
          prefix = Buffer.from(chunk);
          return EMPTY;
        }
        atStart = false;
        prefix = EMPTY;
        if (isBom) {
          chunk = chunk.subarray(3);
          if (stripBom) acknowledge(3);
          else preamble = BOM;
        }
      }

      let boundary = 0;
      for (let i = 0; i < chunk.length; i++) {
        const byte = chunk[i];
        // A paired LF extends an already complete CR boundary without
        // becoming a new field. CR-only streams remain immediately usable.
        if (previousCR && byte === 10) {
          previousCR = false;
          if (!lineHasBytes && !eventHasLines) {
            if (lastEventBytes + 1 > maxEventBytes) {
              throw new ProxyError(502, 'sse_event_too_large', 'SSE event exceeds MAX_SSE_EVENT_BYTES');
            }
            boundary = i + 1;
            lastEventBytes = 0;
          }
          else eventBytes++;
        } else {
          previousCR = false;
          lastEventBytes = 0;
          eventBytes++;
          if (eventBytes > maxEventBytes) {
            throw new ProxyError(502, 'sse_event_too_large', 'SSE event exceeds MAX_SSE_EVENT_BYTES');
          }
          if (byte === 10 || byte === 13) {
            if (!lineHasBytes) eventHasLines = false;
            else if (!lineIsComment) eventHasLines = true;
            lineHasBytes = false;
            lineIsComment = false;
            previousCR = byte === 13;
          } else {
            if (!lineHasBytes) lineIsComment = byte === 58;
            lineHasBytes = true;
          }
          if (!lineHasBytes && !eventHasLines) {
            boundary = i + 1;
            lastEventBytes = eventBytes;
            eventBytes = 0;
          }
        }
        if (eventBytes > maxEventBytes) {
          throw new ProxyError(502, 'sse_event_too_large', 'SSE event exceeds MAX_SSE_EVENT_BYTES');
        }
      }

      let output = preamble;
      if (boundary) {
        const complete = chunk.subarray(0, boundary);
        output = parts.length || preamble.length
          ? Buffer.concat([preamble, ...parts.map(part => part.buffer.subarray(0, part.used)), complete], preamble.length + pendingBytes + complete.length)
          : complete;
        parts = [];
        pendingBytes = 0;
      }
      const tail = chunk.subarray(boundary);
      if (tail.length) {
        // Fixed-size blocks bound both retained network buffers and object
        // overhead, even when the upstream trickles one byte at a time.
        append(tail);
      }
      return output;
    },
    acknowledge,
    finish() {
      if (pendingBytes || prefix.length) {
        throw new ProxyError(502, 'incomplete_sse_event', 'Upstream ended before completing an SSE event');
      }
    },
    dispose() {
      acknowledge(allocated);
      parts = [];
      prefix = EMPTY;
      pendingBytes = 0;
    },
  };
}
