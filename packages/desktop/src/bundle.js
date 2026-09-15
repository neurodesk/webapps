import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat, readdir, lstat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export function canonicalUrl(value) {
  const url = new URL(value);
  url.hash = '';
  // These parameters control caching/download headers, never the asset bytes.
  for (const key of ['sha256', 'download', 'raw']) url.searchParams.delete(key);
  url.searchParams.sort();
  return url.href;
}

export function bundlePath(root, path) {
  if (typeof path !== 'string' || path.includes('\0') || isAbsolute(path)) throw new Error('Invalid bundle path');
  const target = resolve(root, path);
  const child = relative(resolve(root), target);
  if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new Error('Path escapes offline bundle');
  return target;
}

export async function fileHash(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function loadBundle(root) {
  const bundle = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
  if (bundle.schemaVersion !== 1 || !Array.isArray(bundle.apps) || !bundle.apps.length || !bundle.assets) throw new Error('Invalid offline bundle manifest');
  const ids = new Set();
  for (const app of bundle.apps) {
    if (!/^[a-z][a-z0-9-]*$/.test(app.id) || ids.has(app.id)) throw new Error('Invalid or duplicate offline app');
    ids.add(app.id);
    bundlePath(root, `site/${app.path}/index.html`);
  }
  for (const [url, asset] of Object.entries(bundle.assets)) {
    if (canonicalUrl(url) !== url) throw new Error(`Noncanonical asset URL: ${url}`);
    bundlePath(root, asset.path);
    if (!/^[a-f0-9]{64}$/.test(asset.sha256) || !Number.isSafeInteger(asset.bytes) || asset.bytes < 0) throw new Error(`Unverified asset: ${url}`);
    if (asset.remote && (bundle.modelsIncluded !== false || asset.kind !== 'model')) throw new Error('Only models in the package without models can be downloaded');
  }
  for (const [path, record] of Object.entries(bundle.files || {})) {
    bundlePath(root, path);
    if (!/^[a-f0-9]{64}$/.test(record.sha256) || !Number.isSafeInteger(record.bytes) || record.bytes < 0) throw new Error(`Unverified file: ${path}`);
    if (!record.remote) continue;
    const source = bundle.assets[record.remote.url];
    if (bundle.modelsIncluded !== false || !source?.remote || !Number.isSafeInteger(record.remote.offset) || record.remote.offset < 0 || record.remote.offset + record.bytes > source.bytes) throw new Error('Invalid downloadable model file');
  }
  return bundle;
}

export async function inventoryFiles(root, directory = 'site') {
  const files = {};
  async function visit(path) {
    for (const entry of await readdir(bundlePath(root, path), { withFileTypes: true })) {
      const child = `${path}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`Symlinks are not supported in offline resources: ${child}`);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) files[child] = { sha256: await fileHash(bundlePath(root, child)), bytes: (await stat(bundlePath(root, child))).size };
    }
  }
  await visit(directory);
  return files;
}

export async function verifyBundle(root) {
  const bundle = await loadBundle(root);
  const checked = new Set();
  for (const app of bundle.apps) await stat(bundlePath(root, `site/${app.path}/index.html`));
  for (const asset of [...Object.values(bundle.assets), ...Object.entries(bundle.files || {}).map(([path, record]) => ({ ...record, path }))]) {
    if (asset.remote) {
      const present = await lstat(bundlePath(root, asset.path)).then(() => true, error => {
        if (error.code === 'ENOENT') return false;
        throw error;
      });
      if (present) throw new Error(`Model unexpectedly included in the package without models: ${asset.path}`);
      continue;
    }
    if (checked.has(asset.path)) continue;
    const path = bundlePath(root, asset.path);
    const details = await lstat(path);
    if (!details.isFile()) throw new Error(`Offline resource is not a regular file: ${asset.path}`);
    if (details.size !== asset.bytes || await fileHash(path) !== asset.sha256) throw new Error(`Offline asset is missing or corrupt: ${asset.path}`);
    checked.add(asset.path);
  }
  return { apps: bundle.apps.map(app => app.id), assets: new Set(Object.values(bundle.assets).map(asset => asset.path)).size, files: Object.keys(bundle.files || {}).length };
}
