import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { join } from 'node:path';
import { bundlePath, fileHash } from './bundle.js';

// Only manifest-listed models can use the network. Requests never contain user data.
export function createModelResolver(root, bundle, cache, { pack, fetchModel = globalThis.fetch } = {}) {
  const pending = new Map();
  const valid = async (path, record) => {
    try { return (await stat(path)).size === record.bytes && await fileHash(path) === record.sha256; }
    catch { return false; }
  };
  // The pack is read-only and may be shared between users, so a hit is served
  // in place instead of being copied into this profile's cache.
  async function packed(record) {
    if (!pack) return null;
    const path = join(pack, record.sha256);
    return await valid(path, record) ? path : null;
  }
  async function cached(record, write) {
    const path = join(cache, record.sha256);
    if (!pending.has(path)) {
      const work = (async () => {
        await mkdir(cache, { recursive: true });
        if (await valid(path, record)) return path;
        const temporary = `${path}.${randomUUID()}.partial`;
        try {
          await write(temporary);
          if (!await valid(temporary, record)) throw new Error('Downloaded model failed integrity verification');
          await rm(path, { force: true });
          await rename(temporary, path);
          return path;
        } finally { await rm(temporary, { force: true }); }
      })();
      pending.set(path, work);
      work.finally(() => pending.delete(path)).catch(() => {});
    }
    return pending.get(path);
  }
  async function asset(url) {
    const record = bundle.assets[url];
    if (!record) throw new Error('Model is not listed in this installation');
    if (!record.remote) return bundlePath(root, record.path);
    if (bundle.modelsIncluded !== false || record.kind !== 'model') throw new Error('Model downloads are disabled');
    return await packed(record) ?? cached(record, async temporary => {
      const response = await fetchModel(url, { signal: AbortSignal.timeout(600000) });
      if (!response.ok || !response.body) throw new Error(`Model download failed: HTTP ${response.status}`);
      let bytes = 0;
      const limit = new Transform({
        transform(chunk, _encoding, callback) {
          bytes += chunk.length;
          callback(bytes > record.bytes ? new Error('Downloaded model exceeds its expected size') : null, chunk);
        },
      });
      await pipeline(response.body, limit, createWriteStream(temporary, { flags: 'wx' }));
    });
  }
  async function file(path) {
    const record = bundle.files?.[path];
    if (!record?.remote) return bundlePath(root, path);
    const whole = await packed(record);
    if (whole) return whole;
    const source = await asset(record.remote.url);
    return cached(record, temporary => pipeline(
      createReadStream(source, { start: record.remote.offset, end: record.remote.offset + record.bytes - 1 }),
      createWriteStream(temporary, { flags: 'wx' }),
    ));
  }
  return { asset, file };
}
