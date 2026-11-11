import { execFileSync } from 'node:child_process';
import { parse } from 'yaml';
import { LockfileAnalysisError, lockfileImpact } from './lockfile-impact.mjs';
import { CATALOG, INDEPENDENT_CONFIG, SITE, reachableFrom } from './workspace-graph.mjs';
import { validateAppInformation } from './app-information.mjs';
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

// The app entries a registry/apps.yml change touched, or why the change is
// shared: every app build embeds the site section's analytics id.
// The app entries a registry/standalone.json change touched, whether the
// suite (read only by the catalog page and the desktop bundle) changed, or why
// the change is shared. Every themed app build copies the file and validates
// all of it, but the shell renders only the app's own entry, so a valid head
// catalog reaches only the apps whose entries changed.
function standaloneImpact({ before, after }, registry) {
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

function registryImpact({ before, after }) {
  let old;
  let now;
  try {
    [old, now] = [parse(before), parse(after)];
  } catch (error) {
    return { shared: `it does not parse (${error.message})` };
  }
  const section = [...new Set([...Object.keys(old ?? {}), ...Object.keys(now ?? {})])].find((key) => key !== 'apps' && !same(old?.[key], now?.[key]));
  if (section) return { shared: `its ${section} section changed, and every app build reads it` };
  const entries = (registry) => (Array.isArray(registry?.apps) ? registry.apps : []);
  const byId = (registry) => new Map(entries(registry).map((app) => [app?.id, app]));
  const [was, is] = [byId(old), byId(now)];
  if (was.size !== entries(old).length || is.size !== entries(now).length || was.has(undefined) || is.has(undefined)) {
    return { shared: 'its app entries have missing or duplicate ids' };
  }
  return { changed: [...new Set([...was.keys(), ...is.keys()])].filter((id) => !same(was.get(id), is.get(id))) };
}

function shardedEntries(app) {
  const total = app.ci.e2e_shards ?? 1;
  return Array.from({ length: total }, (_, index) => ({ ...matrixEntry(app), shard: total > 1 ? `${index + 1}/${total}` : '' }));
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
export function selectAffectedApps(registry, changedPaths = [], graph = null, manifests = new Map()) {
  const everything = (fallback) => ({ apps: registry.apps, site: true, reasons: { fallback, apps: {}, site: [] } });
  if (!changedPaths.length) return everything('no changed paths: no base revision, an unreadable diff, or a full run');

  const appIds = new Set(registry.apps.map((app) => app.id));
  const reach = graph && new Map(registry.apps.map((app) => [app.id, reachableFrom(graph, `apps/${app.id}`)]));
  const catalog = graph && reachableFrom(graph, CATALOG);
  const site = graph && reachableFrom(graph, SITE);
  const appReasons = new Map();
  const siteReasons = [];
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
    // A package's tests reach only the apps that read them; any other file
    // reaches its package's users and, if a root file names it, that file's.
    const packageTests = path.match(/^packages\/[^/]+\/tests?(?=\/)/)?.[0];
    const document = /^(?:packages|exes)\/.*\.md$/.test(path) && path;
    const nodes = packageTests || document
      ? [packageTests || document]
      : [path.match(/^(packages|exes)\/[^/]+(?=\/)/)?.[0], ROOT_FILE.test(path) || graph?.edges.has(path) ? path : null].filter(Boolean);
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

  if (fallback) return everything(fallback);
  if (appReasons.has('qsmbly')) select('brain-extraction', 'qsmbly is selected and Brain extraction ships its runtime');
  const apps = registry.apps.filter((app) => appReasons.has(app.id));
  return {
    apps,
    site: siteReasons.length > 0,
    reasons: { fallback: null, apps: Object.fromEntries(apps.map((app) => [app.id, appReasons.get(app.id)])), site: siteReasons },
  };
}

export function createAppPlan(registry, changedPaths = [], graph = null, manifests = new Map(), { draft = false } = {}) {
  const affected = selectAffectedApps(registry, changedPaths, graph, manifests);
  // Drafts give fast feedback on app edits. Ready PRs always use the complete
  // dependency plan, including shared-code changes, at their current head.
  const selected = draft && changedPaths.length
    ? affected.apps.filter((app) => changedPaths.some((path) => path.startsWith(`apps/${app.id}/`) || path === `models/${app.id}.manifest.json`))
    : affected.apps;
  const { site, reasons } = affected;
  const releasable = selected.filter((app) => app.ci.release);
  const browserTested = selected.filter((app) => app.ci.browser_test);
  const gpuTested = selected.filter((app) => app.ci.hardware_gpu);
  return Object.freeze({
    changedPaths: Object.freeze([...changedPaths]),
    selected: Object.freeze(selected),
    apps: Object.freeze({ include: Object.freeze(selected.map(matrixEntry)) }),
    browserApps: Object.freeze({ include: Object.freeze(browserTested.flatMap(shardedEntries)) }),
    gpuApps: Object.freeze({ include: Object.freeze(gpuTested.map(matrixEntry)) }),
    releaseApps: Object.freeze({ include: Object.freeze(releasable.map(matrixEntry)) }),
    allApps: selected.length === registry.apps.length,
    site: site || selected.length > 0,
    reasons: Object.freeze(reasons),
  });
}

export function changedPathsFromGit({ base, head = 'HEAD', cwd }) {
  if (!base || /^0+$/.test(base)) return [];
  try {
    return execFileSync('git', ['diff', '--name-only', `${base}...${head}`], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).split('\n').map((path) => path.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

const MANIFEST = /^(?:(?:packages|apps|exes)\/[^/]+\/)?package\.json$|^registry\/(?:offline-assets\.lock\.json|apps\.yml|app-information\.yml|standalone\.json)$|^pnpm-lock\.yaml$|^\.gitattributes$/;

// The text of each changed manifest and the lockfile for root manifest edits,
// at the merge base (changedPathsFromGit diffs from there) and at head. A manifest
// missing on either side, or every manifest when there is no merge base, is left
// out and counts as an ordinary code change.
export function changedManifests({ base, head = 'HEAD', cwd, changedPaths }) {
  const manifests = new Map();
  const paths = new Set(changedPaths.filter((path) => MANIFEST.test(path)));
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
