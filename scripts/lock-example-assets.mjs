#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { loadAppsRegistry, repoRoot } from './lib/apps-registry.mjs';
import { modelManifestAssets } from './lib/model-assets.mjs';

const directory = process.env.TMPDIR;
if (!directory) throw new Error('Set TMPDIR to the storage volume for example downloads.');
const cache = join(directory, 'webapps-example-assets');
await mkdir(cache, { recursive: true });
const sourcesPath = join(repoRoot, 'registry/offline-assets.sources.json');
const lockPath = join(repoRoot, 'registry/offline-assets.lock.json');
const sources = JSON.parse(await readFile(sourcesPath));
const lock = JSON.parse(await readFile(lockPath));
const manifests = [];
const assets = [];
for (const app of (await loadAppsRegistry()).apps) {
  const path = join(repoRoot, 'apps', app.id, 'examples.json');
  const examples = JSON.parse(await readFile(path));
  manifests.push({ app, path, examples });
  for (const example of examples) {
    for (const file of example.files) {
      if (!file.url.startsWith('https://')) throw new Error(`${app.id}: examples require HTTPS`);
      assets.push({ ...file, app: app.id, kind: 'example' });
    }
  }
}
for (const asset of await modelManifestAssets()) assets.push({ ...asset, kind: 'model' });
const pending = [...new Map(assets.map(file => [file.url, file])).values()];
await Promise.all(Array.from({ length: 4 }, async () => {
  while (pending.length) {
    const file = pending.shift();
    let asset = lock.assets[file.url];
    if (!asset) {
      const cachePath = join(cache, createHash('sha256').update(file.url).digest('hex'));
      let bytes;
      let contentType = 'application/octet-stream';
      try { bytes = await readFile(cachePath); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const response = await fetch(file.url, { signal: AbortSignal.timeout(180000) });
        if (!response.ok) throw new Error(`${response.status}: ${file.url}`);
        contentType = response.headers.get('content-type') || contentType;
        bytes = Buffer.from(await response.arrayBuffer());
        if (!bytes.length) throw new Error(`Empty example asset: ${file.url}`);
        await writeFile(cachePath, bytes);
      }
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      asset = { sha256, bytes: bytes.length, contentType, kind: file.kind, ...(file.license ? { license: file.license } : {}), dependencies: [] };
      lock.assets[file.url] = asset;
      console.log(`Locked ${file.name}: ${bytes.length} bytes`);
    }
  }
}));
for (const file of assets) {
  if (file.sha256 && file.sha256 !== lock.assets[file.url].sha256) throw new Error(`Checksum mismatch: ${file.url}`);
}
for (const file of assets) {
  const asset = lock.assets[file.url];
  const entry = sources.apps[file.app].find(item => item.url === file.url);
  if (entry) Object.assign(entry, { sha256: asset.sha256, bytes: asset.bytes });
  else sources.apps[file.app].push({ url: file.url, sha256: asset.sha256, bytes: asset.bytes, kind: file.kind, ...(file.license ? { license: file.license } : {}) });
  if (!lock.apps[file.app].includes(file.url)) lock.apps[file.app].push(file.url);
}
for (const { path, examples } of manifests) await writeFile(path, `${JSON.stringify(examples, null, 2)}\n`);
await writeFile(sourcesPath, `${JSON.stringify(sources, null, 2)}\n`);
await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
