#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { gzipSync } from 'node:zlib';
import { catalogApps, loadAppsRegistry, repoRoot } from './lib/apps-registry.mjs';
import { HUB_SITE, SITES_DIR } from './lib/catalog-sites.mjs';
import { validateAssetManifest } from './lib/scientific-assets.mjs';

// Per-file budget: GitHub Pages refuses files over 100 MB and Workers static assets over 25 MiB.
const maxFileBytes = 25 * 1024 * 1024;
const maxPagesSite = 750 * 1024 * 1024;
const defaultMaxAppSize = 100 * 1024 * 1024;
// Workers static assets take at most 20,000 files on the free plan.
const maxFileCount = 20_000;
const maxDuplicateRatio = 0.10;
const appFlag = process.argv.indexOf('--app');
const selectedApp = appFlag >= 0 ? process.argv[appFlag + 1] : null;

// One deployable root: the all-app assembly (dist/), a catalogue site
// (dist-sites/<id>) or a standalone app build (--app).
async function auditRoot(root, { scope, pagesBudget, apps }) {
  const forbidden = [];
  const oversized = [];
  const content = new Map();
  const walkedFiles = [];
  const appSizes = new Map();
  const prefix = `${relative(repoRoot, root)}/`;
  let totalBytes = 0;
  let compressedBytes = 0;
  let fileCount = 0;

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
        walkedFiles.push({ path, hash, size });
        if (!content.has(hash)) content.set(hash, size);
        const app = selectedApp || path.slice(prefix.length).match(/^([^/]+)\//)?.[1];
        if (app && app !== '_runtime') appSizes.set(app, (appSizes.get(app) || 0) + size);
        if (/\.(onnx|pt|pth|safetensors|nii(?:\.gz)?|mgh|mgz)$/i.test(entry.name)) forbidden.push(path);
        if (size > maxFileBytes) oversized.push(`${path} (${size} bytes)`);
      }
    }
  }

  await walk(root);
  const uniqueBytes = [...content.values()].reduce((sum, size) => sum + size, 0);
  const duplicateBytes = totalBytes - uniqueBytes;
  let intentionalRuntimeDuplicateBytes = 0;
  if (!selectedApp) {
    const runtimeManifest = JSON.parse(await readFile(join(repoRoot, 'runtime-assets', 'manifest.json'), 'utf8'));
    for (const app of apps) {
      for (const familyId of app.app_scoped_runtime_families) {
        const family = runtimeManifest.families.find((candidate) => candidate.id === familyId);
        if (!family) throw new Error(`${app.id} declares unknown app-scoped runtime family '${familyId}'`);
        let localCopies = 0;
        for (const runtimeFile of family.files) {
          const localCopy = walkedFiles.find((file) => (
            file.path.startsWith(`${prefix}${app.path}/`)
            && file.path.endsWith(`/${runtimeFile.name}`)
            && file.hash === runtimeFile.sha256
          ));
          if (localCopy) {
            intentionalRuntimeDuplicateBytes += localCopy.size;
            localCopies += 1;
          }
        }
        if (localCopies === 0) throw new Error(`${app.id} has no files from app-scoped runtime family '${familyId}'`);
      }
    }
  }
  const budgetDuplicateBytes = Math.max(0, duplicateBytes - intentionalRuntimeDuplicateBytes);
  const budgetErrors = [];
  if (pagesBudget && totalBytes > maxPagesSite) budgetErrors.push(`${scope} is ${totalBytes} bytes; the GitHub Pages budget is ${maxPagesSite}`);
  if (fileCount > maxFileCount) budgetErrors.push(`${scope} contains ${fileCount} files; budget is ${maxFileCount}`);
  if (!selectedApp && totalBytes && budgetDuplicateBytes / totalBytes > maxDuplicateRatio) {
    budgetErrors.push(`${scope}: undeclared duplicate content is ${(budgetDuplicateBytes / totalBytes * 100).toFixed(1)}%; budget is ${maxDuplicateRatio * 100}%`);
  }
  for (const [app, size] of appSizes) {
    const budget = registry.apps.find(candidate => candidate.path === app || candidate.id === app)?.artifact_budget_bytes ?? defaultMaxAppSize;
    if (size > budget) budgetErrors.push(`${app} is ${size} bytes; per-app budget is ${budget}`);
  }
  console.log(JSON.stringify({
    scope,
    apps: apps.length,
    files: fileCount,
    totalBytes,
    estimatedCompressedBytes: compressedBytes,
    duplicateBytes: budgetDuplicateBytes,
    duplicatePercent: totalBytes ? Number((budgetDuplicateBytes / totalBytes * 100).toFixed(1)) : 0,
    intentionalRuntimeDuplicateBytes,
    largestApps: [...appSizes].sort((a, b) => b[1] - a[1]).slice(0, 5),
  }, null, 2));
  return [
    forbidden.length ? `${scope}: scientific assets must live in immutable external manifests:\n${forbidden.join('\n')}` : '',
    oversized.length ? `${scope}: assets exceed the 25 MiB per-file budget:\n${oversized.join('\n')}` : '',
    budgetErrors.length ? `${scope}: capacity budget exceeded:\n${budgetErrors.join('\n')}` : '',
  ].filter(Boolean);
}

const registry = await loadAppsRegistry();
for (const app of registry.apps) await stat(join(repoRoot, 'apps', app.id, 'package.json'));
if (selectedApp && !registry.apps.some(({ id }) => id === selectedApp)) {
  throw new Error(`Unknown app '${selectedApp}'`);
}
const errors = [];
for (const app of registry.apps) {
  for (const error of await validateAssetManifest(repoRoot, app)) errors.push(`Invalid scientific asset manifest: ${app.id}: ${error}`);
}
if (selectedApp) {
  errors.push(...await auditRoot(join(repoRoot, 'apps', selectedApp, 'dist'), { scope: selectedApp, apps: [] }));
} else {
  // dist/ feeds the desktop suite; each catalogue site is what one host serves, and
  // only the GitHub Pages site has the Pages size budget.
  errors.push(...await auditRoot(join(repoRoot, 'dist'), { scope: 'composite', apps: registry.apps }));
  for (const catalog of registry.site.catalogs) {
    errors.push(...await auditRoot(join(repoRoot, SITES_DIR, catalog.id), {
      scope: catalog.host,
      pagesBudget: catalog.hosting === 'pages',
      apps: catalogApps(registry, catalog),
    }));
  }
  errors.push(...await auditRoot(join(repoRoot, SITES_DIR, HUB_SITE), { scope: registry.site.hub.host, apps: [] }));
}
if (errors.length) throw new Error(errors.join('\n\n'));
