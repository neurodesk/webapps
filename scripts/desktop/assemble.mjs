import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadAppsRegistry, repoRoot } from '../lib/apps-registry.mjs';
import { loadStandalone } from '../lib/standalone.mjs';
import { renderLandingPage } from '../lib/landing-page.mjs';
import { stagePython } from './stage-python.mjs';
import { verifyBundle, inventoryFiles } from '../../packages/desktop/src/bundle.js';

const argument = name => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const registry = await loadAppsRegistry();
await loadStandalone(registry);
const id = argument('--app');
const apps = id ? registry.apps.filter(app => app.id === id) : registry.apps;
if (!apps.length) throw new Error(`Unknown app: ${id}`);
const destination = resolve(argument('--out') || join(repoRoot, 'packages/desktop/resources'));
const cache = process.env.NEURODESK_ASSET_CACHE || join(repoRoot, '.offline-cache');
const lock = JSON.parse(await readFile(join(repoRoot, 'registry/offline-assets.lock.json')));
const sources = JSON.parse(await readFile(join(repoRoot, 'registry/offline-assets.sources.json')));
const version = JSON.parse(await readFile(join(repoRoot, 'packages/desktop/package.json'))).version;
await rm(destination, { recursive: true, force: true });
await mkdir(join(destination, 'site'), { recursive: true });
await mkdir(join(destination, 'assets'), { recursive: true });
await cp(join(repoRoot, 'packages/desktop/STANDALONE.md'), join(destination, 'STANDALONE.md'));
await cp(join(repoRoot, 'packages/desktop/jobs'), join(destination, 'jobs'), { recursive: true });
const assets = {};
const add = async url => {
  if (assets[url]) return;
  const asset = lock.assets[url];
  if (!asset) throw new Error(`Missing offline lock entry: ${url}`);
  assets[url] = { ...asset, path: `assets/${asset.sha256}` };
  await cp(join(cache, asset.sha256), join(destination, 'assets', asset.sha256));
  for (const dependency of asset.dependencies || []) await add(dependency);
};
for (const app of apps) {
  if (!lock.apps[app.id] || lock.apps[app.id].length !== sources.apps[app.id].length) throw new Error(`${app.id}: offline inventory is incomplete`);
  await cp(join(repoRoot, 'dist', app.path), join(destination, 'site', app.path), { recursive: true });
  for (const url of lock.apps[app.id]) await add(url);
}
// Composite resources retain their relative URLs and worker adjacency.
for (const entry of await readdir(join(repoRoot, 'dist'), { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name === '_runtime' || entry.name === 'shell-adapters') {
    await cp(join(repoRoot, 'dist', entry.name), join(destination, 'site', entry.name), { recursive: true });
  }
}
await writeFile(join(destination, 'site/index.html'), renderLandingPage({ ...registry, apps }));
await stagePython({ destination, apps, sources, lock, cache, root: repoRoot, assets });
// Offline builds contain no analytics bootstrap or remote update checks.
async function disableAnalytics(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await disableAnalytics(path);
    else if (entry.name.endsWith('.html')) {
      const html = await readFile(path, 'utf8');
      await writeFile(path, html.replace(/<script\b[^>]*src=["'][^"']*(?:cloudflareinsights|googletagmanager)[^"']*["'][^>]*>[\s\S]*?<\/script>/gi, ''));
    }
    else if (entry.name === 'analytics.js') await writeFile(path, 'export function initAnalytics() { return { enabled: false, reason: "offline" }; }\n');
  }
}
await disableAnalytics(join(destination, 'site'));
const files = await inventoryFiles(destination);
await writeFile(join(destination, 'manifest.json'), `${JSON.stringify({ schemaVersion: 1, version, defaultApp: id || null, apps: apps.map(({ id, path, title }) => ({ id, path, title })), assets, files }, null, 2)}\n`);
console.log(await verifyBundle(destination));
