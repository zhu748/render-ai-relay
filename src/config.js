import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeKeepaliveUrl } from './keepalive.js';

export const NUMERIC_SETTINGS = {
  heartbeatMs: { env: 'HEARTBEAT_INTERVAL_SECONDS', fallback: 1, max: 60, scale: 1000 },
  firstHeartbeatMs: { env: 'HEARTBEAT_START_DELAY_SECONDS', fallback: 1, max: 60, scale: 1000 },
  port: { env: 'PORT', fallback: 10000, min: 0, max: 65535, integer: true },
  totalTimeoutMs: { env: 'UPSTREAM_TIMEOUT_SECONDS', fallback: 1800, max: 86400, scale: 1000 },
  connectTimeoutMs: { env: 'CONNECT_TIMEOUT_SECONDS', fallback: 30, min: 1, max: 300, scale: 1000 },
  tcpKeepAliveMs: { env: 'TCP_KEEPALIVE_SECONDS', fallback: 15, min: 1, max: 300, scale: 1000 },
  upstreamIdleSocketMs: { env: 'UPSTREAM_IDLE_SOCKET_TIMEOUT_SECONDS', fallback: 15, min: 0.001, max: 300, scale: 1000 },
  downstreamStallMs: { env: 'DOWNSTREAM_STALL_TIMEOUT_SECONDS', fallback: 120, max: 3600, scale: 1000 },
  shutdownGraceMs: { env: 'SHUTDOWN_GRACE_SECONDS', fallback: 25, min: 0, max: 300, scale: 1000 },
  keepaliveIntervalMs: { env: 'KEEPALIVE_INTERVAL', fallback: 60, min: 5, max: 86400, integer: true, scale: 1000 },
  keepaliveTimeoutMs: { env: 'KEEPALIVE_TIMEOUT_SECONDS', fallback: 30, min: 1, max: 300, scale: 1000 },
  adminRequestTimeoutMs: { env: 'ADMIN_REQUEST_TIMEOUT_SECONDS', fallback: 15, min: 1, max: 120, scale: 1000 },
  maxRequestBytes: { env: 'MAX_REQUEST_BYTES', fallback: 32 * 1024 * 1024, min: 1, integer: true },
  maxJsonResponseBytes: { env: 'MAX_JSON_RESPONSE_BYTES', fallback: 256 * 1024 * 1024, min: 1, integer: true },
  maxJsonDepth: { env: 'MAX_JSON_DEPTH', fallback: 1024, min: 1, max: 16384, integer: true },
  maxConcurrentRequests: { env: 'MAX_CONCURRENT_REQUESTS', fallback: 32, min: 1, max: 1024, integer: true },
  maxBufferedRequestBytes: { env: 'MAX_BUFFERED_REQUEST_BYTES', fallback: 64 * 1024 * 1024, min: 1, integer: true },
  maxBufferedResponseBytes: { env: 'MAX_BUFFERED_RESPONSE_BYTES', fallback: 512 * 1024 * 1024, min: 1, integer: true },
  maxSseEventBytes: { env: 'MAX_SSE_EVENT_BYTES', fallback: 16 * 1024 * 1024, min: 1, integer: true },
  maxBufferedSseBytes: { env: 'MAX_BUFFERED_SSE_BYTES', fallback: 64 * 1024 * 1024, min: 1, integer: true },
  tempMinFreeBytes: { env: 'TEMP_MIN_FREE_BYTES', fallback: 16 * 1024 * 1024, min: 0, integer: true },
  tempCleanupRetryMs: { env: 'TEMP_CLEANUP_RETRY_SECONDS', fallback: 5, min: 0.05, max: 300, scale: 1000 },
  maxPendingTempCleanups: { env: 'MAX_PENDING_TEMP_CLEANUPS', fallback: 64, min: 1, max: 1024, integer: true },
};

function numberSetting(env, name, fallback, { min = 0, max = Infinity, integer = false } = {}) {
  const raw = env[name];
  const value = raw === undefined || (typeof raw === 'string' && raw.trim() === '') ? fallback : Number(raw);
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}

export function loadConfig(env = process.env) {
  if (!env.TARGET_URL) throw new Error('TARGET_URL is required');
  const target = new URL(env.TARGET_URL);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.search || target.hash) {
    throw new Error('TARGET_URL must be an HTTP(S) URL without credentials, query, or fragment');
  }
  const numeric = Object.fromEntries(Object.entries(NUMERIC_SETTINGS).map(([key, setting]) => [
    key, numberSetting(env, setting.env, setting.fallback, setting) * (setting.scale || 1),
  ]));
  const heartbeatMode = env.HEARTBEAT_MODE?.trim() || 'early';
  if (!['early', 'after-headers', 'off'].includes(heartbeatMode)) throw new Error('Invalid HEARTBEAT_MODE');
  const adminHosts = (env.ADMIN_HOSTS || '').split(',').map(host => host.trim().toLowerCase()).filter(Boolean);
  for (const host of adminHosts) {
    let parsed;
    try { parsed = new URL(`http://${host}`); } catch { /* sanitized below */ }
    if (!parsed || parsed.host !== host || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) throw new Error('Invalid ADMIN_HOSTS');
  }
  const allowUpstreamServiceWorkers = env.ALLOW_UPSTREAM_SERVICE_WORKERS?.trim() || 'false';
  if (!['true', 'false'].includes(allowUpstreamServiceWorkers)) throw new Error('Invalid ALLOW_UPSTREAM_SERVICE_WORKERS');
  if (allowUpstreamServiceWorkers === 'true' && env.ADMIN_TOKEN && !adminHosts.length) throw new Error('ADMIN_HOSTS is required to allow upstream service workers with ADMIN_TOKEN');
  const corsOrigins = (env.CORS_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
  for (const origin of corsOrigins) {
    let parsed;
    try { parsed = new URL(origin); } catch { /* sanitized below */ }
    if (!parsed || !['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) throw new Error('Invalid CORS_ORIGINS');
  }
  return {
    target,
    ...numeric,
    heartbeatMode,
    heartbeatRoutes: parseHeartbeatRoutes(env.HEARTBEAT_ROUTES),
    adminHosts,
    allowUpstreamServiceWorkers: allowUpstreamServiceWorkers === 'true',
    corsOrigins,
    keepaliveUrl: normalizeKeepaliveUrl(env.KEEPALIVE_URL || ''),
    keepaliveEnvLocks: { url: Boolean(env.KEEPALIVE_URL?.trim()), interval: Boolean(env.KEEPALIVE_INTERVAL?.trim()) },
    heartbeatPrefixes: (env.HEARTBEAT_PATH_PREFIXES || '').split(',').map(s => s.trim()).filter(Boolean),
    proxyToken: env.PROXY_TOKEN || '',
    adminToken: env.ADMIN_TOKEN || '',
    tempDirectory: env.TEMP_DIRECTORY || join(tmpdir(), 'render-ai-relay'),
  };
}

function parseHeartbeatRoutes(raw) {
  if (!raw?.trim()) return [];
  let rules;
  try { rules = JSON.parse(raw); } catch { throw new Error('Invalid HEARTBEAT_ROUTES JSON'); }
  if (!Array.isArray(rules) || rules.length > 64 || rules.some(rule =>
    !rule || typeof rule !== 'object' || Array.isArray(rule) || Object.keys(rule).some(key => !['prefix', 'mode'].includes(key)) ||
    typeof rule.prefix !== 'string' || !rule.prefix.startsWith('/') || /[\x00-\x20?#\x7f]/.test(rule.prefix) || rule.prefix.length > 256 ||
    !['early', 'after-headers', 'off'].includes(rule.mode))) throw new Error('Invalid HEARTBEAT_ROUTES');
  if (new Set(rules.map(rule => rule.prefix)).size !== rules.length) throw new Error('Duplicate HEARTBEAT_ROUTES prefix');
  return rules.sort((left, right) => right.prefix.length - left.prefix.length);
}

