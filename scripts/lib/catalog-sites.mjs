import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { appUrl, catalogApps, findCatalog } from './apps-registry.mjs';
import { appInformationPayload } from './app-information.mjs';
import { injectCompositeTheme } from './composite-theme.mjs';
import { renderHubPage } from './hub-page.mjs';
import { renderLandingPage } from './landing-page.mjs';
import { renderNotFoundPage } from './not-found-page.mjs';
import { writeCompositeRuntimeCacheManifests } from './runtime-cache.mjs';
import { headersFile } from './vite-app-config.mjs';

// Each catalogue's deployable site, and the hub's, beside the all-app `dist/`
// that the desktop suite assembles from.
export const SITES_DIR = 'dist-sites';
export const HUB_SITE = 'hub';

// Files every hosted app page loads from the site root (scripts/build-site.mjs).
export const SHARED_ROOT_FILES = [
  'app-theme.css',
  'theme.js',
  'app-shell.js',
  'shell-adapters',
  'analytics.js',
  'neurodesk-logo.svg',
  'sciget-logo.svg',
  'fonts',
  'landing.css',
  'landing.js',
];
// Served only by the primary catalogue: the Vessel Surfer game.
const PRIMARY_ROOT_FILES = ['surf'];

const TEXT_EXTENSIONS = new Set(['.html', '.js', '.mjs', '.css']);
const RUNTIME_DIRECTORY = '_runtime';
const RUNTIME_LITERAL = /(['"`])([^'"`\n]*?_runtime\/[^'"`\n]*?)\1/g;
const RELATIVE_LITERAL = /(['"`])((?:\.\.?\/)+[^'"`\s]*?)\1/g;
const RUNTIME_MENTION = /_runtime\//g;

function posix(path) {
  return path.split(sep).join('/');
}

async function walk(directory, files = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path, files);
    else files.push(path);
  }
  return files;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * The theme options of an app on one host that serves it (its home catalogue by
 * default); `siteAppIds` limits its handoff menu.
 */
export function hostedThemeOptions({ registry, information, app, version, siteAppIds, catalog = findCatalog(registry, app.catalog) }) {
  return {
    appId: app.id,
    shell: app.shell,
    title: app.title,
    description: app.description,
    version,
    measurementId: registry.site.analytics.measurement_id,
    url: appUrl(registry, app, catalog),
    siteTitle: catalog.title,
    brandName: catalog.brand.name,
    moreAppsLabel: catalog.brand.more_apps,
    iconHref: `../${catalog.brand.logo}`,
    information: appInformationPayload(information, app.id, siteAppIds),
    standaloneHref: '../standalone.json',
    componentsHref: '../shell-adapters/components/',
  };
}

/**
 * The shared-runtime paths a text file names. Every mention of `_runtime/` must
 * sit in one string literal, so a computed reference fails the build instead of
 * shipping a site that misses the file it loads.
 */
export function runtimeReferences(source, file, siteDir) {
  const label = posix(relative(siteDir, file));
  const target = (literal) => {
    const path = literal.split(/[?#]/)[0];
    return path.startsWith('/') ? join(siteDir, path) : resolve(dirname(file), path);
  };
  // Vite's preload table is relative to the app base, one level above assets/.
  const preloadTables = [...source.matchAll(/__vite__mapDeps=\(i,m=__vite__mapDeps,d=\(m\.f\|\|\(m\.f=(\[[^\]]*\])/g)]
    .map(match => [match.index + match[0].length - match[1].length, match.index + match[0].length]);
  const references = [];
  for (const match of source.matchAll(RUNTIME_LITERAL)) {
    if (match[2].includes('${')) throw new Error(`${label}: "${match[2]}" computes a _runtime path`);
    const preload = preloadTables.some(([start, end]) => match.index > start && match.index < end);
    const resolved = preload && !match[2].startsWith('/')
      ? resolve(dirname(file), '..', match[2].split(/[?#]/)[0])
      : target(match[2]);
    references.push({ literal: match[2], target: resolved });
  }
  const mentions = source.match(RUNTIME_MENTION)?.length ?? 0;
  const captured = references.reduce((count, { literal }) => count + (literal.match(RUNTIME_MENTION)?.length ?? 0), 0);
  if (mentions !== captured) {
    throw new Error(`${label}: ${mentions - captured} _runtime reference(s) are not plain string paths`);
  }
  // A runtime module reaches another family by a relative path that never names _runtime.
  // Paths inside its own family need nothing: a site takes a family whole. Bundled
  // modules also carry relative strings that name no file (`"../utils/common"`), so
  // such a path counts only when it names a file of the full assembly.
  const ownFamily = runtimeFamily(siteDir, file);
  if (ownFamily) {
    for (const match of source.matchAll(RELATIVE_LITERAL)) {
      const family = runtimeFamily(siteDir, target(match[2]));
      if (family && family !== ownFamily) references.push({ literal: match[2], target: target(match[2]), inferred: true });
    }
  }
  return references;
}

// A runtime family is the directory two levels below _runtime (`ort-web/1.21.0`,
// `styles/<sha256>`, `webapp-components/0.1.2`). Its files load each other by
// relative URL, so a site takes a family whole.
function runtimeFamily(siteDir, target) {
  const path = posix(relative(join(siteDir, RUNTIME_DIRECTORY), target));
  const [name, version] = path.split('/');
  if (path.startsWith('..') || !name || !version) return null;
  return join(siteDir, RUNTIME_DIRECTORY, name, version);
}

/** The runtime family directories that `files` (in `siteDir`) reach, following references between families. */
export async function runtimeClosure(siteDir, files) {
  const families = new Set();
  const queue = files.filter((file) => TEXT_EXTENSIONS.has(extname(file)));
  const scanned = new Set();
  while (queue.length) {
    const file = queue.pop();
    if (scanned.has(file)) continue;
    scanned.add(file);
    for (const { literal, target, inferred } of runtimeReferences(await readFile(file, 'utf8'), file, siteDir)) {
      const family = runtimeFamily(siteDir, target);
      if (!family) throw new Error(`${posix(relative(siteDir, file))}: "${literal}" does not name a file in a ${RUNTIME_DIRECTORY} family`);
      if (inferred && !(await exists(target))) continue;
      await stat(target);
      if (families.has(family)) continue;
      families.add(family);
      for (const member of await walk(family)) {
        if (TEXT_EXTENSIONS.has(extname(member))) queue.push(member);
      }
    }
  }
  return [...families].sort();
}

/**
 * One catalogue's usage report, from the all-app report scripts/write-analytics.mjs
 * writes: its apps, with the totals and countries of their visits alone.
 */
export function catalogAnalytics(report, apps, catalog) {
  const { catalogs, ...all } = report;
  const own = catalogs?.[catalog.id];
  if (!own) throw new Error(`analytics.json has no report for catalogue ${catalog.id}; rerun scripts/write-analytics.mjs`);
  const recorded = new Map(all.apps.map((app) => [app.id, app]));
  return { ...all, ...own, apps: apps.map(({ id, path, title }) => recorded.get(id)
    ?? { id, path, title, users: 0, pageViews: 0, countries: [] }) };
}

/**
 * Write one catalogue's site from the all-app assembly in `siteDist`: its apps,
 * themed so the handoff menu lists only them, the root files they load, the
 * runtime families they reference, its landing page, usage report, 404
 * redirects and the standalone entries of its apps.
 */
export async function projectCatalogSite({ repoRoot, siteDist, destination, registry, catalog, information, standalone, notFoundTemplate }) {
  const apps = catalogApps(registry, catalog);
  const siteAppIds = apps.map((app) => app.id);
  const listed = { ...registry, apps };
  const primary = catalog.host === registry.site.domain;
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });

  for (const name of [...SHARED_ROOT_FILES, ...(primary ? PRIMARY_ROOT_FILES : [])]) {
    await cp(join(siteDist, name), join(destination, name), { recursive: true });
  }
  for (const app of apps) {
    await cp(join(siteDist, app.path), join(destination, app.path), { recursive: true });
    const indexPath = join(destination, app.path, 'index.html');
    const version = JSON.parse(await readFile(join(repoRoot, 'apps', app.id, 'package.json'), 'utf8')).version;
    // Only a catalogue site names its catalogue: the all-app assembly also feeds the desktop suite.
    await writeFile(indexPath, injectCompositeTheme(await readFile(indexPath, 'utf8'), {
      ...hostedThemeOptions({ registry, information, app, version, siteAppIds, catalog }),
      catalogId: catalog.id,
    }));
  }

  // Read the references from the copies, then take the families from the full assembly.
  const ownFiles = await walk(destination);
  const families = await runtimeClosure(siteDist, ownFiles.map((file) => join(siteDist, relative(destination, file))));
  for (const family of families) {
    await cp(family, join(destination, relative(siteDist, family)), { recursive: true });
  }
  await mkdir(join(destination, RUNTIME_DIRECTORY), { recursive: true });

  // Each app's runtime cache manifest lists the shared files this host serves.
  for (const app of apps) {
    const appDir = join(destination, app.path);
    for (const name of await readdir(appDir)) {
      if (/^runtime-cache-manifest\.[0-9a-f]{64}\.json$/.test(name)) await rm(join(appDir, name));
    }
  }
  await writeCompositeRuntimeCacheManifests({ siteDist: destination, registry: listed });

  const ownStandalone = { ...standalone, apps: Object.fromEntries(siteAppIds.map((id) => [id, standalone.apps[id]])) };
  await writeFile(join(destination, 'index.html'), renderLandingPage(listed, ownStandalone, catalog));
  const report = JSON.parse(await readFile(join(siteDist, 'analytics.json'), 'utf8'));
  await writeFile(join(destination, 'analytics.json'), `${JSON.stringify(catalogAnalytics(report, apps, catalog), null, 2)}\n`);
  await writeFile(join(destination, 'standalone.json'), `${JSON.stringify(ownStandalone, null, 2)}\n`);
  await writeFile(join(destination, '404.html'), renderNotFoundPage(notFoundTemplate, { registry, catalog }));
  await writeFile(join(destination, '_headers'), headersFile);
  if (catalog.hosting === 'pages') await writeFile(join(destination, '.nojekyll'), '');
  return { apps: siteAppIds, families: families.map((family) => posix(relative(siteDist, family))) };
}

/** webapps.sciget.org: the hub page, its stylesheet, theme controller, fonts and logo. */
export async function projectHubSite({ siteDist, destination, registry }) {
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  for (const name of ['landing.css', 'theme.js', 'fonts', registry.site.hub.brand.logo]) {
    await cp(join(siteDist, name), join(destination, name), { recursive: true });
  }
  await writeFile(join(destination, 'index.html'), renderHubPage(registry));
  await writeFile(join(destination, '_headers'), headersFile);
}

// Workers runtime behaviour the assets-only sites were checked with.
const WORKER_COMPATIBILITY_DATE = '2026-07-12';

/**
 * The Wrangler configuration that deploys one site (`dist-sites/<site>`) as an
 * assets-only Cloudflare Worker on its custom domain. It sits beside the site
 * directory so `wrangler deploy --config dist-sites/<site>.wrangler.json` finds it.
 */
export function workerConfig(host, site) {
  return {
    name: host.replaceAll('.', '-'),
    compatibility_date: WORKER_COMPATIBILITY_DATE,
    workers_dev: false,
    routes: [{ pattern: host, custom_domain: true }],
    assets: {
      directory: `./${site}`,
      html_handling: 'auto-trailing-slash',
      not_found_handling: '404-page',
    },
  };
}

/** Every site a Cloudflare Worker serves: the worker-hosted catalogues and the hub. */
export function workerSites(registry) {
  return [
    ...registry.site.catalogs.filter((catalog) => catalog.hosting === 'worker').map((catalog) => ({ host: catalog.host, site: catalog.id })),
    { host: registry.site.hub.host, site: HUB_SITE },
  ];
}
