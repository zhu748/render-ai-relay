import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { NUMERIC_SETTINGS, loadConfig } from '../src/config.js';

const [example, readme, blueprint] = await Promise.all(['.env.example', 'README.md', 'render.yaml'].map(file => readFile(new URL(`../${file}`, import.meta.url), 'utf8')));
const variables = new Set([...example.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map(match => match[1]));
const defaults = loadConfig({ TARGET_URL: 'https://config-check.example' });
for (const [name, setting] of Object.entries(NUMERIC_SETTINGS)) {
  assert.ok(variables.has(setting.env), `${setting.env} missing from .env.example`);
  assert.ok(readme.includes('`' + setting.env + '`'), `${setting.env} missing from README`);
  const entry = new RegExp(`- key: ${setting.env}\\s+value: "([^"]*)"`).exec(blueprint);
  if (entry) assert.equal(Number(entry[1]), defaults[name] / (setting.scale || 1), `${setting.env} Blueprint default differs`);
}
for (const name of ['HEARTBEAT_MODE', 'HEARTBEAT_ROUTES', 'ADMIN_HOSTS', 'ALLOW_UPSTREAM_SERVICE_WORKERS', 'CORS_ORIGINS']) {
  assert.ok(variables.has(name), `${name} missing from .env.example`);
  assert.ok(readme.includes('`' + name + '`'), `${name} missing from README`);
}
for (const [, name] of blueprint.matchAll(/- key: ([A-Z][A-Z0-9_]*)/g)) {
  assert.ok(['NODE_VERSION', 'NODE_ENV'].includes(name) || variables.has(name), `Unknown Blueprint setting ${name}`);
}
console.log('Configuration examples, numeric defaults and documentation agree.');
