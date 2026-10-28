import * as filesystem from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { ProxyError } from './errors.js';

const PREFIX = 'ai-relay-';
const MARKER = '.relay-owner.json';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function ownerAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

export function createTemporaryStorage(config, { logger = console, operations = {}, isOwnerAlive = ownerAlive } = {}) {
  const fs = { ...filesystem, ...operations };
  const owner = { format: 1, host: hostname(), pid: process.pid, instance: randomUUID() };
  const pending = new Map();
  const stats = { cleanup_failures: 0, recovered_directories: 0, free_bytes: null };
  let ready, timer, retrying, stopped = false, checkedAt = 0;

  function log(event, code) {
    try { logger.warn?.(JSON.stringify({ event, ...(code ? { code } : {}) })); } catch { /* best effort */ }
  }

  async function recover() {
    // Never remove unknown directories, symlinks, another host's files, or
    // anything belonging to a live/inaccessible PID (including PID reuse).
    const directory = await fs.opendir(config.tempDirectory);
    let scanned = 0;
    for await (const entry of directory) {
      if (++scanned > 1024) break;
      if (!entry.isDirectory() || !entry.name.startsWith(PREFIX)) continue;
      const path = join(config.tempDirectory, entry.name);
      try {
        const marker = join(path, MARKER);
        const info = await fs.lstat(marker);
        if (!info.isFile() || info.size > 1024) continue;
        const previous = JSON.parse(await fs.readFile(marker, 'utf8'));
        if (previous.format !== 1 || previous.host !== owner.host || typeof previous.instance !== 'string' ||
            !Number.isSafeInteger(previous.pid) || previous.pid <= 0 || isOwnerAlive(previous.pid)) continue;
        await fs.rm(path, { recursive: true, force: true });
        stats.recovered_directories++;
      } catch (error) { if (error.code !== 'ENOENT') log('temporary_file_recovery_failed', error.code); }
    }
  }

  async function initialize() {
    await fs.mkdir(config.tempDirectory, { recursive: true, mode: 0o700 });
    await recover();
  }

  async function ensureReady() {
    if (!ready) ready = initialize().catch(error => { ready = undefined; throw error; });
    await ready;
    // Recreate a temp root removed externally between requests.
    await fs.mkdir(config.tempDirectory, { recursive: true, mode: 0o700 });
  }

  async function checkSpace() {
    if (Date.now() - checkedAt < 1000) return;
    try {
      const info = await fs.statfs(config.tempDirectory);
      stats.free_bytes = info.bavail * info.bsize;
      checkedAt = Date.now();
    } catch (error) {
      if (!['ENOSYS', 'ENOTSUP'].includes(error.code)) throw error;
    }
    if (stats.free_bytes !== null && stats.free_bytes < config.tempMinFreeBytes) {
      // Recheck immediately on the next request so recovered space is usable.
      checkedAt = 0;
      throw new ProxyError(503, 'temporary_storage_low_space', 'Relay temporary storage has insufficient free space');
    }
  }

  function scheduleRetry() {
    if (stopped || timer || retrying || !pending.size) return;
    timer = setTimeout(() => {
      timer = undefined;
      retrying = retryPending().finally(() => { retrying = undefined; scheduleRetry(); });
    }, config.tempCleanupRetryMs);
    timer.unref();
  }

  async function remove(path, entry) {
    await fs.rm(path, { recursive: true, force: true });
    pending.delete(path);
    entry.release();
  }

  async function retryPending() {
    for (const [path, entry] of pending) {
      try { await remove(path, entry); }
      catch (error) { stats.cleanup_failures++; log('temporary_file_cleanup_failed', error.code); }
    }
  }

  return {
    writeStream(filename) { return (operations.createWriteStream || createWriteStream)(filename, { flags: 'wx', mode: 0o600 }); },
    readStream(filename) { return (operations.createReadStream || createReadStream)(filename); },
    async create() {
      let path;
      try {
        await ensureReady();
        if (pending.size >= (config.maxPendingTempCleanups ?? 64)) throw new ProxyError(503, 'temporary_storage_cleanup_backlog', 'Relay temporary storage cleanup backlog is full');
        await checkSpace();
        path = await fs.mkdtemp(join(config.tempDirectory, PREFIX));
        await fs.writeFile(join(path, MARKER), JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
        return path;
      } catch (error) {
        if (path) await this.cleanup(path);
        if (error instanceof ProxyError) throw error;
        throw new ProxyError(503, 'temporary_storage_unavailable', 'Relay temporary storage is unavailable');
      }
    },
    async cleanup(path, bytes = 0, release = () => {}) {
      const entry = { bytes, release };
      for (let attempt = 0; attempt < 3; attempt++) {
        try { await remove(path, entry); return; }
        catch (error) {
          if (attempt < 2) await pause(10 * (attempt + 1));
          else {
            stats.cleanup_failures++;
            log('temporary_file_cleanup_failed', error.code);
            pending.set(path, entry); scheduleRetry();
          }
        }
      }
    },
    status() {
      return { ...stats, pending_cleanup_directories: pending.size, max_pending_cleanup_directories: config.maxPendingTempCleanups ?? 64, pending_cleanup_bytes: [...pending.values()].reduce((sum, entry) => sum + entry.bytes, 0) };
    },
    async stop() {
      stopped = true; clearTimeout(timer);
      await retrying;
    },
  };
}
