import { execFileSync } from 'node:child_process';
import { parse } from 'yaml';
import { LockfileAnalysisError, lockfileImpact } from './lockfile-impact.mjs';
import { onlyAddsExports } from './module-closure.mjs';
import { EMBEDDED_VERSION_FILES, releaseBookkeeping } from './release-bookkeeping.mjs';
import { CATALOG, EASTER_EGG, INDEPENDENT_CONFIG, SITE, reachableFrom } from './workspace-graph.mjs';
import { validateAppInformation } from './app-information.mjs';
import { parseAppsRegistry } from './apps-registry.mjs';
import { validateStandalone } from './standalone.mjs';

const NON_CODE_PREFIXES = ['docs/', '.changeset/'];
// Self-contained packages outside apps/ with their own CI job (the homepage
// easter egg and its leaderboard worker run under `homepage-easter-egg`).
// Changes there select no catalog apps. Shared homepage files directly under
// site/ still count as shared changes.
const SELF_CONTAINED_PREFIXES = ['site/easter-eggs/'];
// Paths no app build or browser test reads. Lint and quality tooling run in
// workspace-contracts or their own workflows; every workflow other than ci.yml
// runs itself when it changes; the app template is checked by contract tests.
const INDEPENDENT_CHECK_PATHS = [
  /^[^/]+\.md$/,
  /^\.gitignore$/,
  /^\.github\/workflows\/(?!ci\.yml$)[^/]+$/,
  INDEPENDENT_CONFIG,
  /^config\/dependency-/,
  /^templates\//,
];
// Root files the workspace graph follows. Without a graph they count as shared.
const ROOT_FILE = /^(?:scripts|test-utils|registry|test)\//;
// An app's model manifest belongs to that app alone.
const MODEL_MANIFEST = /^models\/([^/]+)\.manifest\.json$/;
const NON_CODE_FILES = new Set(['README.md', 'LICENSES.md']);
const LOCKFILE = 'pnpm-lock.yaml';
const REGISTRY = 'registry/apps.yml';
const STANDALONE = 'registry/standalone.json';
const APP_INFORMATION = 'registry/app-information.yml';
// Root tools no per-app or composite-site job executes: Knip and Stryker run
// in the unused-code and mutation workflows, ESLint (scripts/lint.mjs,
// eslint.config.js) in workspace-contracts and code-quality on every pull
// request. test/app-plan.test.mjs fails when an app's CI scripts load one.
export const INDEPENDENT_ROOT_DEV_DEPENDENCIES = ['knip', '@stryker-mutator/core', 'eslint', '@eslint/js', 'globals'];
const GITATTRIBUTES = '.gitattributes';
// Outside the composite build and its own tests, only these root files read
// the runtime manifest; an app whose build or tests stage pinned runtime files
// reaches one of them. test/app-plan.test.mjs fails on a new reader.
const RUNTIME_MANIFEST = 'runtime-assets/manifest.json';
export const RUNTIME_MANIFEST_READERS = ['scripts/fetch-app-runtime.mjs'];
// Root files that generate NeuroFlow tools from every app's automation.json,
// through paths built from the registry that the workspace graph cannot see.
// An app that reaches one also tests a change to any app's contract.
export const AUTOMATION_CATALOG_READERS = ['scripts/lib/neuroflow-bundle.mjs'];
const AUTOMATION_CONTRACT = /^apps\/[^/]+\/automation\.json$/;
// site/ files only the composite build copies: the landing page, its
// analytics settings, the Pages 404 page and the dicompare route shim. The
// app shell, theme, fonts and logo go into every app and stay shared.
// test/app-plan.test.mjs fails when anything else names them.
export const SITE_ONLY_FILES = new Set(['site/landing.css', 'site/landing.js', 'site/analytics.json', 'site/404.html', 'site/dicompare-routes.js']);
const CI_WORKFLOW = '.github/workflows/ci.yml';
// What each ci.yml job tests, for a change confined to it: the composite site
// (`site`: composite-site and the jobs that only consume its build), every
// package suite (`packages`: workspace-contracts runs them), the homepage
// easter egg (`easter-egg`), or nothing (`none`: the plan's marker jobs). The
// plan, the per-app jobs, a job not listed here and every key outside `jobs`
// reach every app. test/app-plan.test.mjs holds the list to ci.yml.
export const CI_JOB_SCOPES = Object.freeze({
  'composite-site': 'site',
  'agent-interactions': 'site',
  'example-cache-retention': 'site',
  'workspace-contracts': 'packages',
  'homepage-easter-egg': 'easter-egg',
  'full-plan': 'none',
  'full-plan-withheld': 'none',
});
// Every key of registry/apps.yml's site section (`[]` is each entry of a
// list), and the files an app build or an app's tests run that read it. The
// composite build (scripts/build-site.mjs and the landing, hub and 404 pages it
// writes) reads all of it, and package suites and the easter egg follow the
// file itself through the workspace graph. Every app build validates the whole
// registry, so a head registry that fails validation reaches every app; a
// valid one reaches the apps that reach a reader of a key that changed. A key
// with no readers selects only the site build. A key not listed here, at any
// depth and whatever its value, selects every app. test/app-plan.test.mjs
// reads each reader's text for the keys it reads and fails when one is not
// listed; a file that holds a whole catalogue entry (suite.mjs, pack.mjs)
// reads every key of it.
const DESKTOP_SUITE = ['scripts/desktop/suite.mjs', 'scripts/desktop/pack.mjs', 'scripts/desktop/models-pack.mjs', 'scripts/desktop/release-files.mjs'];
const CATALOG_ENTRY = ['scripts/desktop/suite.mjs', 'scripts/desktop/pack.mjs'];
const BRAND_KEYS = ['name', 'logo', 'icon', 'theme', 'home', 'more_apps'].map((key) => `brand.${key}`);
const keys = (prefix, names, readers) => names.map((name) => [`${prefix}.${name}`, readers]);
export const SITE_KEY_READERS = Object.freeze(Object.fromEntries([
  ['site.domain', ['scripts/desktop/suite.mjs', 'scripts/desktop/release-files.mjs']],
  ...keys('site.hub', ['host', 'title', 'heading', 'description', ...BRAND_KEYS], []),
  ['site.catalogs[].id', ['scripts/lib/standalone.mjs', ...DESKTOP_SUITE]],
  ['site.catalogs[].host', [...CATALOG_ENTRY, 'scripts/desktop/release-files.mjs']],
  ...keys('site.catalogs[]', ['hosting', 'title', 'heading', 'description', ...BRAND_KEYS], CATALOG_ENTRY),
  ...keys('site.catalogs[].desktop', ['product_name', 'app_id', 'release', 'executable'], DESKTOP_SUITE),
  ['site.analytics.measurement_id', ['scripts/theme-app-dist.mjs', 'scripts/lib/vite-app-config.mjs', 'scripts/dev-server.mjs']],
  ['site.analytics.period_days', []],
  ...keys('site.categories[]', ['id', 'title', 'description'], []),
].map(([key, readers]) => [key, Object.freeze(readers)])));

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// The importers whose resolved dependencies a lockfile change touched, or why
// the change cannot be scoped.
function analyseLockfile(manifest) {
  try {
    return { importers: lockfileImpact(manifest, { independentRootDevDependencies: INDEPENDENT_ROOT_DEV_DEPENDENCIES }) };
  } catch (error) {
    if (error instanceof LockfileAnalysisError) return { shared: error.message };
    throw error;
  }
}

// The app entries a registry/standalone.json change touched, whether the
// suite (read only by the catalog page and the desktop bundle) changed, or why
// the change is shared. Every themed app build copies the file and validates
// all of it, but the shell renders only the app's own entry, so a valid head
// catalog reaches only the apps whose entries changed.
export function standaloneImpact({ before, after }, registry) {
  let old;
  let now;
  try {
    [old, now] = [JSON.parse(before), JSON.parse(after)];
    validateStandalone(now, registry);
  } catch (error) {
    return { shared: `it is not a valid catalog at head (${error.message}), and every themed app build validates it` };
  }
  const field = [...new Set([...Object.keys(old ?? {}), ...Object.keys(now)])].find((key) => key !== 'apps' && key !== 'suites' && !same(old?.[key], now[key]));
  if (field) return { shared: `its ${field} field changed` };
  const ids = [...new Set([...Object.keys(old?.apps ?? {}), ...Object.keys(now.apps)])];
  return { changed: ids.filter((id) => !same(old?.apps?.[id], now.apps[id])), suite: !same(old?.suites, now.suites) };
}

// The app entries a registry/app-information.yml change touched, or why the
// change is shared. Every themed app build validates the whole file, but its
// payload (appInformationPayload) holds the shared statements and the app's
// own entry, so a valid head file reaches only the apps whose entries changed.
function appInformationImpact({ before, after }, registry) {
  let old;
  let now;
  try {
    [old, now] = [parse(before), parse(after)];
    validateAppInformation(now, registry);
  } catch (error) {
    return { shared: `it is not valid at head (${error.message.split('\n').slice(0, 2).join(' ')}), and every themed app build validates it` };
  }
  try {
    const section = [...new Set([...Object.keys(old ?? {}), ...Object.keys(now)])].find((key) => key !== 'apps' && !same(old?.[key], now[key]));
    if (section) return { shared: `its ${section} section changed, and every app's dialogs render it` };
    const ids = [...new Set([...Object.keys(old?.apps ?? {}), ...Object.keys(now.apps)])];
    return { changed: ids.filter((id) => !same(old?.apps?.[id], now.apps[id])) };
  } catch (error) {
    // A recursive alias parses but has no JSON form to compare.
    return { shared: `its entries cannot be compared (${error.message.split('\n')[0]})` };
  }
}

// The site keys two registries differ in, as SITE_KEY_READERS names them:
// lists of entries with unique ids compare entry by entry (`[]`), and an entry
// that is added, removed or moved changes `[].id` and every key below it. Any
// other list that changed is one key the table does not name.
function changedSiteKeys(old, now, path = 'site') {
  if (same(old, now)) return [];
  const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const entries = (value) => Array.isArray(value) && value.every((entry) => record(entry) && typeof entry.id === 'string') && new Set(value.map((entry) => entry.id)).size === value.length;
  if (entries(old) && entries(now)) {
    const [before, after] = [new Map(old.map((entry) => [entry.id, entry])), new Map(now.map((entry) => [entry.id, entry]))];
    const moved = same(old.map((entry) => entry.id), now.map((entry) => entry.id)) ? [] : [`${path}[].id`];
    return [...moved, ...[...new Set([...before.keys(), ...after.keys()])].flatMap((id) => changedSiteKeys(before.get(id), after.get(id), `${path}[]`))];
  }
  if ((record(old) || old === undefined) && (record(now) || now === undefined)) {
    return [...new Set([...Object.keys(old ?? {}), ...Object.keys(now ?? {})])].flatMap((key) => changedSiteKeys(old?.[key], now?.[key], `${path}.${key}`));
  }
  return [path];
}

// The first path in a site section that SITE_KEY_READERS does not name: a key
// it does not list at any depth, or a value of another kind than the table
// gives its path (a mapping or list where it lists a scalar, or the reverse).
// An empty mapping under a new key is a path the table does not name too.
function unknownSiteKey(value, path = 'site') {
  const below = (prefix) => Object.keys(SITE_KEY_READERS).some((key) => key.startsWith(prefix));
  if (Array.isArray(value)) {
    if (!below(`${path}[].`)) return path;
    return value.reduce((issue, entry) => issue ?? unknownSiteKey(entry, `${path}[]`), null);
  }
  if (value !== null && typeof value === 'object') {
    if (!below(`${path}.`)) return path;
    return Object.entries(value).reduce((issue, [name, child]) => issue ?? unknownSiteKey(child, `${path}.${name}`), null);
  }
  return Object.hasOwn(SITE_KEY_READERS, path) ? null : path;
}

// The app entries and site keys a registry/apps.yml change touched, or why
// the change is shared. Every app build validates the whole registry, so a
// site change narrows only when the head registry is valid.
function registryImpact({ before, after }) {
  let old;
  let now;
  try {
    [old, now] = [parse(before), parse(after)];
  } catch (error) {
    return { shared: `it does not parse (${error.message})` };
  }
  const section = [...new Set([...Object.keys(old ?? {}), ...Object.keys(now ?? {})])].find((key) => key !== 'apps' && key !== 'site' && !same(old?.[key], now?.[key]));
  if (section) return { shared: `its ${section} section changed, and every app build reads it` };
  const siteKeys = [...new Set(changedSiteKeys(old?.site, now?.site))];
  if (!same(old?.site, now?.site)) {
    try {
      parseAppsRegistry(after);
    } catch (error) {
      return { shared: `it is not valid at head (${error.message.split('\n').slice(0, 2).join(' ')}), and every app build validates it` };
    }
    const unknown = unknownSiteKey(old?.site) ?? unknownSiteKey(now?.site) ?? siteKeys.find((key) => !Object.hasOwn(SITE_KEY_READERS, key));
    if (unknown) return { shared: `its site section has ${unknown}, and no rule says which builds read it` };
  }
  const entries = (registry) => (Array.isArray(registry?.apps) ? registry.apps : []);
  const byId = (registry) => new Map(entries(registry).map((app) => [app?.id, app]));
  const [was, is] = [byId(old), byId(now)];
  if (was.size !== entries(old).length || is.size !== entries(now).length || was.has(undefined) || is.has(undefined)) {
    return { shared: 'its app entries have missing or duplicate ids' };
  }
  return { changed: [...new Set([...was.keys(), ...is.keys()])].filter((id) => !same(was.get(id), is.get(id))), siteKeys };
}

// The jobs that need `id` (`direction` 'dependants') or that it needs
// ('dependencies'), directly or through other jobs, in one workflow's jobs.
function relatedJobs(jobs, id, direction) {
  const needs = (job) => [jobs[job]?.needs ?? []].flat();
  const next = direction === 'dependencies' ? needs : (job) => Object.keys(jobs).filter((other) => needs(other).includes(job));
  const seen = new Set();
  const pending = [id];
  while (pending.length) {
    for (const job of next(pending.pop())) {
      if (!seen.has(job)) {
        seen.add(job);
        pending.push(job);
      }
    }
  }
  seen.delete(id);
  return [...seen];
}

// The ci.yml jobs a workflow change touched, or why it is shared. It narrows
// only when the base and head have the same jobs, each changed job is one
// CI_JOB_SCOPES places, and every job that needs a changed job, or that a
// changed job needs (the plan aside), at the base or the head, has the same
// scope: a job of another scope could consume what changed while the
// narrowed plan skips it, or skip the changed job by being skipped itself. A
// key outside `jobs` reaches every app.
export function ciImpact({ before, after }) {
  let old;
  let now;
  try {
    [old, now] = [parse(before), parse(after)];
  } catch (error) {
    return { shared: `it does not parse (${error.message.split('\n')[0]})` };
  }
  const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!record(old?.jobs) || !record(now?.jobs)) return { shared: 'it has no jobs to compare' };
  try {
    const key = [...new Set([...Object.keys(old), ...Object.keys(now)])].find((name) => name !== 'jobs' && !same(old[name], now[name]));
    if (key) return { shared: `its ${key} key changed, and every job runs under it` };
    const membership = [...new Set([...Object.keys(old.jobs), ...Object.keys(now.jobs)])].find((id) => !Object.hasOwn(old.jobs, id) || !Object.hasOwn(now.jobs, id));
    if (membership) return { shared: `its ${membership} job was ${Object.hasOwn(now.jobs, membership) ? 'added' : 'removed'}, and only a change within the same jobs narrows` };
    const jobs = Object.keys(now.jobs).filter((id) => !same(old.jobs[id], now.jobs[id]));
    const unplaced = jobs.find((id) => !Object.hasOwn(CI_JOB_SCOPES, id));
    if (unplaced) return { shared: `its ${unplaced} job changed, and only a change to ${Object.keys(CI_JOB_SCOPES).join(', ')} narrows` };
    for (const id of jobs) {
      for (const [side, workflow] of [['base', old], ['head', now]]) {
        for (const direction of ['dependants', 'dependencies']) {
          const other = relatedJobs(workflow.jobs, id, direction).find((job) => job !== 'app-plan' && CI_JOB_SCOPES[job] !== CI_JOB_SCOPES[id]);
          if (other) return { shared: `its ${id} job changed, and at the ${side} ${direction === 'dependants' ? `${other} needs it` : `it needs ${other}`}, which tests more than the ${CI_JOB_SCOPES[id]} scope` };
        }
      }
    }
    return { jobs };
  } catch (error) {
    // A recursive alias parses but has no JSON form to compare.
    return { shared: `its jobs cannot be compared (${error.message.split('\n')[0]})` };
  }
}

// The workspace graph nodes a changed file belongs to. A package's tests
// reach only those that read them and a document only those that read that
// file; any other file reaches its package's users and, if a root file names
// it, that file's.
function graphNodes(path, graph) {
  const packageTests = path.match(/^packages\/[^/]+\/tests?(?=\/)/)?.[0];
  const document = /^(?:packages|exes)\/.*\.md$/.test(path) && path;
  if (packageTests || document) return [packageTests || document];
  return [path.match(/^(packages|exes)\/[^/]+(?=\/)/)?.[0], ROOT_FILE.test(path) || graph?.edges.has(path) ? path : null].filter(Boolean);
}

function shardedEntries(app) {
  const total = app.ci.e2e_shards ?? 1;
  return Array.from({ length: total }, (_, index) => ({ ...matrixEntry(app), shard: total > 1 ? `${index + 1}/${total}` : '' }));
}

// Whether a plan runs an app's @heavy CPU browser tests: when the change edits
// the app itself (`edited`: its app, package or exes directory or model
// manifest, release bookkeeping aside), when a failed run on main left it
// untested, or when the plan has no diff at all (a full run: the nightly, a
// dispatch of every app, an unknown base). An app reached only through shared
// code leaves them to the nightly run, also when the planner selected every
// app for a change it could not narrow (ci.yml, an unresolved lockfile).
function editsApp(app, changedPaths, edited, carried) {
  if (!changedPaths.length || carried.has(app.id)) return true;
  return edited.some((path) => [`apps/${app.id}/`, `packages/${app.id}/`, `exes/${app.id}/`].some((prefix) => path.startsWith(prefix))
    || path === `models/${app.id}.manifest.json`);
}

function matrixEntry(app) {
  const toolchains = new Set(app.ci.toolchains);
  return {
    app: app.id,
    path: app.path,
    runtime: app.runtime,
    rust_wasm: toolchains.has('rust-wasm'),
    python_reference: toolchains.has('python-reference'),
    shared_runtime: app.ci.shared_runtime,
    browser_test: app.ci.browser_test,
    hardware_gpu: app.ci.hardware_gpu,
    app_scoped_runtime: app.app_scoped_runtime_families.length > 0,
    release_test: app.ci.release_test ?? 'test',
  };
}

const OFFLINE_LOCK = 'registry/offline-assets.lock.json';

// The apps whose locked assets or asset lists a lock change touched. Per-app
// jobs read the lock only to check their own app's pinned examples.
function lockOwners({ before, after }) {
  const [old, now] = [JSON.parse(before), JSON.parse(after)];
  const urls = new Set([...Object.keys(old.assets), ...Object.keys(now.assets)]);
  const changed = new Set([...urls].filter((url) => JSON.stringify(old.assets[url]) !== JSON.stringify(now.assets[url])));
  const apps = new Set([...Object.keys(old.apps), ...Object.keys(now.apps)]);
  return [...apps].filter((app) => JSON.stringify(old.apps[app]) !== JSON.stringify(now.apps[app]) || [...(old.apps[app] ?? []), ...(now.apps[app] ?? [])].some((url) => changed.has(url)));
}

// The top-level fields a package.json change touched.
function changedFields({ before, after }) {
  const [old, now] = [JSON.parse(before), JSON.parse(after)];
  const fields = new Set([...Object.keys(old), ...Object.keys(now)]);
  return [...fields].filter((field) => JSON.stringify(old[field]) !== JSON.stringify(now[field]));
}

// Changed root scripts after removing independent tools, or null for shared fields.
function changedRootScripts(manifest) {
  const withoutTools = (text) => {
    const { devDependencies = {}, ...rest } = JSON.parse(text);
    const remaining = Object.fromEntries(Object.entries(devDependencies).filter(([name]) => !INDEPENDENT_ROOT_DEV_DEPENDENCIES.includes(name)));
    return JSON.stringify({ ...rest, devDependencies: remaining });
  };
  manifest = { before: withoutTools(manifest.before), after: withoutTools(manifest.after) };
  if (changedFields(manifest).some((field) => field !== 'scripts')) return null;
  const [old, now] = [JSON.parse(manifest.before).scripts ?? {}, JSON.parse(manifest.after).scripts ?? {}];
  return [...new Set([...Object.keys(old), ...Object.keys(now)])].filter((name) => old[name] !== now[name]);
}

// The apps a change tests, whether it needs the composite site build, and why.
// Without a workspace graph every packages/, exes/ or root file change counts
// as shared. With one, a change selects the apps that reach it; a root file
// that ci.yml's per-app jobs run selects every app, and one only the
// composite-site job runs selects no app but the site build. `manifests` maps
// a changed package.json, offline asset lock, pnpm-lock.yaml or
// registry/apps.yml to its text before and after: root script edits count only
// where ci.yml runs them, an asset lock change selects the apps whose assets
// changed, a pnpm lockfile change the apps whose resolved dependencies changed,
// and a registry change the apps whose entries changed. Without both texts the
// last two select everything. Markdown in a package or exes/ directory reaches
// only the apps that read that exact file.
// `reasons.fallback` says why the whole catalog was selected; otherwise
// `reasons.apps` maps each selected app, and `reasons.site` the site build, to
// the changes that selected it.
// With `release`, a version bump selects what it reaches: release.yml picks
// the apps to publish from the version changes themselves. `carried` maps app
// ids a failed run on main left untested to the jobs that failed there.
export function selectAffectedApps(registry, changedPaths = [], graph = null, manifests = new Map(), { release = false, carried = new Map() } = {}) {
  const everything = (fallback) => ({ apps: registry.apps, site: true, reasons: { fallback, apps: {}, site: [] } });
  if (!changedPaths.length) return everything('no changed paths: no base revision, an unreadable diff, or a full run');

  const appIds = new Set(registry.apps.map((app) => app.id));
  const reach = graph && new Map(registry.apps.map((app) => [app.id, reachableFrom(graph, `apps/${app.id}`)]));
  const catalog = graph && reachableFrom(graph, CATALOG);
  const site = graph && reachableFrom(graph, SITE);
  const appReasons = new Map();
  const siteReasons = [];
  const bookkeeping = [];
  let fallback = null;
  const select = (appId, reason) => appReasons.set(appId, [...(appReasons.get(appId) ?? []), reason]);
  const shared = (reason) => {
    fallback ??= reason;
  };
  const siteBuild = (reason) => siteReasons.push(reason);
  // Selects whatever reaches `node` or a file below it.
  const selectReaching = (node, reason) => {
    const within = (candidate) => candidate === node || candidate.startsWith(`${node}/`);
    if (ROOT_FILE.test(`${node}/`) && [...catalog].some(within)) shared(`${reason}; ci.yml's per-app jobs run ${node}`);
    if ([...site].some(within)) siteBuild(reason);
    for (const candidate of registry.apps) {
      if ([...reach.get(candidate.id)].some(within)) select(candidate.id, reason);
    }
  };

  for (const path of changedPaths) {
    // A release's changelogs and version bumps change no behaviour; workspace-contracts checks them.
    if (!release && releaseBookkeeping(path, manifests)) {
      bookkeeping.push(path);
      continue;
    }
    const appId = path.match(/^apps\/([^/]+)\//)?.[1] ?? path.match(MODEL_MANIFEST)?.[1];
    if (appIds.has(appId)) {
      select(appId, path);
      if (graph && AUTOMATION_CONTRACT.test(path)) {
        for (const reader of AUTOMATION_CATALOG_READERS) selectReaching(reader, `${path}: ${reader} generates tools from every app's contract`);
      }
      continue;
    }
    if (
      NON_CODE_FILES.has(path) ||
      NON_CODE_PREFIXES.some((prefix) => path.startsWith(prefix)) ||
      SELF_CONTAINED_PREFIXES.some((prefix) => path.startsWith(prefix)) ||
      INDEPENDENT_CHECK_PATHS.some((pattern) => pattern.test(path))
    ) {
      continue;
    }
    if (path === LOCKFILE) {
      const impact = manifests.get(path) ? analyseLockfile(manifests.get(path)) : { shared: 'the base or head lockfile is unavailable' };
      if (impact.shared) {
        shared(`${path}: ${impact.shared}`);
        continue;
      }
      for (const [importer, reason] of impact.importers) {
        const importerApp = importer.match(/^apps\/([^/]+)$/)?.[1];
        if (appIds.has(importerApp)) select(importerApp, `${path}: ${reason}`);
        else if (importer === '.') shared(`${path}: ${reason}; the root's dependencies resolve for every workspace member`);
        else if (SELF_CONTAINED_PREFIXES.some((prefix) => `${importer}/`.startsWith(prefix))) continue;
        else if (!graph) shared(`${path}: ${reason}, and there is no workspace graph to find its users`);
        else selectReaching(importer, `${path}: ${reason}`);
      }
      continue;
    }
    if (SITE_ONLY_FILES.has(path)) {
      siteBuild(`${path}: only the composite build copies it`);
      continue;
    }
    if (path === RUNTIME_MANIFEST && graph) {
      siteBuild(`${path}: the composite build assembles the shared runtime store from it`);
      for (const reader of RUNTIME_MANIFEST_READERS) selectReaching(reader, `${path}: ${reader} stages the files it pins`);
      continue;
    }
    if (path === GITATTRIBUTES) {
      // An attribute change touches the files that now check out differently.
      const files = manifests.get(path)?.files;
      if (!files) {
        shared(`${path}: the files whose attributes changed are unknown`);
        continue;
      }
      if (!files.length) continue;
      const touched = selectAffectedApps(registry, files, graph, new Map()).reasons;
      if (touched.fallback) shared(`${path}: ${touched.fallback}`);
      for (const [id, reasons] of Object.entries(touched.apps)) select(id, `${path}: ${reasons[0]}`);
      for (const reason of touched.site) siteBuild(`${path}: ${reason}`);
      continue;
    }
    if (path === STANDALONE && manifests.get(path)) {
      const impact = standaloneImpact(manifests.get(path), registry);
      if (impact.shared) {
        shared(`${path}: ${impact.shared}`);
        continue;
      }
      siteBuild(`${path}: the composite site serves the catalog${impact.suite ? ' and its desktop suite' : ''}`);
      for (const id of impact.changed) {
        if (appIds.has(id)) select(id, `${path}: the ${id} entry changed`);
      }
      continue;
    }
    if (path === APP_INFORMATION && manifests.get(path)) {
      const impact = appInformationImpact(manifests.get(path), registry);
      if (impact.shared) {
        shared(`${path}: ${impact.shared}`);
        continue;
      }
      siteBuild(`${path}: the composite site themes every app with it`);
      for (const id of impact.changed) {
        if (appIds.has(id)) select(id, `${path}: the ${id} entry changed`);
      }
      continue;
    }
    if (path === REGISTRY) {
      const impact = manifests.get(path) ? registryImpact(manifests.get(path)) : { shared: 'the base or head registry is unavailable' };
      if (impact.shared) {
        shared(`${path}: ${impact.shared}`);
        continue;
      }
      siteBuild(`${path}: the landing page lists the catalog`);
      for (const id of impact.changed) {
        if (appIds.has(id)) select(id, `${path}: the ${id} entry changed`);
      }
      for (const key of impact.siteKeys) {
        const readers = SITE_KEY_READERS[key];
        if (!readers.length) siteBuild(`${path}: ${key} changed, and only the site build reads it`);
        if (readers.length && !graph) shared(`${path}: ${key} changed, and there is no workspace graph to find the apps that read it`);
        else for (const reader of readers) selectReaching(reader, `${path}: ${key} changed, and ${reader} reads it`);
      }
      continue;
    }
    if (path === CI_WORKFLOW) {
      const impact = manifests.get(path) ? ciImpact(manifests.get(path)) : { shared: 'the base or head workflow is unavailable' };
      if (impact.shared) {
        shared(`${path}: ${impact.shared}`);
        continue;
      }
      for (const job of impact.jobs) {
        if (CI_JOB_SCOPES[job] === 'site') siteBuild(`${path}: its ${job} job changed, and it tests only the composite site`);
      }
      continue;
    }
    const manifest = graph && manifests.get(path);
    if (manifest && path === 'package.json') {
      const lock = manifests.get(LOCKFILE);
      const impact = lock ? analyseLockfile(lock) : { shared: 'the base or head lockfile is unavailable' };
      if (impact.shared) {
        shared(`${LOCKFILE}: ${impact.shared}`);
        continue;
      }
      const scripts = changedRootScripts(manifest);
      if (scripts) {
        const catalogScripts = scripts.filter((name) => graph.rootScriptsRun.get(CATALOG).has(name));
        const siteScripts = scripts.filter((name) => graph.rootScriptsRun.get(SITE).has(name));
        if (catalogScripts.length) shared(`${path}: ci.yml's per-app jobs run root scripts ${catalogScripts.join(', ')}`);
        if (siteScripts.length) siteBuild(`${path}: the site CI jobs run root scripts ${siteScripts.join(', ')}`);
        continue;
      }
    }
    if (manifest && path === OFFLINE_LOCK) {
      for (const app of lockOwners(manifest)) if (appIds.has(app)) select(app, `${path}: its locked assets changed`);
      siteBuild(path);
      continue;
    }
    // New export entries resolve every existing import as before.
    if (manifest && /^packages\/[^/]+\/package\.json$/.test(path) && onlyAddsExports(manifest)) continue;
    // A module of the shared component package reaches the apps that load it.
    const loadedBy = graph?.moduleUsers?.(path);
    if (loadedBy) {
      if (loadedBy.some((user) => site.has(user))) siteBuild(path);
      for (const candidate of registry.apps) {
        const user = loadedBy.find((user) => reach.get(candidate.id).has(user));
        if (user) select(candidate.id, `${path} (loaded by ${user})`);
      }
      continue;
    }
    const nodes = graphNodes(path, graph);
    if (graph && nodes.length) {
      // Per-app jobs name packages only to provision their own app's data.
      if (ROOT_FILE.test(path) && catalog.has(path)) {
        shared(`${path}: ci.yml's per-app jobs run it`);
        continue;
      }
      if (nodes.some((node) => site.has(node))) siteBuild(path);
      for (const candidate of registry.apps) {
        const node = nodes.find((node) => reach.get(candidate.id).has(node));
        if (node) select(candidate.id, node === path ? path : `${path} (through ${node})`);
      }
      continue;
    }
    shared(graph ? `${path}: no rule classifies it` : `${path}: there is no workspace graph to find its users`);
  }

  if (fallback) return { ...everything(fallback), bookkeeping };
  for (const [id, jobs] of carried) {
    if (appIds.has(id)) select(id, `failed in the base run (${jobs.join(', ')})`);
  }
  if (appReasons.has('qsmbly')) select('brain-extraction', 'qsmbly is selected and Brain extraction ships its runtime');
  const apps = registry.apps.filter((app) => appReasons.has(app.id));
  return {
    apps,
    site: siteReasons.length > 0,
    reasons: { fallback: null, apps: Object.fromEntries(apps.map((app) => [app.id, appReasons.get(app.id)])), site: siteReasons },
    bookkeeping,
  };
}

// Paths no package suite and not the easter egg reads: their tests read no
// root Markdown, no other workflow and no lint or dependency-quality config.
const NO_SUITE_PATHS = [/^[^/]+\.md$/, /^\.gitignore$/, /^\.github\/workflows\/(?!ci\.yml$)[^/]+$/, INDEPENDENT_CONFIG, /^config\/dependency-/];
// Directories whose files a suite reads only through its graph node or the paths it names.
const SUITE_INPUT = /^(?:apps|packages|exes|scripts|test-utils|registry|test|models|site|runtime-assets|templates)\//;
export const EASTER_EGG_SUITE = 'homepage-easter-egg';
// Importers a lockfile change can place: a workspace directory or an easter egg.
const PLACED_IMPORTER = /^(?:(?:apps|packages|exes)\/[^/]+|site\/easter-eggs\/[^/]+)$/;

// The suites outside the per-app jobs: each package's own tests, which
// workspace-contracts runs (`pnpm test:packages`), and the homepage easter
// egg's, which the homepage-easter-egg job runs. A suite reads its own
// directory, every node its graph node reaches, and the app, model and site
// files those name (`graph.outside`; a package's tests count only for its own
// suite and for suites that read them).
function suitesOf(graph) {
  const suite = (id, own, start, tests = []) => {
    const reach = reachableFrom(graph, start);
    return { id, own, reach, outside: new Set([...reach, ...tests].flatMap((node) => [...(graph.outside?.get(node) ?? [])])) };
  };
  const packages = graph.nodes.filter((node) => node.startsWith('packages/'));
  return [
    ...packages.map((node) => suite(node, `${node}/`, node, [`${node}/test`, `${node}/tests`])),
    ...(graph.edges.has(EASTER_EGG) ? [suite(EASTER_EGG_SUITE, 'site/', EASTER_EGG)] : []),
  ];
}

// The package suites and the easter egg a change reaches, and why. Without a
// diff, a graph, or for a path no rule places (root configuration, an
// unplaced lockfile importer, ci.yml outside the jobs CI_JOB_SCOPES lists),
// `fallback` says why every suite runs. The easter egg also runs whenever
// the graph has no node for its job.
export function selectAffectedSuites(changedPaths, graph, manifests = new Map(), { release = false } = {}) {
  if (!changedPaths.length) return { fallback: 'no changed paths: no base revision, an unreadable diff, or a full run', suites: new Map() };
  if (!graph) return { fallback: 'there is no workspace graph to find what each suite reads', suites: new Map() };
  const suites = suitesOf(graph);
  const selected = new Map();
  let fallback = null;
  const select = (id, reason) => selected.set(id, [...(selected.get(id) ?? []), reason]);
  const shared = (reason) => {
    fallback ??= reason;
  };
  // The suites that read `path`: below their own directory, through a node they reach, or a path they name.
  const touch = (path, reason = path) => {
    const nodes = graphNodes(path, graph);
    const top = path.split('/')[0];
    for (const suite of suites) {
      const names = [...suite.outside].some((name) => name === top || path === name || path.startsWith(`${name}/`));
      if (path.startsWith(suite.own) || names || nodes.some((node) => suite.reach.has(node))) select(suite.id, reason);
    }
  };
  for (const path of changedPaths) {
    if (!release && releaseBookkeeping(path, manifests)) continue;
    if (NON_CODE_FILES.has(path) || NON_CODE_PREFIXES.some((prefix) => path.startsWith(prefix)) || NO_SUITE_PATHS.some((pattern) => pattern.test(path))) continue;
    if (path === CI_WORKFLOW) {
      const impact = manifests.get(path) ? ciImpact(manifests.get(path)) : { shared: 'the base or head workflow is unavailable' };
      if (impact.shared) {
        shared(`${path}: ${impact.shared}`);
        continue;
      }
      for (const job of impact.jobs) {
        const scope = CI_JOB_SCOPES[job];
        for (const suite of suites) {
          if ((scope === 'packages' && suite.id !== EASTER_EGG_SUITE) || (scope === 'easter-egg' && suite.id === EASTER_EGG_SUITE)) select(suite.id, `${path}: its ${job} job changed`);
        }
      }
      continue;
    }
    if (path === LOCKFILE) {
      const impact = manifests.get(path) ? analyseLockfile(manifests.get(path)) : { shared: 'the base or head lockfile is unavailable' };
      if (impact.shared) {
        shared(`${path}: ${impact.shared}`);
        continue;
      }
      for (const [importer, reason] of impact.importers) {
        if (PLACED_IMPORTER.test(importer)) touch(`${importer}/package.json`, `${path}: ${reason}`);
        else shared(`${path}: ${reason}, and ${importer === '.' ? "the root's dependencies resolve for every workspace member" : 'no rule says which suites resolve it'}`);
      }
      continue;
    }
    if (path === GITATTRIBUTES) {
      const files = manifests.get(path)?.files;
      if (!files) {
        shared(`${path}: the files whose attributes changed are unknown`);
        continue;
      }
      if (!files.length) continue;
      const touched = selectAffectedSuites(files, graph, new Map(), { release });
      if (touched.fallback) shared(`${path}: ${touched.fallback}`);
      for (const [id, reasons] of touched.suites) select(id, `${path}: ${reasons[0]}`);
      continue;
    }
    if (SUITE_INPUT.test(path)) {
      touch(path);
      continue;
    }
    // The suites run their packages' own scripts; of the root scripts only test:packages is theirs.
    const scripts = path === 'package.json' && manifests.get(path) && changedRootScripts(manifests.get(path));
    if (scripts) {
      if (scripts.includes('test:packages')) for (const suite of suites) if (suite.id !== EASTER_EGG_SUITE) select(suite.id, `${path}: its test:packages script changed`);
      continue;
    }
    shared(`${path}: every package suite and the easter egg install and run under it`);
  }
  return { fallback, suites: selected };
}

// `carriedChecks` maps a planned job (workspace-contracts, homepage-easter-egg)
// that did not pass in the base run to its failed jobs: it runs again in full.
export function createAppPlan(registry, changedPaths = [], graph = null, manifests = new Map(), { draft = false, release = false, carried = new Map(), carriedChecks = new Map() } = {}) {
  const affected = selectAffectedApps(registry, changedPaths, graph, manifests, { release, carried });
  // Drafts give fast feedback on app edits. Ready PRs always use the complete
  // dependency plan, including shared-code changes, at their current head.
  const selected = draft && changedPaths.length
    ? affected.apps.filter((app) => changedPaths.some((path) => path.startsWith(`apps/${app.id}/`) || path === `models/${app.id}.manifest.json`))
    : affected.apps;
  const { site, reasons } = affected;
  const releasable = selected.filter((app) => app.ci.release);
  const edited = changedPaths.filter((path) => !(affected.bookkeeping ?? []).includes(path));
  const heavy = (entry) => ({ ...entry, heavy_tests: editsApp(registry.apps.find((app) => app.id === entry.app), changedPaths, edited, carried) });
  const browserTested = selected.filter((app) => app.ci.browser_test);
  const gpuTested = selected.filter((app) => app.ci.hardware_gpu);
  // A draft runs the suites its change reaches, as a ready pull request does.
  // A plan of every app tests every package, as the nightly does.
  const checks = selectAffectedSuites(changedPaths, graph, manifests, { release });
  const everyApp = affected.reasons.fallback ?? (affected.apps.length === registry.apps.length ? 'its change reaches every app' : null);
  const failedThere = (job) => carriedChecks.has(job) ? [`failed in the base run (${carriedChecks.get(job).join(', ')})`] : [];
  const packageFallback = checks.fallback ?? (everyApp && `the plan selects every app: ${everyApp}`) ?? failedThere('workspace-contracts')[0] ?? null;
  const packageReasons = packageFallback ? {} : Object.fromEntries([...checks.suites].filter(([id]) => id !== EASTER_EGG_SUITE));
  const easterEgg = checks.fallback
    ? [checks.fallback]
    : [...(graph.edges.has(EASTER_EGG) ? checks.suites.get(EASTER_EGG_SUITE) ?? [] : ['ci.yml has no homepage-easter-egg job for the workspace graph to follow']), ...failedThere(EASTER_EGG_SUITE)];
  return Object.freeze({
    changedPaths: Object.freeze([...changedPaths]),
    selected: Object.freeze(selected),
    apps: Object.freeze({ include: Object.freeze(selected.map(matrixEntry)) }),
    browserApps: Object.freeze({ include: Object.freeze(browserTested.flatMap(shardedEntries).map(heavy)) }),
    gpuApps: Object.freeze({ include: Object.freeze(gpuTested.map(matrixEntry)) }),
    releaseApps: Object.freeze({ include: Object.freeze(releasable.map(matrixEntry)) }),
    allApps: selected.length === registry.apps.length,
    site: site || selected.length > 0,
    reasons: Object.freeze(reasons),
    bookkeeping: Object.freeze([...(affected.bookkeeping ?? [])]),
    // `all` says why every package suite runs; otherwise `reasons` maps each package directory it runs to its changes.
    packages: Object.freeze({ all: packageFallback || null, reasons: Object.freeze(packageReasons) }),
    // Why the homepage-easter-egg job runs; empty when it does not.
    easterEgg: Object.freeze([...easterEgg]),
  });
}

// Both sides of every rename and copy: a moved input changes what reads its old path.
export function changedPathsFromGit({ base, head = 'HEAD', cwd }) {
  if (!base || /^0+$/.test(base)) return [];
  try {
    return execFileSync('git', ['diff', '--no-renames', '--name-only', `${base}...${head}`], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).split('\n').map((path) => path.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

const MANIFEST = /^(?:(?:packages|apps|exes)\/[^/]+\/)?package\.json$|^registry\/(?:offline-assets\.lock\.json|apps\.yml|app-information\.yml|standalone\.json)$|^pnpm-lock\.yaml$|^\.gitattributes$|^\.github\/workflows\/ci\.yml$/;

// The text of each changed manifest (ci.yml included) and the lockfile for
// root manifest edits, at the merge base (changedPathsFromGit diffs from there)
// and at head. A manifest
// missing on either side, or every manifest when there is no merge base, is left
// out and counts as an ordinary code change.
export function changedManifests({ base, head = 'HEAD', cwd, changedPaths }) {
  const manifests = new Map();
  const paths = new Set(changedPaths.filter((path) => MANIFEST.test(path) || EMBEDDED_VERSION_FILES.has(path)));
  if (changedPaths.includes('package.json')) paths.add(LOCKFILE);
  if (!paths.size) return manifests;
  const show = (args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 });
  let mergeBase;
  try {
    mergeBase = show(['merge-base', base, head]).trim();
  } catch {
    return manifests;
  }
  for (const path of paths) {
    if (path === GITATTRIBUTES) {
      try {
        manifests.set(path, { files: attributeChanges({ base: mergeBase, head, cwd }) });
      } catch {
        // Without the attribute comparison the change stays shared.
      }
      continue;
    }
    try {
      manifests.set(path, { before: show(['show', `${mergeBase}:${path}`]), after: show(['show', `${head}:${path}`]) });
    } catch {
      // An added or deleted manifest is a code change like any other.
    }
  }
  return manifests;
}

// The files at `head` whose git attributes differ between `base` and `head`,
// as git itself resolves them from every .gitattributes in each tree. Only
// these can check out differently, so they are what an attribute change
// touches.
export function attributeChanges({ base, head, cwd }) {
  const git = (args, input) => execFileSync('git', args, { cwd, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 });
  const files = git(['ls-tree', '-r', '-z', '--name-only', head]);
  const attributes = (source) => {
    const fields = git(['check-attr', '--stdin', '-z', '-a', `--source=${source}`], files).split('\0');
    const byFile = new Map();
    for (let index = 0; index + 2 < fields.length; index += 3) {
      byFile.set(fields[index], [...(byFile.get(fields[index]) ?? []), `${fields[index + 1]}=${fields[index + 2]}`]);
    }
    return byFile;
  };
  const [before, after] = [attributes(base), attributes(head)];
  const key = (list) => (list ?? []).sort().join('\n');
  return files.split('\0').filter(Boolean).filter((file) => key(before.get(file)) !== key(after.get(file)));
}
