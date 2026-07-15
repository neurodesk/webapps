#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { gzipSync } from 'node:zlib';
import { loadAppsRegistry, repoRoot } from './lib/apps-registry.mjs';
import { validateAssetManifest } from './lib/scientific-assets.mjs';

const maxCloudflareAsset = 25 * 1024 * 1024;
const maxPagesSite = 750 * 1024 * 1024;
const maxAppSize = 100 * 1024 * 1024;
const maxFileCount = 20_000;
const maxDuplicateRatio = 0.10;
const forbidden = [];
const oversized = [];
const content = new Map();
const appSizes = new Map();
let totalBytes = 0;
let compressedBytes = 0;
let fileCount = 0;
const appFlag = process.argv.indexOf('--app');
const selectedApp = appFlag >= 0 ? process.argv[appFlag + 1] : null;

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) await walk(full);
    else {
      const path = relative(repoRoot, full);
      const bytes = await readFile(full);
      const size = bytes.length;
      totalBytes += size;
      compressedBytes += gzipSync(bytes).length;
      fileCount += 1;
      const hash = createHash('sha256').update(bytes).digest('hex');
      if (!content.has(hash)) content.set(hash, size);
      const app = selectedApp || path.match(/^dist\/([^/]+)\//)?.[1];
      if (app && app !== '_runtime') appSizes.set(app, (appSizes.get(app) || 0) + size);
      if (/\.(onnx|pt|pth|safetensors|nii(?:\.gz)?|mgh|mgz)$/i.test(entry.name)) forbidden.push(path);
      if (size > maxCloudflareAsset) oversized.push(`${path} (${size} bytes)`);
    }
  }
}

const registry = await loadAppsRegistry();
for (const app of registry.apps) await stat(join(repoRoot, 'apps', app.id, 'package.json'));
if (selectedApp && !registry.apps.some(({ id }) => id === selectedApp)) {
  throw new Error(`Unknown app '${selectedApp}'`);
}
await walk(selectedApp ? join(repoRoot, 'apps', selectedApp, 'dist') : join(repoRoot, 'dist'));
const manifestErrors = [];
for (const app of registry.apps) {
  for (const error of await validateAssetManifest(repoRoot, app)) manifestErrors.push(`${app.id}: ${error}`);
}
const uniqueBytes = [...content.values()].reduce((sum, size) => sum + size, 0);
const duplicateBytes = totalBytes - uniqueBytes;
const budgetErrors = [];
if (!selectedApp && totalBytes > maxPagesSite) budgetErrors.push(`site is ${totalBytes} bytes; budget is ${maxPagesSite}`);
if (fileCount > maxFileCount) budgetErrors.push(`site contains ${fileCount} files; budget is ${maxFileCount}`);
if (!selectedApp && totalBytes && duplicateBytes / totalBytes > maxDuplicateRatio) {
  budgetErrors.push(`duplicate content is ${(duplicateBytes / totalBytes * 100).toFixed(1)}%; budget is ${maxDuplicateRatio * 100}%`);
}
for (const [app, size] of appSizes) {
  if (size > maxAppSize) budgetErrors.push(`${app} is ${size} bytes; per-app budget is ${maxAppSize}`);
}

if (forbidden.length || oversized.length || manifestErrors.length || budgetErrors.length) {
  throw new Error([
    forbidden.length ? `Scientific assets must live in immutable external manifests:\n${forbidden.join('\n')}` : '',
    oversized.length ? `Assets exceed Cloudflare Pages' 25 MiB limit:\n${oversized.join('\n')}` : '',
    manifestErrors.length ? `Invalid scientific asset manifests:\n${manifestErrors.join('\n')}` : '',
    budgetErrors.length ? `Composite-site capacity budget exceeded:\n${budgetErrors.join('\n')}` : '',
  ].filter(Boolean).join('\n\n'));
}
console.log(JSON.stringify({
  apps: registry.apps.length,
  scope: selectedApp || 'composite',
  files: fileCount,
  totalBytes,
  estimatedCompressedBytes: compressedBytes,
  duplicateBytes,
  duplicatePercent: Number((duplicateBytes / totalBytes * 100).toFixed(1)),
  largestApps: [...appSizes].sort((a, b) => b[1] - a[1]).slice(0, 5),
}, null, 2));
