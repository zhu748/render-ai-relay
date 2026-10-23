import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import metadata from '../package.json' with { type: 'json' };

export const VERSION = metadata.version;
const page = readFileSync(new URL('./admin.html', import.meta.url));
const script = readFileSync(new URL('./admin.js', import.meta.url));
const MAX_EVENTS = 200;

function matches(actual, expected) {
  const left = Buffer.from(actual || '');
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function createDiagnostics(config, logger) {
  const active = new Map();
  const events = [];
  const started = performance.now();
  let probes = 0;
  let total = 0;

  function json(res, status, data, head = false) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(head ? undefined : JSON.stringify(data));
  }

  function begin(req, state) {
    const id = randomUUID();
    const received = performance.now();
    // No query, body, cookies, auth headers, or arbitrary header values.
    const base = { request_id: id, method: req.method, path: req.url.split('?', 1)[0].slice(0, 256) };
    const snapshot = () => ({ ...base, elapsed_ms: Math.round(performance.now() - received), ...state() });
    function event(name, details = {}, level = 'info') {
      const entry = { time: new Date().toISOString(), event: name, ...snapshot(), ...details };
      events.push(entry);
      if (events.length > MAX_EVENTS) events.shift();
      // Observability must not interrupt a working upstream request.
      try { logger[level]?.(JSON.stringify(entry)); } catch { /* retain the in-memory event */ }
    }
    active.set(id, snapshot);
    total++;
    event('request_received');
    return {
      id,
      event,
      end(outcome) {
        event('request_finished', { outcome });
        active.delete(id);
      },
    };
  }

  function probe(req, res) {
    const seconds = Number(new URL(req.url, 'http://relay.local').searchParams.get('seconds') ?? 10);
    if (!Number.isFinite(seconds) || seconds < 0.05 || seconds > 180) {
      json(res, 400, { error: 'seconds must be between 0.05 and 180' });
      return;
    }
    if (!config.heartbeatMs) {
      json(res, 400, { error: 'Enable HEARTBEAT_INTERVAL_SECONDS before testing heartbeats' });
      return;
    }
    if (probes >= 2) { json(res, 429, { error: 'At most two diagnostic probes may run concurrently' }); return; }
    probes++;
    const began = performance.now();
    let count = 0;
    let finished = false;
    let heartbeatTimer;
    const commit = () => {
      if (!res.headersSent) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store, no-transform', 'x-accel-buffering': 'no' });
        res.flushHeaders();
      }
    };
    const cleanup = () => {
      if (finished) return;
      finished = true;
      clearTimeout(heartbeatTimer);
      clearTimeout(endTimer);
      probes--;
    };
    const tick = () => {
      if (finished || res.destroyed || res.writableEnded) return;
      if (!res.writableNeedDrain && !res.writableLength) {
        commit();
        res.write('\n\n');
        count++;
      }
      heartbeatTimer = setTimeout(tick, config.heartbeatMs);
      heartbeatTimer.unref();
    };
    const endTimer = setTimeout(() => {
      if (res.destroyed) { cleanup(); return; }
      commit();
      res.end(JSON.stringify({ ok: true, probe: true, elapsed_ms: Math.round(performance.now() - began), heartbeats: count }));
      cleanup();
    }, seconds * 1000);
    endTimer.unref();
    heartbeatTimer = setTimeout(tick, config.firstHeartbeatMs);
    heartbeatTimer.unref();
    res.once('close', cleanup);
    res.on('error', cleanup);
  }

  function handle(req, res) {
    const path = req.url.split('?', 1)[0];
    if (path !== '/__proxy' && !path.startsWith('/__proxy/')) return false;
    req.resume();
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-frame-options', 'DENY');
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.setHeader('allow', 'GET, HEAD');
      json(res, 405, { error: 'Method not allowed' });
    } else if (path === '/__proxy' || path === '/__proxy/' || path === '/__proxy/admin.js') {
      res.setHeader('content-security-policy', "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
      res.writeHead(200, { 'content-type': path.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : path.endsWith('.js') ? script : page);
    } else if (!['/__proxy/status', '/__proxy/probe'].includes(path)) {
      json(res, 404, { error: 'Diagnostic route not found' }, req.method === 'HEAD');
    } else if (!config.adminToken) {
      json(res, 503, { error: '请在 Render 的 Environment 中设置 ADMIN_TOKEN，再重新部署。管理密钥与目标站 Key 无关。' }, req.method === 'HEAD');
    } else if (!matches(req.headers['x-admin-token'], config.adminToken)) {
      json(res, 401, { error: '管理密钥不正确，请填写 Render 环境变量 ADMIN_TOKEN 的值。' }, req.method === 'HEAD');
    } else if (path === '/__proxy/status') {
      json(res, 200, {
        version: VERSION,
        uptime_seconds: Math.floor((performance.now() - started) / 1000),
        target_origin: config.target.origin,
        heartbeat_interval_ms: config.heartbeatMs,
        first_heartbeat_ms: config.firstHeartbeatMs,
        upstream_timeout_ms: config.totalTimeoutMs,
        total_requests: total,
        active: [...active.values()].map(snapshot => snapshot()),
        events: events.slice().reverse(),
      }, req.method === 'HEAD');
    } else if (req.method === 'HEAD') {
      json(res, 200, { ok: true }, true);
    } else {
      probe(req, res);
    }
    return true;
  }

  return { begin, handle };
}
