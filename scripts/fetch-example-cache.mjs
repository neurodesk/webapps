#!/usr/bin/env node
// Fills the directory the interface audit reads with EXAMPLE_ASSET_CACHE:
//   node scripts/fetch-example-cache.mjs [directory] [--prune]
// It holds each app's first example and, for the apps the audit runs offline, the pinned files their page loads.
// SMOKE_APPS restricts it to the apps the audit would then run. --prune removes
// every entry the selected apps do not use, so it needs the whole catalogue.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadAppsRegistry, repoRoot } from './lib/apps-registry.mjs';
import { loadAppExamples } from './lib/app-examples.mjs';
import { auditedExampleFiles, auditedOfflineFiles, fillExampleCache } from './lib/example-asset-cache.mjs';
import { smokeApps } from './lib/smoke-apps.mjs';

const args = process.argv.slice(2);
const prune = args.includes('--prune');
const directory = args.find(arg => !arg.startsWith('--')) ?? process.env.EXAMPLE_ASSET_CACHE;
if (!directory) throw new Error('Name the cache directory as an argument or in EXAMPLE_ASSET_CACHE');
const { apps: selected, filtered } = smokeApps((await loadAppsRegistry()).apps);
if (prune && filtered) throw new Error('--prune would delete the other apps\' examples; run it without SMOKE_APPS');
const lock = JSON.parse(await readFile(join(repoRoot, 'registry/offline-assets.lock.json'), 'utf8'));
const { assets } = lock;
const files = [];
for (const app of selected) files.push(...auditedExampleFiles(await loadAppExamples(app)), ...auditedOfflineFiles(app, lock));
const megabytes = bytes => (bytes / 1e6).toFixed(1);
const summary = await fillExampleCache(files, {
  directory,
  assets,
  prune,
  onEvent: event => console.log(`Retry ${event.attempt} in ${Math.round(event.delay)} ms (${event.reason}): ${event.url}`),
});
console.log(`Example cache ${directory}: ${summary.reused.length + summary.downloaded.length} files, ${megabytes(summary.bytes)} MB for ${selected.length} apps; ` +
  `downloaded ${summary.downloaded.length} (${megabytes(summary.downloadedBytes)} MB), reused ${summary.reused.length}, pruned ${summary.pruned.length}`);
