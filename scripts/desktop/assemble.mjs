import { createWriteStream } from 'node:fs';
import { access, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { catalogApps, loadAppsRegistry, repoRoot } from '../lib/apps-registry.mjs';
import { loadAppInformation } from '../lib/app-information.mjs';
import { projectCatalogSite } from '../lib/catalog-sites.mjs';
import { loadNotFoundTemplate } from '../lib/not-found-page.mjs';
import { loadStandalone } from '../lib/standalone.mjs';
import { stagePython } from './stage-python.mjs';
import { suiteCatalog } from './suite.mjs';
import { fileHash, verifyBundle, inventoryFiles } from '../../packages/desktop/src/bundle.js';

// What only a web host serves: its 404 redirects, header rules and Pages marker.
const HOSTING_FILES = ['404.html', '_headers', '.nojekyll'];

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

/**
 * Puts a locked asset in the cache unless it is there: the whole cache is larger
 * than GitHub's 10 GB cache limit, so each suite fetches only its own assets.
 */
async function cached(cache, url, sha256) {
  const path = join(cache, sha256);
  if (await access(path).then(() => true, () => false)) return;
  await mkdir(cache, { recursive: true });
  const partial = `${path}.partial`;
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(300000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
      const received = await fileHash(partial);
      if (received !== sha256) throw new Error(`checksum mismatch, expected ${sha256}, received ${received}`);
      await rename(partial, path);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  await rm(partial, { force: true });
  throw new Error(`${url}: ${lastError.message}`);
}

/**
 * One catalogue's offline resources: its site as its host serves it (the apps,
 * themed with its brand and a handoff menu of the suite's apps, its landing
 * page and the runtime families they reach), projected from the all-app `dist`,
 * plus the offline assets and Python of those apps. `ids` limits the suite to
 * some of the catalogue's apps.
 */
export async function assembleSuite({ registry, catalog, ids, destination, dist = join(repoRoot, 'dist'), cache, lock, sources, standalone, information, version }) {
  const served = catalogApps(registry, catalog);
  const unknown = ids?.filter(id => !served.some(app => app.id === id));
  if (unknown?.length) throw new Error(`Not in the ${catalog.id} catalogue: ${unknown.join(', ')}`);
  const apps = ids ? served.filter(app => ids.includes(app.id)) : served;
  await rm(destination, { recursive: true, force: true });
  await mkdir(join(destination, 'assets'), { recursive: true });
  await cp(join(repoRoot, 'packages/desktop/STANDALONE.md'), join(destination, 'STANDALONE.md'));
  await cp(join(repoRoot, 'packages/desktop/AUTOMATION.md'), join(destination, 'AUTOMATION.md'));
  await cp(join(repoRoot, 'packages/desktop/jobs'), join(destination, 'jobs'), { recursive: true });
  const assets = {};
  const built = new Map(Object.values(sources.apps).flat().filter(source => source.path).map(source => [source.url, source]));
  const add = async url => {
    if (assets[url]) return;
    const source = built.get(url);
    if (source) {
      const path = join(repoRoot, source.path);
      const sha256 = await fileHash(path);
      await cp(path, join(destination, 'assets', sha256));
      assets[url] = { path: `assets/${sha256}`, sha256, bytes: (await stat(path)).size, kind: source.kind, contentType: source.contentType };
      return;
    }
    const asset = lock.assets[url];
    if (!asset) throw new Error(`Missing offline lock entry: ${url}`);
    assets[url] = { ...asset, path: `assets/${asset.sha256}` };
    await cached(cache, url, asset.sha256);
    await cp(join(cache, asset.sha256), join(destination, 'assets', asset.sha256));
    for (const dependency of asset.dependencies || []) await add(dependency);
  };
  for (const app of apps) {
    if (!lock.apps[app.id] || lock.apps[app.id].length !== sources.apps[app.id].length) throw new Error(`${app.id}: offline inventory is incomplete`);
    for (const url of lock.apps[app.id]) await add(url);
  }
  const site = join(destination, 'site');
  await projectCatalogSite({
    repoRoot,
    siteDist: dist,
    destination: site,
    registry: { ...registry, apps },
    catalog,
    information,
    standalone,
    notFoundTemplate: await loadNotFoundTemplate(repoRoot),
  });
  for (const name of HOSTING_FILES) await rm(join(site, name), { force: true });
  await stagePython({ destination, apps, sources, lock, cache });
  await disableAnalytics(site);
  const files = await inventoryFiles(destination);
  const manifest = {
    schemaVersion: 1,
    version,
    catalog: catalog.id,
    defaultApp: ids?.length === 1 ? ids[0] : null,
    apps: apps.map(({ id, path, title }) => ({ id, path, title })),
    assets,
    files,
  };
  await writeFile(join(destination, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return verifyBundle(destination);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argument = name => {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : undefined;
  };
  const registry = await loadAppsRegistry();
  console.log(await assembleSuite({
    registry,
    catalog: suiteCatalog(registry, argument('--catalog')),
    ids: argument('--app')?.split(','),
    destination: resolve(argument('--out') || join(repoRoot, 'packages/desktop/resources')),
    cache: process.env.NEURODESK_ASSET_CACHE || join(repoRoot, '.offline-cache'),
    lock: JSON.parse(await readFile(join(repoRoot, 'registry/offline-assets.lock.json'))),
    sources: JSON.parse(await readFile(join(repoRoot, 'registry/offline-assets.sources.json'))),
    standalone: await loadStandalone(registry),
    information: await loadAppInformation(registry),
    version: JSON.parse(await readFile(join(repoRoot, 'packages/desktop/package.json'))).version,
  }));
}
