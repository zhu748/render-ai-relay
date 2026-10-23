import { createProxy, loadConfig } from './proxy.js';

let config;
try {
  config = loadConfig();
} catch (error) {
  // Do not echo environment values, which could contain secrets.
  console.error(`Configuration error: ${error.message}`);
  process.exit(1);
}

const { server, destroyAgents } = createProxy(config);
server.on('error', error => {
  console.error(JSON.stringify({ event: 'server_error', code: error.code }));
  process.exitCode = 1;
});
server.listen(config.port, '0.0.0.0', () => {
  console.log(JSON.stringify({ event: 'listening', port: server.address().port, heartbeat_seconds: config.heartbeatMs / 1000 }));
});

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  console.log('{"event":"shutdown"}');
  const force = setTimeout(() => {
    server.closeAllConnections();
    destroyAgents();
    process.exit(0);
  }, 25_000);
  force.unref();
  server.close(() => {
    clearTimeout(force);
    destroyAgents();
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
