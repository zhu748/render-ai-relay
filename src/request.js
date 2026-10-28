import { ProxyError } from './errors.js';

export function readBody(req, { maxBytes, signal, reserve = () => true, chunked = false, tooLargeCode = 'request_too_large', tooLargeMessage = 'Request body exceeds configured limit' }) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0, tailUsed = 0;
    const cleanup = () => {
      req.off('data', data); req.off('end', end); req.off('aborted', aborted); req.off('error', fail);
      signal?.removeEventListener('abort', cancelled);
    };
    const fail = error => { cleanup(); chunks.length = 0; reject(error); };
    const aborted = () => fail(new ProxyError(499, 'client_disconnected', 'Client disconnected'));
    const cancelled = () => fail(signal.reason);
    const tooLarge = () => {
      fail(new ProxyError(413, tooLargeCode, tooLargeMessage));
      req.resume();
    };
    const data = chunk => {
      size += chunk.length;
      if (size > maxBytes) { tooLarge(); return; }
      if (!reserve(chunk.length)) {
        fail(new ProxyError(503, 'request_memory_limit', 'Relay request memory limit reached; retry later'));
        req.resume();
        return;
      }
      if (!chunked) chunks.push(chunk);
      else {
        // Coalesce trickled input into bounded blocks instead of retaining
        // thousands of tiny Buffer objects and their network allocations.
        let offset = 0;
        while (offset < chunk.length) {
          let tail = chunks.at(-1);
          if (!tail || tailUsed === tail.length) {
            tail = Buffer.allocUnsafe(Math.min(65536, maxBytes));
            chunks.push(tail); tailUsed = 0;
          }
          const bytes = Math.min(chunk.length - offset, tail.length - tailUsed);
          chunk.copy(tail, tailUsed, offset, offset + bytes);
          offset += bytes; tailUsed += bytes;
        }
      }
    };
    const end = () => {
      cleanup();
      if (chunked && chunks.length) chunks[chunks.length - 1] = chunks.at(-1).subarray(0, tailUsed);
      const body = chunked ? { chunks, length: size } : chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, size);
      if (!chunked) chunks.length = 0;
      resolve(body);
    };
    if (signal?.aborted) { fail(signal.reason); return; }
    if (req.aborted || (req.destroyed && !req.complete)) { aborted(); return; }
    if (Number(req.headers['content-length']) > maxBytes) { tooLarge(); return; }
    signal?.addEventListener('abort', cancelled, { once: true });
    req.on('data', data); req.once('end', end); req.once('aborted', aborted); req.once('error', fail);
  });
}
