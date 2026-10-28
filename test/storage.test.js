import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile, writeFile, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTemporaryStorage } from '../src/storage.js';
import { classifyError } from '../src/errors.js';

async function fixture(t, operations = {}, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'storage-test-'));
  const config = { tempDirectory: root, tempMinFreeBytes: 0, tempCleanupRetryMs: 50 };
  const storage = createTemporaryStorage(config, { logger: { warn() {} }, operations, ...options });
  t.after(async () => { await storage.stop(); await rm(root, { recursive: true, force: true }); });
  return { root, config, storage };
}

test('cleanup retries retain budget until deletion succeeds and then release it once', async t => {
  let fail = true, released = 0;
  const f = await fixture(t, { async rm(...args) { if (fail) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); return rm(...args); } });
  const directory = await f.storage.create();
  await writeFile(join(directory, 'response'), 'private response');
  await f.storage.cleanup(directory, 16, () => released++);
  assert.equal(released, 0);
  assert.equal(f.storage.status().pending_cleanup_bytes, 16);
  fail = false;
  const deadline = Date.now() + 2000;
  while (f.storage.status().pending_cleanup_directories && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(released, 1);
  assert.deepEqual(await readdir(f.root), []);
  assert.equal(f.storage.status().pending_cleanup_bytes, 0);
});

test('recovery removes marked dead-owner files and preserves live, unknown and symlinked directories', async t => {
  const f = await fixture(t);
  const dead = await f.storage.create();
  const marker = JSON.parse(await readFile(join(dead, '.relay-owner.json'), 'utf8'));
  await writeFile(join(dead, '.relay-owner.json'), JSON.stringify({ ...marker, pid: 123456789 }));
  await writeFile(join(dead, 'response'), 'orphaned content');
  const unknown = join(f.root, 'ai-relay-unknown');
  await mkdir(unknown);
  const live = await f.storage.create();
  const link = join(f.root, 'ai-relay-link');
  await symlink(unknown, link);
  const other = createTemporaryStorage(f.config, { logger: { warn() {} }, isOwnerAlive: pid => pid !== 123456789 });
  t.after(() => other.stop());
  const current = await other.create();
  assert.equal(other.status().recovered_directories, 1);
  const paths = await readdir(f.root);
  assert.ok(!paths.includes(dead.split('/').at(-1)));
  for (const path of [unknown, live, link, current]) assert.ok(paths.includes(path.split('/').at(-1)));
});

test('low disk space fails with a recoverable local error before accepting response data', async t => {
  let available = 0;
  const f = await fixture(t, { async statfs() { return { bavail: available, bsize: 4096 }; } });
  f.config.tempMinFreeBytes = 4096;
  await assert.rejects(f.storage.create(), { status: 503, code: 'temporary_storage_low_space' });
  assert.deepEqual(await readdir(f.root), []);
  available = 100;
  const path = await f.storage.create();
  await f.storage.cleanup(path);
  assert.equal(f.storage.status().free_bytes, 409600);
});

test('filesystem errors are sanitized and distinguish storage faults from upstream failures', () => {
  for (const code of ['ENOSPC', 'EDQUOT', 'EIO', 'EACCES', 'EMFILE']) {
    const error = classifyError(Object.assign(new Error('/private/path'), { code }), 'buffering_json');
    assert.equal(error.status, 503);
    assert.equal(error.code, 'temporary_storage_unavailable');
    assert.ok(!error.message.includes('/private/path'));
  }
  assert.equal(classifyError({ code: 'ECONNRESET' }, 'buffering_json').code, 'upstream_connection_error');
  assert.equal(classifyError({ code: 'EACCES' }, 'waiting_headers').status, 502);
});

test('cleanup failures cannot create an unbounded queue of small response files', async t => {
  const f = await fixture(t, { async rm() { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); } });
  f.config.maxPendingTempCleanups = 1;
  const path = await f.storage.create();
  await f.storage.cleanup(path, 1);
  await assert.rejects(f.storage.create(), { status: 503, code: 'temporary_storage_cleanup_backlog' });
  assert.equal(f.storage.status().pending_cleanup_directories, 1);
});
