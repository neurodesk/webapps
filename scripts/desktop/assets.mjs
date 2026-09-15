import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { canonicalUrl, fileHash } from '../../packages/desktop/src/bundle.js';

const root = resolve(import.meta.dirname, '../..');
const cache = process.env.NEURODESK_ASSET_CACHE || join(root, '.offline-cache');
const lockPath = join(root, 'registry/offline-assets.lock.json');
const refresh = process.argv.includes('--refresh');
const sources = JSON.parse(await readFile(join(root, 'registry/offline-assets.sources.json')));
let previous = { schemaVersion: 1, assets: {}, apps: {} };
try { previous = JSON.parse(await readFile(lockPath)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const assets = refresh ? {} : previous.assets;
const apps = {};
const tasks = new Map();
const failures = [];
await mkdir(cache, { recursive: true });

async function acquire(source) {
  const url = canonicalUrl(source.url);
  if (tasks.has(url)) return tasks.get(url);
  const task = (async () => {
    const expected = previous.assets[url]?.sha256 || source.sha256;
    if (!refresh && !expected) throw new Error(`Asset is not locked: ${url}`);
    let path = expected && join(cache, expected);
    let valid = false;
    if (path) {
      try { valid = await fileHash(path) === expected; } catch { valid = false; }
    }
    let contentType = previous.assets[url]?.contentType;
    if (!valid) {
      console.log(`Fetching ${url}`);
      let lastError;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response = await fetch(url, { signal: AbortSignal.timeout(300000) });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          contentType = response.headers.get('content-type');
          const temporary = join(cache, `${createHash('sha256').update(url).digest('hex')}.partial`);
          await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
          const sha256 = await fileHash(temporary);
          if (expected && expected !== sha256) throw new Error(`Checksum mismatch, expected ${expected}, received ${sha256}`);
          path = join(cache, sha256);
          await rename(temporary, path);
          lastError = null;
          break;
        } catch (error) { lastError = error; }
      }
      if (lastError) throw new Error(`${url}: ${lastError.message}`);
    }
    const sha256 = basename(path);
    const bytes = (await stat(path)).size;
    assets[url] = { sha256, bytes, contentType, kind: source.kind || 'dependency', ...(source.license ? { license: source.license } : {}) };
    const children = [];
    if (bytes < 8_000_000 && (url.endsWith('.js') || url.endsWith('.mjs') || url.endsWith('/+esm'))) {
      const text = await readFile(path, 'utf8');
      // Static imports plus worker/dynamic-import relative module filenames.
      for (const match of text.matchAll(/['"]((?:\.\.?\/|\/npm\/)[^'"\s]+\.(?:m?js)(?:\?[^'"\s]*)?)['"]/g)) {
        children.push({ url: new URL(match[1], url).href, kind: 'runtime' });
      }
    }
    if (bytes < 8_000_000 && (url.endsWith('.css') || contentType?.startsWith('text/css'))) {
      const css = await readFile(path, 'utf8');
      for (const match of css.matchAll(/url\(['"]?([^'"\s)]+)['"]?\)/g)) {
        if (!match[1].startsWith('data:')) children.push({ url: new URL(match[1], url).href, kind: 'font' });
      }
    }
    if (url.includes('connectomes/') && url.endsWith('.json')) {
      const json = JSON.parse(await readFile(path, 'utf8'));
      for (const shard of json.shards || []) {
        if (!shard.sourceUrl) throw new Error(`Connectome shard has no sourceUrl: ${url}`);
        children.push({ url: shard.sourceUrl, sha256: shard.checksum?.replace('sha256:', ''), kind: 'connectome-shard' });
      }
    }
    const dependencies = [];
    for (const child of children) {
      if (canonicalUrl(child.url) === url) continue;
      await acquire(child);
      dependencies.push(canonicalUrl(child.url));
    }
    assets[url].dependencies = [...new Set(dependencies)].sort();
    return url;
  })();
  tasks.set(url, task);
  return task;
}

// Limit concurrent large model fetches while retaining completed downloads.
for (const [id, entries] of Object.entries(sources.apps)) {
  apps[id] = [];
  for (let offset = 0; offset < entries.length; offset += 4) {
    await Promise.all(entries.slice(offset, offset + 4).map(async source => {
      try { apps[id].push(await acquire(source)); }
      catch (error) { failures.push({ app: id, url: source.url, error: error.message }); }
    }));
  }
  apps[id].sort();
  console.log(`${id}: ${apps[id].length}/${entries.length} source assets`);
}
const lock = { schemaVersion: 1, assets: Object.fromEntries(Object.entries(assets).sort(([a], [b]) => a.localeCompare(b))), apps };
if (refresh) await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
await writeFile(join(cache, 'failures.json'), `${JSON.stringify(failures, null, 2)}\n`);
if (failures.length) {
  console.error(JSON.stringify(failures, null, 2));
  process.exitCode = 1;
} else console.log(`Verified ${Object.keys(assets).length} offline assets.`);
