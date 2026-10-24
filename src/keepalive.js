import http from 'node:http';
import https from 'node:https';
import { ProxyError } from './errors.js';

export function normalizeKeepaliveUrl(value) {
  if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)) {
    throw new ProxyError(400, 'invalid_keepalive_url', 'KEEPALIVE_URL must be an HTTP(S) URL');
  }
  const raw = value.trim();
  if (!raw) return '';
  let url;
  try { url = new URL(raw); } catch { /* return a sanitized error below */ }
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.href.length > 4096) {
    throw new ProxyError(400, 'invalid_keepalive_url', 'KEEPALIVE_URL must be an HTTP(S) URL without credentials or fragment, at most 4096 characters');
  }
  return url.href;
}

export function createKeepalive(config, { logger = console } = {}) {
  let url = config.keepaliveUrl;
  let intervalMs = config.keepaliveIntervalMs;
  let started = false;
  let generation = 0;
  let timer;
  let outgoing;
  let cancelAttempt;
  let result = {};

  function log(event, details = {}, level = 'info') {
    // URLs, query strings, response bodies and error messages may hold secrets.
    try { logger[level]?.(JSON.stringify({ event, ...details })); } catch { /* best effort */ }
  }

  function schedule(delay) {
    if (!started || !url) return;
    const current = generation;
    timer = setTimeout(() => {
      timer = undefined;
      if (current === generation) attempt(current);
    }, delay);
    timer.unref();
  }

  function attempt(current) {
    const began = performance.now();
    result.last_attempt_at = new Date().toISOString();
    result.attempts = (result.attempts || 0) + 1;
    let finished = false;
    let deadline;
    let request;
    function finish(status = null, code = null, cancelled = false) {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      if (outgoing === request) outgoing = undefined;
      if (cancelAttempt === cancel) cancelAttempt = undefined;
      if (cancelled || current !== generation) return;
      const ok = status !== null && status >= 200 && status < 300 && !code;
      result = {
        ...result,
        last_status: status,
        last_ok: ok,
        last_error_code: code || (ok ? null : 'keepalive_http_error'),
        last_duration_ms: Math.round(performance.now() - began),
        consecutive_failures: ok ? 0 : (result.consecutive_failures || 0) + 1,
      };
      log('keepalive_result', { ...result }, ok ? 'info' : 'warn');
      // Count the interval from completion: slow probes never overlap.
      schedule(intervalMs);
    }
    function cancel() {
      finish(null, null, true);
      request?.destroy();
    }
    cancelAttempt = cancel;
    deadline = setTimeout(() => {
      finish(null, 'keepalive_timeout');
      request?.destroy();
    }, config.keepaliveTimeoutMs);
    deadline.unref();
    try {
      const transport = new URL(url).protocol === 'https:' ? https : http;
      request = transport.request(url, {
        method: 'GET', agent: false,
        headers: { 'user-agent': 'render-ai-relay-keepalive', 'cache-control': 'no-cache, no-store', connection: 'close' },
      }, response => {
        response.on('error', () => {});
        finish(response.statusCode);
        // Only the HTTP status is needed. Never buffer a configured site's
        // large body or follow its redirects into another endpoint.
        response.destroy();
        request.destroy();
      });
      outgoing = request;
      request.on('error', error => finish(null, error.code || 'keepalive_connection_error'));
      request.end();
    } catch (error) {
      finish(null, error.code || 'keepalive_connection_error');
      request?.destroy();
    }
  }

  function stop() {
    const wasRunning = started && Boolean(url);
    started = false;
    generation++;
    clearTimeout(timer);
    timer = undefined;
    cancelAttempt?.();
    outgoing?.destroy();
    outgoing = undefined;
    if (wasRunning) log('keepalive_stopped');
  }

  function status() {
    return {
      configured: Boolean(url), running: started && Boolean(url),
      in_flight: Boolean(outgoing),
      interval_seconds: intervalMs / 1000, timeout_seconds: config.keepaliveTimeoutMs / 1000,
      attempts: 0, consecutive_failures: 0, last_attempt_at: null,
      last_status: null, last_ok: null, last_error_code: null, last_duration_ms: null,
      ...result,
    };
  }

  function settings() {
    return { url, interval_seconds: intervalMs / 1000, locked: { ...config.keepaliveEnvLocks }, status: status() };
  }

  return {
    start() {
      if (started) return;
      started = true;
      if (url) { log('keepalive_started', { interval_seconds: intervalMs / 1000 }); schedule(0); }
    },
    stop, status, settings,
    update(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['url', 'interval_seconds'].includes(key))) {
        throw new ProxyError(400, 'invalid_keepalive_settings', 'Expected url and interval_seconds');
      }
      const nextUrl = normalizeKeepaliveUrl(value.url);
      const interval = value.interval_seconds;
      if (!Number.isSafeInteger(interval) || interval < 5 || interval > 86400) {
        throw new ProxyError(400, 'invalid_keepalive_interval', 'KEEPALIVE_INTERVAL must be an integer from 5 to 86400 seconds');
      }
      if ((config.keepaliveEnvLocks.url && nextUrl !== url) || (config.keepaliveEnvLocks.interval && interval * 1000 !== intervalMs)) {
        throw new ProxyError(409, 'keepalive_environment_locked', 'KEEPALIVE_URL / KEEPALIVE_INTERVAL are managed by non-empty environment variables; edit them and restart');
      }
      const wasStarted = started;
      stop();
      url = nextUrl;
      intervalMs = interval * 1000;
      result = {};
      if (wasStarted) {
        started = true;
        if (url) { log('keepalive_started', { interval_seconds: interval }); schedule(0); }
      }
      return settings();
    },
  };
}
