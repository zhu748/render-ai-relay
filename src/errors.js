export class ProxyError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const STORAGE_ERRORS = new Set(['ENOSPC', 'EDQUOT', 'EIO', 'EACCES', 'EPERM', 'EROFS', 'EMFILE', 'ENFILE', 'ENOENT']);

export function classifyError(error, phase) {
  if (error instanceof ProxyError) return error;
  if (['buffering_json', 'sending_json'].includes(phase) && STORAGE_ERRORS.has(error?.code)) {
    return new ProxyError(503, 'temporary_storage_unavailable', 'Relay temporary storage is unavailable');
  }
  return new ProxyError(502, 'upstream_connection_error', 'Upstream connection failed or response was interrupted');
}
