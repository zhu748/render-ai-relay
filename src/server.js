import { createProxy, loadConfig } from './proxy.js';
import { VERSION } from './diagnostics.js';

let config;
try {
  config = loadConfig();
} catch (error) {
  // Do not echo environment values, which could contain secrets.
  console.error(`Configuration error: ${error.message}`);
  process.exit(1);
}

const { server, destroyAgents, beginShutdown, abortRequests, whenIdle } = createProxy(config);
server.on('error', error => {
  console.error(JSON.stringify({ event: 'server_error', code: error.code }));
  process.exitCode = 1;
});
server.listen(config.port, '0.0.0.0', () => {
  console.log(JSON.stringify({ event: 'listening', version: VERSION, port: server.address().port, heartbeat_seconds: config.heartbeatMs / 1000, diagnostics: '/__proxy/', admin_configured: Boolean(config.adminToken), keepalive_configured: Boolean(config.keepaliveUrl) }));
});

let stopping = false;
server.on('request', (_req, res) => {
  res.once('finish', () => {
    // A connection active during close() can become idle after its initial
    // sweep. Reap it after the full response has been flushed.
    if (stopping) server.closeIdleConnections();
  });
});
function shutdown() {
  if (stopping) return;
  stopping = true;
  beginShutdown();
  console.log('{"event":"shutdown"}');
  let terminate;
  const force = setTimeout(() => {
    // Fail buffered responses at a safe boundary before closing sockets. Give
    // clients and temp-file cleanup a brief opportunity to finish normally.
    console.log('{"event":"shutdown_grace_expired"}');
    abortRequests();
    terminate = setTimeout(() => {
      server.closeAllConnections();
      destroyAgents();
      process.exit(0);
    }, 1000);
    terminate.unref();
  }, config.shutdownGraceMs);
  force.unref();
  server.close(async () => {
    clearTimeout(force);
    await whenIdle();
    clearTimeout(terminate);
    destroyAgents();
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
