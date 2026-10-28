import { createJsonValidator } from './json.js';

function split(value, delimiter) {
  const parts = [];
  let start = 0, quoted = false, escaped = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (escaped) escaped = false;
    else if (quoted && char === '\\') escaped = true;
    else if (char === '"') quoted = !quoted;
    else if (!quoted && char === delimiter) { parts.push(value.slice(start, i)); start = i + 1; }
  }
  parts.push(value.slice(start));
  return parts;
}

export function mediaQuality(accept, mediaType) {
  let quality;
  for (const item of split(String(accept || ''), ',')) {
    const [type, ...parameters] = split(item, ';');
    if (type.trim().toLowerCase() !== mediaType) continue;
    let weight = 1;
    for (const parameter of parameters) {
      const match = /^\s*q\s*=\s*(.*?)\s*$/i.exec(parameter);
      if (match) weight = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(match[1]) ? Number(match[1]) : 0;
    }
    quality = Math.max(quality ?? 0, weight);
  }
  return quality;
}

export function jsonType(value) {
  const type = String(value || '').split(';', 1)[0].trim().toLowerCase();
  return type === 'application/json' || /^application\/[a-z0-9!#$&^_.+-]+\+json$/.test(type);
}

export async function requestHint(req, body, signal) {
  const sseQuality = mediaQuality(req.headers.accept, 'text/event-stream');
  const encoding = String(req.headers['content-encoding'] || 'identity').trim().toLowerCase();
  if (jsonType(req.headers['content-type']) && encoding === 'identity' && body.length) {
    const validator = createJsonValidator({ maxDepth: 16384, inspectStream: true });
    let sinceYield = 0;
    try {
      for (const chunk of body.chunks) {
        // Bound individual synchronous work even for synthetic large chunks.
        for (let offset = 0; offset < chunk.length; offset += 65536) {
          if (signal?.aborted) throw signal.reason;
          const piece = chunk.subarray(offset, offset + 65536);
          validator.write(piece);
          sinceYield += piece.length;
          if (sinceYield >= 262144) { await new Promise(resolve => setImmediate(resolve)); sinceYield = 0; }
        }
      }
      validator.finish();
      if (validator.stream !== undefined) return validator.stream ? (sseQuality === 0 ? null : 'sse') : 'json';
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      // Invalid/deep input still goes upstream unchanged. Wait for actual
      // response headers instead of guessing a potentially incompatible type.
      return null;
    }
  }
  return sseQuality > 0 ? 'sse' : 'json';
}

export function heartbeatPolicy(req, config) {
  if (!config.heartbeatMs) return { mode: 'off', reason: 'disabled' };
  if (['HEAD', 'OPTIONS'].includes(req.method)) return { mode: 'off', reason: 'method' };
  if (req.headers.range) return { mode: 'off', reason: 'range' };
  if (req.headers['x-proxy-heartbeat'] === 'off') return { mode: 'off', reason: 'bypass_header' };
  const destination = req.headers['sec-fetch-dest'];
  if (req.headers['sec-fetch-mode'] === 'navigate' || (destination && destination !== 'empty') ||
      mediaQuality(req.headers.accept, 'text/html') > 0) return { mode: 'off', reason: 'web_resource' };
  const pathname = req.url.split('?', 1)[0];
  const rule = config.heartbeatRoutes?.find(rule => pathname.startsWith(rule.prefix));
  if (rule) return { mode: rule.mode, reason: rule.mode === 'off' ? 'route_disabled' : 'enabled' };
  if (config.heartbeatPrefixes.length && !config.heartbeatPrefixes.some(prefix => pathname.startsWith(prefix))) return { mode: 'off', reason: 'path_excluded' };
  return { mode: config.heartbeatMode || 'early', reason: config.heartbeatMode === 'off' ? 'disabled' : 'enabled' };
}

function authority(value) {
  try {
    const parsed = new URL(`http://${value}`);
    if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return null;
    return { hostname: parsed.hostname.replace(/\.$/, '').toLowerCase(), port: parsed.port };
  } catch { return null; }
}

export function isAdminHostname(req, config) {
  const actual = authority(req.headers.host || '');
  return Boolean(actual && config.adminHosts?.some(host => authority(host)?.hostname === actual.hostname));
}

export function isAdminHost(req, config) {
  const actual = authority(req.headers.host || '');
  return Boolean(actual && config.adminHosts?.some(host => {
    const expected = authority(host);
    return expected?.hostname === actual.hostname && (!expected.port || expected.port === actual.port || (expected.port === '443' && !actual.port));
  }));
}

export function applyCors(req, config, headers = {}) {
  if (!config.corsOrigins?.length) return headers;
  for (const name of Object.keys(headers)) if (name.startsWith('access-control-')) delete headers[name];
  const vary = String(headers.vary || '').split(',').map(value => value.trim()).filter(Boolean);
  if (!vary.some(value => value.toLowerCase() === 'origin' || value === '*')) vary.push('Origin');
  headers.vary = vary.join(', ');
  if (config.corsOrigins.includes(req.headers.origin)) {
    headers['access-control-allow-origin'] = req.headers.origin;
    headers['access-control-expose-headers'] = 'X-Render-Relay-Request-Id, X-Render-Relay-Version, Retry-After';
  }
  return headers;
}

export function handleCorsPreflight(req, res, config) {
  const cors = applyCors(req, config);
  for (const [name, value] of Object.entries(cors)) res.setHeader(name, value);
  if (!config.corsOrigins?.length || req.method !== 'OPTIONS' || !req.headers.origin || !req.headers['access-control-request-method']) return false;
  if (!req.complete) res.setHeader('connection', 'close');
  req.resume();
  const method = req.headers['access-control-request-method'];
  const headerText = String(req.headers['access-control-request-headers'] || '');
  const headers = headerText.split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  const token = /^[!#$%&'*+.^_`|~0-9a-z-]+$/i;
  if (!cors['access-control-allow-origin'] || !token.test(method) || method.length > 32 ||
      headerText.length > 2048 || headers.length > 64 || headers.some(name => !token.test(name) || name === 'x-admin-token')) {
    res.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ error: { code: 'cors_preflight_denied', message: 'Cross-origin preflight is not allowed' } }));
  } else {
    res.writeHead(204, {
      'access-control-allow-methods': method,
      ...(headers.length ? { 'access-control-allow-headers': [...new Set(headers)].join(', ') } : {}),
      vary: 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
      'cache-control': 'no-store', 'access-control-max-age': '600',
    });
    res.end();
  }
  return true;
}
