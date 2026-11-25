import { execFileSync } from 'node:child_process';
import sourceParser from '@neurodesk/code-quality';
import { isAlias, isMap, isScalar, isSeq, parse, parseDocument } from 'yaml';
import { LockfileAnalysisError, lockfileImpact } from './lockfile-impact.mjs';
import { onlyAddsExports } from './module-closure.mjs';
import { EMBEDDED_VERSION_FILES, releaseBookkeeping } from './release-bookkeeping.mjs';
import { CATALOG, INDEPENDENT_CONFIG, SITE, reachableFrom } from './workspace-graph.mjs';
import { handoffCatalogEntry, validateAppInformation } from './app-information.mjs';
import { appCatalogIds, parseAppsRegistry } from './apps-registry.mjs';
import { validateStandalone } from './standalone.mjs';

const NON_CODE_PREFIXES = ['docs/', '.changeset/'];
// Self-contained packages outside apps/ with their own CI job (the homepage
// easter egg and its leaderboard worker run under `homepage-easter-egg`).
// Changes there select no catalog apps. Shared homepage files directly under
// site/ still count as shared changes.
const SELF_CONTAINED_PREFIXES = ['site/easter-eggs/'];
// Paths no app build or browser test reads. Every workflow other than ci.yml
// runs itself when it changes; the app template is checked by contract tests.
const INDEPENDENT_CHECK_PATHS = [
  /^[^/]+\.md$/,
  /^\.gitignore$/,
  /^\.github\/workflows\/(?!ci\.yml$)[^/]+$/,
  INDEPENDENT_CONFIG,
  /^config\/dependency-/,
  /^templates\//,
];
// Lint and quality tooling run in workspace-contracts or quality.yml rather
// than app builds; exempt them only when the workspace graph confirms neither
// CATALOG, SITE nor any app (outside the lint runner itself) reaches them.
const LINT_RUNNER = /^scripts\/lint\.mjs$/;
const LINT_TOOLING_PATHS = [LINT_RUNNER, /^scripts\/quality\//];
// Root files the workspace graph follows. Without a graph they count as shared.
const ROOT_FILE = /^(?:scripts|test-utils|registry|test)\//;
// An app's model manifest belongs to that app alone.
const MODEL_MANIFEST = /^models\/([^/]+)\.manifest\.json$/;
const NON_CODE_FILES = new Set(['README.md', 'LICENSES.md']);
const LOCKFILE = 'pnpm-lock.yaml';
const WORKSPACE_CONFIG = 'pnpm-workspace.yaml';
const E2E_TEST_DATA = 'scripts/lib/e2e-test-data.mjs';
const REGISTRY = 'registry/apps.yml';
const STANDALONE = 'registry/standalone.json';
const APP_INFORMATION = 'registry/app-information.yml';
// Root tools no per-app or composite-site job executes: Knip and Stryker run
// in the quality workflow's unused-code and mutation jobs, ESLint
// (scripts/lint.mjs, eslint.config.js) in workspace-contracts and its
// correctness job on every pull request. test/app-plan.test.mjs fails when an app's CI scripts load one.
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
// analytics settings, the Pages 404 page and the dicompare route shim.
// test/app-plan.test.mjs fails when anything else names them.
export const SITE_ONLY_FILES = new Set(['site/landing.css', 'site/landing.js', 'site/analytics.json', 'site/404.html', 'site/dicompare-routes.js']);
// Theme stylesheets and fonts copied into every app's themed dist/ by
// theme-app-dist.mjs and build-site.mjs: they affect rendered UI, never unit
// tests or WASM compilation, so composite-site + all 5 site-* checks over the
// full catalog (siteCode = true) test them, together with apps whose own build
// or e2e tests directly load site/app-theme.css (SITE_THEME_CONSUMERS).
export const SITE_THEME_FILES = new Set(['site/app-theme.css']);
export const SITE_THEME_CONSUMERS = Object.freeze(['surfannotate', 'zarro']);
const CI_WORKFLOW = '.github/workflows/ci.yml';
// What each ci.yml job tests, for a change confined to it: the composite site
// (`site`: composite-site and the jobs that only consume its build), the
// homepage easter egg (`easter-egg`), nothing more than the run itself
// (`every-run`: workspace-contracts and package-tests run on every ready/push run, so
// their own run tests the change), or nothing (`none`: the plan's marker jobs). The plan, the
// per-app jobs, a job not listed here and every key outside `jobs` reach
// every app. test/app-plan.test.mjs holds the list to ci.yml.
export const CI_JOB_SCOPES = Object.freeze({
  'composite-site': 'site',
  'site-runtime': 'site',
  'site-audit': 'site',
  'site-e2e': 'site',
  'site-mobile': 'site',
  'site-catalog': 'site',
  'processing-workflows': 'site',
  'agent-interactions': 'site',
  'example-cache-retention': 'site',
  'turbo-cache-retention': 'site',
  'workspace-contracts': 'every-run',
  'package-tests': 'every-run',
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
  ['site.catalogs[].webmcp_origin_trial', CATALOG_ENTRY],
  ...keys('site.catalogs[].desktop', ['product_name', 'app_id', 'release', 'executable'], DESKTOP_SUITE),
  ['site.analytics.measurement_id', ['scripts/theme-app-dist.mjs', 'scripts/lib/vite-app-config.mjs', 'scripts/dev-server.mjs']],
  ['site.analytics.period_days', []],
  ...keys('site.categories[]', ['id', 'title', 'description'], []),
].map(([key, readers]) => [key, Object.freeze(readers)])));
// The site keys no app page carries. The composite build writes an app's home
// catalogue id, host, title and brand and the analytics id into each page it
// assembles (hostedThemeOptions in scripts/lib/catalog-sites.mjs), and the
// per-app site checks read those pages, so a change to any other site key
// makes them check every app. test/app-plan.test.mjs changes each key listed
// here and requires every app's theme options to stay the same.
export const SITE_DATA_KEYS = Object.freeze([
  'site.domain',
  ...keys('site.hub', ['host', 'title', 'heading', 'description', ...BRAND_KEYS], []).map(([key]) => key),
  ...keys('site.catalogs[]', ['hosting', 'heading', 'description'], []).map(([key]) => key),
  ...keys('site.catalogs[].desktop', ['product_name', 'app_id', 'release', 'executable'], []).map(([key]) => key),
  'site.analytics.period_days',
  ...keys('site.categories[]', ['id', 'title', 'description'], []).map(([key]) => key),
]);

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

// Site key paths are arrays of raw segments, `[]` standing for each entry of
// a list, and are compared only as arrays: SITE_KEY_READERS' dotted names are
// split once, into a table keyed by the segments' JSON. A raw key that
// contains a delimiter (`brand.home` written as one key) or is empty can
// never equal a table path, so it is a key the table does not name.
const siteSegments = (name) => name.split('.').flatMap((part) => (part.endsWith('[]') ? [part.slice(0, -2), '[]'] : [part]));
const SITE_TABLE = new Map(Object.entries(SITE_KEY_READERS).map(([name, readers]) => [JSON.stringify(siteSegments(name)), { name, readers }]));
const siteEntry = (segments) => SITE_TABLE.get(JSON.stringify(segments));
// Whether some table path continues `segments` (a mapping or list the table names).
const siteContainer = (segments) => [...SITE_TABLE.keys()].some((key) => {
  const path = JSON.parse(key);
  return path.length > segments.length && segments.every((segment, index) => path[index] === segment);
});
const plainKey = (key) => key !== '' && key !== '[]' && !/[.[\]]/.test(key);
const showSegments = (segments) => segments.map((segment, index) => (segment === '[]' ? '[]' : plainKey(segment) ? `${index ? '.' : ''}${segment}` : `[${JSON.stringify(segment)}]`)).join('');

// The site key paths two registries differ in: lists of entries with unique
// ids compare entry by entry (`[]`), and an entry that is added, removed or
// moved changes `[]`/`id` and every key below it. Any other list that changed
// is one path the table does not name.
function changedSiteKeys(old, now, path = ['site']) {
  if (same(old, now)) return [];
  const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const entries = (value) => Array.isArray(value) && value.every((entry) => record(entry) && typeof entry.id === 'string') && new Set(value.map((entry) => entry.id)).size === value.length;
  if (entries(old) && entries(now)) {
    const [before, after] = [new Map(old.map((entry) => [entry.id, entry])), new Map(now.map((entry) => [entry.id, entry]))];
    const moved = same(old.map((entry) => entry.id), now.map((entry) => entry.id)) ? [] : [[...path, '[]', 'id']];
    return [...moved, ...[...new Set([...before.keys(), ...after.keys()])].flatMap((id) => changedSiteKeys(before.get(id), after.get(id), [...path, '[]']))];
  }
  if ((record(old) || old === undefined) && (record(now) || now === undefined)) {
    return [...new Set([...Object.keys(old ?? {}), ...Object.keys(now ?? {})])].flatMap((key) => changedSiteKeys(old?.[key], now?.[key], [...path, key]));
  }
  return [path];
}

// The fields of an app entry the planner has classified. Each reaches the
// app's own build and jobs and the site build (landing page, 404 table,
// desktop suite). Every app page also carries the handoff catalog
// (handoffCatalogEntry, on the hosts appCatalogIds names), which the apps
// naming HANDOFF_CATALOG_READERS render; the planner compares that projection
// itself. A change to any other field could reach any app.
export const CLASSIFIED_ENTRY_FIELDS = Object.freeze([
  'id', 'path', 'catalog', 'also_in', 'title', 'description', 'categories', 'keywords', 'anatomy', 'modalities',
  'inputs', 'hardware', 'legacy_domain', 'runtime', 'model_manifest', 'asset_manifest_schema', 'artifact_budget_bytes',
  'source', 'license', 'maintainers', 'support_status', 'shell', 'app_scoped_runtime_families', 'ci', 'remote_compute',
  'handoff', 'former_paths',
]);
// The handoff module's functions that read the catalog an app page carries
// (packages/components/src/handoff/index.js); test/app-plan.test.mjs holds
// the list to that module.
export const HANDOFF_CATALOG_READERS = Object.freeze(['handoffTargets']);

// What another app's handoff menu shows of an app entry, or null for none.
function handoffMenuEntry(app) {
  const entry = app ? handoffCatalogEntry(app) : null;
  return entry ? { ...entry, hosts: appCatalogIds(app) } : null;
}

// The first path in a site section that SITE_KEY_READERS does not name: a key
// it does not list at any depth or that holds a delimiter, or a value of
// another kind than the table gives its path (a mapping or list where it
// lists a scalar, or the reverse). An empty mapping under a new key is a path
// the table does not name too.
function unknownSiteKey(value, path = ['site']) {
  if (Array.isArray(value)) {
    if (!siteContainer([...path, '[]'])) return path;
    return value.reduce((issue, entry) => issue ?? unknownSiteKey(entry, [...path, '[]']), null);
  }
  if (value !== null && typeof value === 'object') {
    if (!siteContainer(path)) return path;
    return Object.entries(value).reduce((issue, [name, child]) => issue ?? (plainKey(name) ? unknownSiteKey(child, [...path, name]) : [...path, name]), null);
  }
  return siteEntry(path) ? null : path;
}

// The app entries and site keys a registry/apps.yml change touched, whether
// an entry changed what other apps' handoff menus list (`menu`), whether the
// set of registered ids changed (`registered`), or why the change is shared.
// Every app build validates the whole registry, so a site change narrows only
// when the head registry is valid.
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
  const siteKeys = [...new Map(changedSiteKeys(old?.site, now?.site).map((key) => [JSON.stringify(key), key])).values()];
  if (!same(old?.site, now?.site)) {
    try {
      parseAppsRegistry(after);
    } catch (error) {
      return { shared: `it is not valid at head (${error.message.split('\n').slice(0, 2).join(' ')}), and every app build validates it` };
    }
    const unknown = unknownSiteKey(old?.site) ?? unknownSiteKey(now?.site) ?? siteKeys.find((key) => !siteEntry(key));
    if (unknown) return { shared: `its site section has ${showSegments(unknown)}, and no rule says which builds read it` };
  }
  const entries = (registry) => (Array.isArray(registry?.apps) ? registry.apps : []);
  const byId = (registry) => new Map(entries(registry).map((app) => [app?.id, app]));
  const [was, is] = [byId(old), byId(now)];
  if (was.size !== entries(old).length || is.size !== entries(now).length || was.has(undefined) || is.has(undefined)) {
    return { shared: 'its app entries have missing or duplicate ids' };
  }
  const changed = [...new Set([...was.keys(), ...is.keys()])].filter((id) => !same(was.get(id), is.get(id)));
  for (const id of changed) {
    const fields = [...new Set([...Object.keys(was.get(id) ?? {}), ...Object.keys(is.get(id) ?? {})])];
    const unknown = fields.find((field) => !CLASSIFIED_ENTRY_FIELDS.includes(field) && !same(was.get(id)?.[field], is.get(id)?.[field]));
    if (unknown) return { shared: `the ${id} entry's ${unknown} field is not one the planner classifies` };
  }
  return {
    changed,
    menu: changed.some((id) => !same(handoffMenuEntry(was.get(id)), handoffMenuEntry(is.get(id)))),
    registered: !same([...was.keys()].sort(), [...is.keys()].sort()),
    siteKeys,
  };
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

const EXACT_PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const MAX_PACKAGE_NAME_LENGTH = 214;
const MAX_SEMVER_LENGTH = 256;
const SEMVER_NUM = '(?:0|[1-9]\\d*)';
const SEMVER_PRE = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)';
// Strict SemVer 2.0.0 without build metadata (+build), which pnpm normalizes
// away when matching minimumReleaseAgeExclude against locked versions.
const EXACT_SEMVER = new RegExp(`^${SEMVER_NUM}\\.${SEMVER_NUM}\\.${SEMVER_NUM}(?:-${SEMVER_PRE}(?:\\.${SEMVER_PRE})*)?$`);
// Plain scalars interpreted differently across YAML 1.1 (js-yaml) and YAML 1.2.
const AMBIGUOUS_PLAIN_YAML = /^(?:y|yes|n|no|true|false|on|off|~|null|0[0-7]+|[+-]?0[0-7]+)$/i;

// Printable ASCII plus tab/CR/LF: excludes control chars (e.g. U+0001), BOM,
// and non-ASCII line breaks that YAML parsers (yaml vs js-yaml/pnpm) disagree on.
const SAFE_YAML_TEXT = /^[\t\n\r\x20-\x7E]*$/;
const SAFE_YAML_STRING = /^[\x20-\x7E]*$/;

function isPlainJsonValue(value) {
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'string') return SAFE_YAML_STRING.test(value);
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isPlainJsonValue);
  if (typeof value !== 'object') return false;
  if (Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Object.values(value).every(isPlainJsonValue);
}

function isExactPnpmSemver(version) {
  if (version.length > MAX_SEMVER_LENGTH || !EXACT_SEMVER.test(version)) return false;
  const dash = version.indexOf('-');
  const core = dash < 0 ? version : version.slice(0, dash);
  const pre = dash < 0 ? undefined : version.slice(dash + 1);
  if (!core.split('.').every((part) => part.length <= 16 && Number.isSafeInteger(Number(part)))) return false;
  if (pre !== undefined) {
    for (const part of pre.split('.')) {
      if (/^\d+$/.test(part) && (part.length > 16 || !Number.isSafeInteger(Number(part)))) return false;
    }
  }
  return true;
}

function unsafeYamlReason(node) {
  if (!node || typeof node !== 'object') return null;
  if (isAlias(node) || Boolean(node.anchor)) return 'it uses YAML anchors or aliases';
  if (node.tag) return 'it uses explicit YAML tags';
  if (isMap(node)) {
    for (const pair of node.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== 'string') return 'it uses non-string YAML keys';
      if (pair.key.tag || pair.key.anchor) return 'it uses tagged or anchored YAML keys';
      if (pair.key.value === '<<' || pair.key.value === '__proto__') return 'it uses YAML merge or prototype keys';
      const nested = unsafeYamlReason(pair.value);
      if (nested) return nested;
    }
    return null;
  }
  if (isSeq(node)) {
    for (const item of node.items) {
      const nested = unsafeYamlReason(item);
      if (nested) return nested;
    }
    return null;
  }
  if (isScalar(node)) {
    const src = typeof node.source === 'string' ? node.source : null;
    if (typeof node.value === 'number' && src !== null && (/^[+-]?0\d/.test(src) || /[_:]/.test(src))) {
      return 'it uses ambiguous numeric YAML literals';
    }
    if (typeof node.value === 'boolean' && src !== null && src !== 'true' && src !== 'false') {
      return 'it uses non-canonical YAML boolean literals';
    }
    if (typeof node.value === 'string' && node.type === 'PLAIN' && AMBIGUOUS_PLAIN_YAML.test(node.value)) {
      return 'it uses YAML 1.1-ambiguous plain scalars';
    }
  }
  return null;
}

function parseSafeWorkspaceYaml(text) {
  if (typeof text !== 'string' || !SAFE_YAML_TEXT.test(text)) {
    return { error: 'it contains control or non-ASCII characters that YAML parsers handle differently' };
  }
  const doc12 = parseDocument(text, { schema: 'core', uniqueKeys: true });
  if (doc12.errors.length) return { error: `it does not parse (${doc12.errors[0].message.split('\n')[0]})` };
  if (doc12.warnings.length) return { error: `it has YAML warnings (${doc12.warnings[0].message.split('\n')[0]})` };
  if (doc12.directives.yaml.explicit || Object.keys(doc12.directives.tags).some((tag) => tag !== '!!')) {
    return { error: 'it uses explicit YAML directives' };
  }
  if (!isMap(doc12.contents) || doc12.contents.flow) return { error: 'it is not a block YAML mapping' };
  const unsafe = unsafeYamlReason(doc12.contents);
  if (unsafe) return { error: unsafe };
  // Parse under YAML 1.1 as well (matching js-yaml / pnpm) and reject any scalar
  // that resolves to a non-JSON type (such as an unquoted ISO Date) or differs
  // between YAML 1.1 and YAML 1.2.
  const doc11 = parseDocument(text, { schema: 'yaml-1.1', uniqueKeys: true });
  if (doc11.errors.length || doc11.warnings.length || !isMap(doc11.contents)) {
    return { error: 'it does not parse identically under YAML 1.1 and 1.2' };
  }
  const [val12, val11] = [doc12.toJS(), doc11.toJS()];
  if (!same(val12, val11)) {
    return { error: 'it contains YAML scalars whose meaning differs between YAML 1.1 and 1.2' };
  }
  if (!isPlainJsonValue(val12) || !isPlainJsonValue(val11)) {
    return { error: 'it contains non-plain or control-character YAML scalars' };
  }
  return { doc: doc12, value: val12 };
}

const RELEASE_AGE_HEADER = /^minimumReleaseAgeExclude: *(?:#[^\r\n]*)?$/;
const RELEASE_AGE_EMPTY = /^minimumReleaseAgeExclude: *\[\] *(?:#[^\r\n]*)?$/;
const RELEASE_AGE_BLANK = /^ *(?:#[^\r\n]*)?$/;
const RELEASE_AGE_ITEM = /^( *)- +(?:[A-Za-z0-9][A-Za-z0-9@._/| -]*|'[A-Za-z0-9@._/| -]+'|"[A-Za-z0-9@._/| -]+") *(?:#[^\r\n]*)?$/;
const SIMPLE_SCALAR_TYPES = new Set(['PLAIN', 'QUOTE_SINGLE', 'QUOTE_DOUBLE']);

function stripReleaseAgeSection(text, doc) {
  const pair = doc.contents.items.find((item) => isScalar(item.key) && item.key.value === 'minimumReleaseAgeExclude');
  if (!pair) return { outside: text, section: null, pair: null };
  if (!pair.key.range || !pair.value?.range) return { error: 'its minimumReleaseAgeExclude range cannot be determined' };
  const [start] = pair.key.range;
  const end = pair.value.range[2];
  if ((start > 0 && text[start - 1] !== '\n') || (end < text.length && text[end - 1] !== '\n')) {
    return { error: 'its minimumReleaseAgeExclude section is not on clean line boundaries' };
  }
  return { outside: text.slice(0, start) + text.slice(end), section: text.slice(start, end), pair };
}

function isSafeReleaseAgeSection(section, pair) {
  if (section === null) return true;
  if (!isSeq(pair.value)) return false;
  const lines = section.replace(/\r?\n$/, '').split(/\r?\n/);
  if (lines.length === 1) {
    return pair.value.items.length === 0 && RELEASE_AGE_EMPTY.test(lines[0]);
  }
  if (pair.value.flow || !RELEASE_AGE_HEADER.test(lines[0])) return false;
  if (!pair.value.items.every((item) => isScalar(item) && SIMPLE_SCALAR_TYPES.has(item.type))) return false;
  let indent = null;
  for (const line of lines.slice(1)) {
    if (RELEASE_AGE_BLANK.test(line)) continue;
    const match = line.match(RELEASE_AGE_ITEM);
    if (!match) return false;
    if (indent === null) indent = match[1].length;
    else if (match[1].length !== indent) return false;
  }
  return true;
}

function parseReleaseAgeExclusions(value) {
  if (value === undefined) return new Set();
  if (!Array.isArray(value)) return null;
  const seenNames = new Set();
  const specs = new Set();
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length > MAX_SEMVER_LENGTH || entry !== entry.trim()) return null;
    const at = entry.indexOf('@', 1);
    if (at < 0) return null;
    const name = entry.slice(0, at);
    if (name.length > MAX_PACKAGE_NAME_LENGTH || !EXACT_PACKAGE_NAME.test(name) || seenNames.has(name)) return null;
    seenNames.add(name);
    const rawVersionSpec = entry.slice(at + 1);
    if (!rawVersionSpec || /^\s/.test(rawVersionSpec) || rawVersionSpec.length > MAX_SEMVER_LENGTH) return null;
    const rawParts = rawVersionSpec.split('||');
    if (!rawParts.length || !rawParts.every((part) => part.length <= MAX_SEMVER_LENGTH && isExactPnpmSemver(part.trim()))) return null;
    for (const part of rawParts) specs.add(`${name}@${part.trim()}`);
  }
  return specs;
}

// Whether a pnpm-workspace.yaml change is confined to valid exact-version
// minimumReleaseAgeExclude entries whose removals (if any) are no longer
// resolved in pnpm-lock.yaml at head. Adding exact-version exclusions only
// relaxes pnpm's release-age check, while pnpm-lock.yaml pins and scopes every
// resolved dependency; removing an exclusion for a package still locked at head
// could break frozen installs and falls back to the complete catalog.
export function workspaceConfigImpact({ before, after, lockAfter }) {
  const [oldDoc, nowDoc] = [parseSafeWorkspaceYaml(before), parseSafeWorkspaceYaml(after)];
  if (oldDoc.error) return { shared: oldDoc.error };
  if (nowDoc.error) return { shared: nowDoc.error };
  const [old, now] = [oldDoc.value, nowDoc.value];
  try {
    const key = [...new Set([...Object.keys(old), ...Object.keys(now)])].find((name) => name !== 'minimumReleaseAgeExclude' && !same(old[name], now[name]));
    if (key) return { shared: `its ${key} setting changed` };
  } catch (error) {
    return { shared: `its settings cannot be compared (${error.message.split('\n')[0]})` };
  }
  const [oldSection, nowSection] = [stripReleaseAgeSection(before, oldDoc.doc), stripReleaseAgeSection(after, nowDoc.doc)];
  if (oldSection.error) return { shared: oldSection.error };
  if (nowSection.error) return { shared: nowSection.error };
  if (oldSection.outside !== nowSection.outside) return { shared: 'raw YAML outside minimumReleaseAgeExclude changed' };
  if (!isSafeReleaseAgeSection(nowSection.section, nowSection.pair)) {
    return { shared: 'its minimumReleaseAgeExclude section uses non-standard YAML syntax' };
  }
  const [oldSpecs, nowSpecs] = [parseReleaseAgeExclusions(old.minimumReleaseAgeExclude), parseReleaseAgeExclusions(now.minimumReleaseAgeExclude)];
  if (!oldSpecs || !nowSpecs) return { shared: 'its minimumReleaseAgeExclude entries must be unique exact package@version specs' };
  const removed = [...oldSpecs].filter((spec) => !nowSpecs.has(spec));
  if (removed.length) {
    if (!lockAfter) return { shared: `removed minimumReleaseAgeExclude entries (${removed.join(', ')}) without a head lockfile to verify` };
    let lock;
    try {
      lock = parse(lockAfter);
    } catch (error) {
      return { shared: `head pnpm-lock.yaml does not parse (${error.message.split('\n')[0]})` };
    }
    const packages = lock?.packages && typeof lock.packages === 'object' && !Array.isArray(lock.packages) ? Object.keys(lock.packages) : null;
    if (!packages) return { shared: 'head pnpm-lock.yaml has no packages section to verify removed release-age exclusions' };
    const stillLocked = removed.find((spec) => packages.some((key) => key === spec || key.startsWith(`${spec}(`)));
    if (stillLocked) return { shared: `removed minimumReleaseAgeExclude entry ${stillLocked} is still resolved by pnpm-lock.yaml` };
  }
  return { scoped: true };
}

const AST_META = new Set(['loc', 'range', 'start', 'end', 'tokens', 'comments', 'parent']);
const TABLE_NAMES = new Set(['provisioners', 'unpublished']);

function stripAst(value, cleared) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') return `${value}n`;
  if (value instanceof RegExp) return value.toString();
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => stripAst(item, cleared));
  const out = {};
  for (const key of Object.keys(value)) {
    if (AST_META.has(key)) continue;
    if (key === 'properties' && cleared?.has(value)) {
      out[key] = [];
      continue;
    }
    out[key] = stripAst(value[key], cleared);
  }
  return out;
}

function referencesTable(value) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(referencesTable);
  if (value.type === 'Identifier' && TABLE_NAMES.has(value.name)) return true;
  return Object.keys(value).some((key) => !AST_META.has(key) && referencesTable(value[key]));
}

function plainPropKey(prop) {
  if (prop.type !== 'Property' || prop.computed || prop.kind !== 'init') return null;
  const key = prop.key?.type === 'Identifier' ? prop.key.name : prop.key?.type === 'Literal' && typeof prop.key.value === 'string' ? prop.key.value : null;
  return key === null || key === '__proto__' ? null : key;
}

function isPureFlagHelper(declarator) {
  const fn = declarator.init;
  if (fn?.type !== 'ArrowFunctionExpression' || fn.async || fn.params.length !== 1 || fn.params[0]?.type !== 'Identifier') return false;
  const param = fn.params[0].name;
  if (fn.body?.type !== 'ObjectExpression') return false;
  const props = new Map();
  for (const prop of fn.body.properties) {
    const key = plainPropKey(prop);
    if (!key || prop.method || props.has(key)) return false;
    props.set(key, prop.value);
  }
  if (props.size !== 2 || !props.has('env') || !props.has('provision')) return false;
  const env = props.get('env');
  const provision = props.get('provision');
  return env?.type === 'ArrayExpression'
    && env.elements.length === 1
    && env.elements[0]?.type === 'Identifier'
    && env.elements[0].name === param
    && (provision?.type === 'ArrowFunctionExpression' || provision?.type === 'FunctionExpression');
}

function isPureProvisionerObject(node, { allowCpu, topLevelFunctions }) {
  if (node?.type !== 'ObjectExpression') return false;
  const seen = new Set();
  for (const prop of node.properties) {
    const key = plainPropKey(prop);
    if (!key || prop.method || seen.has(key)) return false;
    seen.add(key);
    if (key === 'env') {
      if (prop.value?.type !== 'ArrayExpression') return false;
      if (!prop.value.elements.every((el) => el && el.type === 'Literal' && typeof el.value === 'string')) return false;
    } else if (key === 'provision') {
      const value = prop.value;
      const isFn = value?.type === 'ArrowFunctionExpression'
        || value?.type === 'FunctionExpression'
        || (value?.type === 'Identifier' && topLevelFunctions.has(value.name));
      if (!isFn) return false;
    } else if (key === 'cpu' && allowCpu) {
      if (!isPureProvisionerObject(prop.value, { allowCpu: false, topLevelFunctions })) return false;
    } else {
      return false;
    }
  }
  return seen.has('env') && seen.has('provision');
}

function isPureProvisionerEntry(node, context) {
  if (context.hasPureFlag
    && node?.type === 'CallExpression'
    && !node.optional
    && node.callee?.type === 'Identifier'
    && node.callee.name === 'flag'
    && node.arguments.length === 1
    && node.arguments[0]?.type === 'Literal'
    && typeof node.arguments[0].value === 'string') {
    return true;
  }
  return isPureProvisionerObject(node, { allowCpu: true, topLevelFunctions: context.topLevelFunctions });
}

function checkNodeEsmSyntax(source) {
  execFileSync(process.execPath, ['--input-type=module', '--check'], {
    input: source,
    stdio: ['pipe', 'ignore', 'pipe'],
  });
}

function parseE2eTables(source) {
  const ast = sourceParser.parse(source, { filePath: E2E_TEST_DATA, sourceType: 'module' });
  const tables = new Map();
  // Function declarations are hoisted; const bindings are only initialized if
  // declared strictly before `export const provisioners` (no TDZ hazard).
  const hoistedFunctions = new Set();
  const initializedConsts = new Set();
  let seenProvisioners = false;
  let hasPureFlag = false;
  for (const statement of ast.body) {
    if (statement.type === 'FunctionDeclaration' && statement.id?.type === 'Identifier') {
      hoistedFunctions.add(statement.id.name);
      continue;
    }
    if (statement.type === 'VariableDeclaration' && statement.kind === 'const') {
      if (!seenProvisioners) {
        for (const declarator of statement.declarations) {
          if (declarator.id?.type !== 'Identifier') continue;
          if (declarator.id.name === 'flag' && isPureFlagHelper(declarator)) hasPureFlag = true;
          if (declarator.init?.type === 'ArrowFunctionExpression' || declarator.init?.type === 'FunctionExpression') {
            initializedConsts.add(declarator.id.name);
          }
        }
      }
      continue;
    }
    if (statement.type !== 'ExportNamedDeclaration' || statement.declaration?.type !== 'VariableDeclaration' || statement.declaration.kind !== 'const') continue;
    for (const declarator of statement.declaration.declarations) {
      if (declarator.id?.type !== 'Identifier' || !TABLE_NAMES.has(declarator.id.name)) continue;
      if (tables.has(declarator.id.name) || declarator.init?.type !== 'ObjectExpression') return null;
      tables.set(declarator.id.name, declarator.init);
      if (declarator.id.name === 'provisioners') seenProvisioners = true;
    }
  }
  if (!tables.has('provisioners')) return null;
  const context = { hasPureFlag, topLevelFunctions: new Set([...hoistedFunctions, ...initializedConsts]) };
  const entries = new Map();
  for (const [tableName, objectNode] of tables) {
    const map = new Map();
    for (const prop of objectNode.properties) {
      const key = plainPropKey(prop);
      if (key === null || prop.method || map.has(key)) return null;
      if (tableName === 'unpublished') {
        if (prop.value?.type !== 'Literal' || typeof prop.value.value !== 'string') return null;
      } else {
        if (!isPureProvisionerEntry(prop.value, context) || referencesTable(prop.value)) return null;
      }
      map.set(key, JSON.stringify(stripAst(prop.value)));
    }
    entries.set(tableName, map);
  }
  const cleared = new Set(tables.values());
  return { skeleton: JSON.stringify(stripAst(ast.body, cleared)), provisioners: entries.get('provisioners') };
}

// The apps whose provisioner entries changed in scripts/lib/e2e-test-data.mjs,
// or why the change reaches every app. Edits confined to reviewed pure-at-load
// entries of `provisioners` (or plain string entries of `unpublished`, checked
// by workspace-contracts) affect only those apps; any change to imports, shared
// helpers, `provisionTestData`, side-effectful initializers, prototype keys,
// TDZ-unsafe bindings, or Node ESM syntax errors falls back to the complete catalog.
export function e2eTestDataImpact({ before, after }) {
  let old;
  let now;
  try {
    old = parseE2eTables(before);
    now = parseE2eTables(after);
  } catch (error) {
    return { shared: `it does not parse (${error.message.split('\n')[0]})` };
  }
  if (!old || !now) return { shared: 'its provisioners table cannot be isolated safely' };
  if (old.skeleton !== now.skeleton) return { shared: 'shared code outside provisioners and unpublished changed' };
  // Validate the head module with Node's own V8 ESM parser so strict-mode early
  // errors accepted by @typescript-eslint/parser (such as duplicate parameters)
  // cannot silently break the shared module for unselected apps.
  try {
    checkNodeEsmSyntax(after);
  } catch (error) {
    const detail = String(error.stderr || error.message).trim().split('\n').find((line) => /SyntaxError/.test(line)) ?? 'Node rejected ESM syntax';
    return { shared: `it fails Node ESM syntax validation (${detail})` };
  }
  const ids = [...new Set([...old.provisioners.keys(), ...now.provisioners.keys()])];
  return { changed: ids.filter((id) => old.provisioners.get(id) !== now.provisioners.get(id)) };
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
function editsApp(app, changedPaths, edited, carried, editedApps = new Set()) {
  if (!changedPaths.length || carried.has(app.id) || editedApps.has(app.id)) return true;
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
// that ci.yml's per-app jobs run selects every app, and one only its site
// jobs run (siteJobNames) selects no app but the site build. `manifests` maps
// a changed package.json, offline asset lock, pnpm-lock.yaml or
// registry/apps.yml to its text before and after: root script edits count only
// where ci.yml runs them, an asset lock change selects the apps whose assets
// changed, a pnpm lockfile change the apps whose resolved dependencies changed,
// and a registry change the apps whose entries changed. Without both texts the
// last two select everything. Markdown in a package or exes/ directory reaches
// only the apps that read that exact file.
// `reasons.fallback` says why the whole catalog was selected; otherwise
// `reasons.apps` maps each selected app, and `reasons.site` the site build, to
// the changes that selected it. `siteCode` is false when every site reason is
// data the per-app site checks do not read (landing page files, registry
// entries, the offline lock), so they can cover only the selected apps.
// With `release`, a version bump selects what it reaches: release.yml picks
// the apps to publish from the version changes themselves. `carried` maps app
// ids a failed run on main left untested to the jobs that failed there.
export function selectAffectedApps(registry, changedPaths = [], graph = null, manifests = new Map(), { release = false, carried = new Map() } = {}) {
  const everything = (fallback) => ({ apps: registry.apps, site: true, siteCode: true, reasons: { fallback, apps: {}, site: [] } });
  if (!changedPaths.length) return everything('no changed paths: no base revision, an unreadable diff, or a full run');

  const appIds = new Set(registry.apps.map((app) => app.id));
  const reach = graph && new Map(registry.apps.map((app) => [app.id, reachableFrom(graph, `apps/${app.id}`)]));
  const catalog = graph && reachableFrom(graph, CATALOG);
  const site = graph && reachableFrom(graph, SITE);
  const appReasons = new Map();
  const editedApps = new Set();
  const siteReasons = [];
  const bookkeeping = [];
  let fallback = null;
  const select = (appId, reason) => appReasons.set(appId, [...(appReasons.get(appId) ?? []), reason]);
  const shared = (reason) => {
    fallback ??= reason;
  };
  // A change to code the site jobs run (the checks, the composite build) needs
  // those checks over every app; siteData is for data only the landing page,
  // the catalogue or the named apps read.
  let siteCode = false;
  const siteBuild = (reason) => {
    siteCode = true;
    siteReasons.push(reason);
  };
  const siteData = (reason) => siteReasons.push(reason);
  const reachableWithout = (node, excludedPattern) => {
    const seen = new Set([node]);
    const pending = [node];
    while (pending.length) {
      for (const next of graph.edges.get(pending.pop()) ?? []) {
        if (excludedPattern.test(next) || seen.has(next)) continue;
        seen.add(next);
        pending.push(next);
      }
    }
    return seen;
  };

  // Selects whatever reaches `node` or a file below it.
  const selectReaching = (node, reason) => {
    const within = (candidate) => candidate === node || candidate.startsWith(`${node}/`);
    if (ROOT_FILE.test(`${node}/`) && [...catalog].some(within)) shared(`${reason}; ci.yml's per-app jobs run ${node}`);
    if ([...site].some(within)) siteBuild(reason);
    for (const candidate of registry.apps) {
      if ([...reach.get(candidate.id)].some(within)) select(candidate.id, reason);
    }
  };
  const selectLintTooling = (node, reason) => {
    const within = (candidate) => candidate === node || candidate.startsWith(`${node}/`);
    if ([...catalog].some(within)) shared(`${reason}; ci.yml's per-app jobs run ${node}`);
    if ([...site].some(within)) siteBuild(reason);
    if (!LINT_RUNNER.test(node)) {
      for (const candidate of registry.apps) {
        if ([...reachableWithout(`apps/${candidate.id}`, LINT_RUNNER)].some(within)) select(candidate.id, reason);
      }
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
      for (const reader of graph?.appReaders?.(path) ?? []) {
        if (appIds.has(reader)) select(reader, `${path}: ${reader}'s code reads it`);
      }
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
    if (LINT_TOOLING_PATHS.some((pattern) => pattern.test(path))) {
      if (!graph) shared(`${path}: there is no workspace graph to confirm lint tooling is unreached`);
      else selectLintTooling(path, path);
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
        else if (INDEPENDENT_CHECK_PATHS.some((pattern) => pattern.test(`${importer}/`))) continue;
        else if (!graph) shared(`${path}: ${reason}, and there is no workspace graph to find its users`);
        else if (LINT_TOOLING_PATHS.some((pattern) => pattern.test(`${importer}/`))) selectLintTooling(importer, `${path}: ${reason}`);
        else selectReaching(importer, `${path}: ${reason}`);
      }
      continue;
    }
    if (path === WORKSPACE_CONFIG) {
      const entry = manifests.get(path);
      const impact = entry
        ? workspaceConfigImpact({ ...entry, lockAfter: manifests.get(LOCKFILE)?.after })
        : { shared: 'the base or head workspace configuration is unavailable' };
      if (impact.shared) shared(`${path}: ${impact.shared}`);
      continue;
    }
    if (path === E2E_TEST_DATA && manifests.get(path)) {
      const impact = e2eTestDataImpact(manifests.get(path));
      if (impact.shared) {
        shared(`${path}: ${impact.shared}`);
        continue;
      }
      if (graph && site.has(path)) siteBuild(path);
      for (const id of impact.changed) {
        if (appIds.has(id)) {
          select(id, `${path}: the ${id} provisioner changed`);
          editedApps.add(id);
        }
      }
      continue;
    }
    if (SITE_ONLY_FILES.has(path)) {
      siteData(`${path}: only the composite build copies it`);
      continue;
    }
    if (SITE_THEME_FILES.has(path)) {
      siteBuild(`${path}: the composite site checks the themed build across every app`);
      for (const id of SITE_THEME_CONSUMERS) {
        if (appIds.has(id)) select(id, `${path}: ${id} loads ${path} directly`);
      }
      continue;
    }
    if (path.startsWith('site/fonts/')) {
      siteBuild(`${path}: the composite site checks the themed build across every app`);
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
      siteData(`${path}: the composite site serves the catalog${impact.suite ? ' and its desktop suite' : ''}`);
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
      siteData(`${path}: the composite site themes every app with it`);
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
      siteData(`${path}: the landing page lists the catalog`);
      for (const id of impact.changed) {
        if (appIds.has(id)) select(id, `${path}: the ${id} entry changed`);
      }
      if (impact.registered) {
        if (!graph) {
          shared(`${path}: the registered apps changed, and without a workspace graph the builds that generate tools from every app are unknown`);
          continue;
        }
        for (const reader of AUTOMATION_CATALOG_READERS) selectReaching(reader, `${path}: the registered apps changed, and ${reader} generates tools from every one`);
      }
      if (impact.menu) {
        if (!graph?.appsNaming) {
          shared(`${path}: an entry changed what the handoff menus list, and without a workspace graph the apps that render one are unknown`);
          continue;
        }
        for (const id of HANDOFF_CATALOG_READERS.flatMap((reader) => graph.appsNaming(reader))) {
          if (appIds.has(id)) select(id, `${path}: an entry changed what ${id}'s handoff menu lists`);
        }
      }
      for (const segments of impact.siteKeys) {
        const { name: key, readers } = siteEntry(segments);
        // The composite build writes some keys into every app page it assembles,
        // which the per-app site checks then read: those are code for them.
        if (SITE_DATA_KEYS.includes(key)) {
          if (!readers.length) siteData(`${path}: ${key} changed, and only the site build reads it`);
        } else {
          siteBuild(`${path}: ${key} changed, and the composite build writes it into every app page`);
        }
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
        // Every root script a ci.yml job runs is an input: one only the site jobs run
        // selects the site build, any other every app; a script no job runs, nothing.
        for (const name of scripts) {
          const jobs = [...graph.jobScripts].filter(([, run]) => run.has(name)).map(([id]) => id);
          if (!jobs.length) continue;
          if (jobs.every((id) => CI_JOB_SCOPES[id] === 'site')) siteBuild(`${path}: the site CI jobs run root script ${name}`);
          else shared(`${path}: ci.yml's ${jobs.join(', ')} ${jobs.length === 1 ? 'job runs' : 'jobs run'} root script ${name}`);
        }
        continue;
      }
    }
    if (manifest && path === OFFLINE_LOCK) {
      for (const app of lockOwners(manifest)) if (appIds.has(app)) select(app, `${path}: its locked assets changed`);
      siteData(path);
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
    editedApps,
    site: siteReasons.length > 0,
    siteCode,
    reasons: { fallback: null, apps: Object.fromEntries(apps.map((app) => [app.id, appReasons.get(app.id)])), site: siteReasons },
    bookkeeping,
  };
}

export const EASTER_EGG_JOB = 'homepage-easter-egg';
// The file names pnpm reads as a workspace project's manifest (its
// MANIFEST_BASE_NAMES). It globs each workspace pattern for all three and reads
// every match as its own project, so a package.yaml beside a package.json is a
// second project, which can take any package name.
export const WORKSPACE_MANIFESTS = Object.freeze(['package.json', 'package.json5', 'package.yaml']);
// The homepage-easter-egg job runs on every push, nightly and dispatch, as
// before (ci.yml). On a pull request it runs unless every changed path lies in
// a tree it cannot read: apps/, exes/, models/, docs/ and every package outside
// its dependency closure (EASTER_EGG_PACKAGES). Any other path runs it, as do a
// workspace manifest anywhere (its pnpm install reads every one and runs their
// install scripts, and its pnpm --filter runs every project of that name) and a
// path no rule knows.
export const EASTER_EGG_PACKAGES = Object.freeze(['packages/analytics']);
const EASTER_EGG_SKIP_TREE = /^(?:apps|exes|models|docs)\//;
export function easterEggCannotRead(path) {
  if (WORKSPACE_MANIFESTS.includes(path.slice(path.lastIndexOf('/') + 1))) return false;
  if (EASTER_EGG_SKIP_TREE.test(path)) return true;
  const workspacePackage = path.match(/^packages\/[^/]+(?=\/)/)?.[0];
  return Boolean(workspacePackage) && !EASTER_EGG_PACKAGES.includes(workspacePackage);
}
// The files the job reads, from its commands and the code they run, kept as
// the evidence that no skip tree holds one (a path ending in / is a
// directory): `pnpm install` and the Playwright install read root
// configuration, every workspace package.json and the lockfile;
// `node --test test/easter-egg.test.mjs` reads that file, the landing page it
// renders (scripts/lib/landing-page.mjs, scripts/lib/apps-registry.mjs,
// registry/apps.yml) and the easter eggs' manifests under site/; the two
// `pnpm --filter` test scripts and `test:e2e` run the packages under
// site/easter-eggs, whose e2e server renders the landing page and copies
// site/ files and packages/analytics/src/index.js; Playwright loads the
// reporter ci.yml names in PW_TEST_REPORTER. test/app-plan.test.mjs holds the
// table to the job and to the skip trees.
export const EASTER_EGG_INPUTS = Object.freeze(['site/', 'test/easter-egg.test.mjs', 'scripts/lib/landing-page.mjs', 'scripts/lib/apps-registry.mjs', 'registry/apps.yml', 'packages/analytics/src/', 'test-utils/test-durations-reporter.mjs', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']);

// The app-plan job's easter_egg output: a pull request skips the job only on
// `skip`; every other value, an empty one included, runs it (ci.yml).
export const EASTER_EGG_OUTPUT = Object.freeze({ run: 'run', skip: 'skip' });

// Why a pull request runs the homepage-easter-egg job: the changed paths
// outside the trees it cannot read. Empty when every path lies in one.
export function selectEasterEgg(changedPaths) {
  if (!changedPaths.length) return ['no changed paths: no base revision, an unreadable diff, or a full run'];
  const read = changedPaths.filter((path) => !easterEggCannotRead(path));
  const shown = read.slice(0, 5).map((path) => `${path}: outside the trees the job cannot read`);
  return read.length > shown.length ? [...shown, `and ${read.length - shown.length} more`] : shown;
}

// Trees whose edits on a draft pull request cannot affect shared package suites
// (`pnpm test:packages` + `exes/nii2tvx`). App edits stay covered because
// packages/*/test/* checks cross-contract parity against app files (models.json,
// automation.json, fixtures). Ready pull requests, pushes and nightlies always
// run `package-tests`.
const PACKAGE_TEST_DRAFT_SKIP_TREE = /^(?:docs|\.changeset|site\/easter-eggs)\/|^(?:[^/]+\.md)$/;
export function packageTestsCanSkipOnDraft(path) {
  if (WORKSPACE_MANIFESTS.includes(path.slice(path.lastIndexOf('/') + 1))) return false;
  return PACKAGE_TEST_DRAFT_SKIP_TREE.test(path);
}

export function selectPackageTests(changedPaths) {
  if (!changedPaths.length) return ['no changed paths: no base revision, an unreadable diff, or a full run'];
  const read = changedPaths.filter((path) => !packageTestsCanSkipOnDraft(path));
  const shown = read.slice(0, 5).map((path) => `${path}: can affect shared package suites`);
  return read.length > shown.length ? [...shown, `and ${read.length - shown.length} more`] : shown;
}

export function createAppPlan(registry, changedPaths = [], graph = null, manifests = new Map(), { draft = false, release = false, carried = new Map() } = {}) {
  const affected = selectAffectedApps(registry, changedPaths, graph, manifests, { release, carried });
  // Drafts give fast feedback on app edits. Ready PRs always use the complete
  // dependency plan, including shared-code changes, at their current head.
  const selected = draft && changedPaths.length
    ? affected.apps.filter((app) => changedPaths.some((path) => path.startsWith(`apps/${app.id}/`) || path === `models/${app.id}.manifest.json`))
    : affected.apps;
  const { site, reasons } = affected;
  const releasable = selected.filter((app) => app.ci.release);
  const edited = changedPaths.filter((path) => !(affected.bookkeeping ?? []).includes(path));
  const editedApps = affected.editedApps ?? new Set();
  const heavy = (entry) => ({ ...entry, heavy_tests: editsApp(registry.apps.find((app) => app.id === entry.app), changedPaths, edited, carried, editedApps) });
  const browserTested = selected.filter((app) => app.ci.browser_test);
  const gpuTested = selected.filter((app) => app.ci.hardware_gpu);
  // What a pull request's homepage-easter-egg job does; a draft plans it as a ready pull request does.
  const easterEgg = selectEasterEgg(changedPaths);
  const packageTests = selectPackageTests(changedPaths);
  return Object.freeze({
    changedPaths: Object.freeze([...changedPaths]),
    selected: Object.freeze(selected),
    apps: Object.freeze({ include: Object.freeze(selected.map(matrixEntry)) }),
    browserApps: Object.freeze({ include: Object.freeze(browserTested.flatMap(shardedEntries).map(heavy)) }),
    gpuApps: Object.freeze({ include: Object.freeze(gpuTested.map(matrixEntry)) }),
    releaseApps: Object.freeze({ include: Object.freeze(releasable.map(matrixEntry)) }),
    allApps: selected.length === registry.apps.length,
    site: site || selected.length > 0,
    siteCode: affected.siteCode,
    reasons: Object.freeze(reasons),
    bookkeeping: Object.freeze([...(affected.bookkeeping ?? [])]),
    // Why a pull request's homepage-easter-egg job runs; empty when it is skipped.
    easterEgg: Object.freeze([...easterEgg]),
    // Why a draft pull request's package-tests job runs; empty when deferred until ready.
    packageTests: Object.freeze([...packageTests]),
  });
}

// A diff git could not produce. It is never an empty diff: callers that
// cannot read the change test everything (app-plan.mjs), run the workflow
// (workflow-gate.mjs) or report the row as unknown (app-plan-shadow.mjs).
export class UnreadableDiffError extends Error {}

// The paths changed from the merge base of `base` and `head` to `head`, read
// NUL-delimited so that git neither quotes nor splits a name and none is
// trimmed, with both sides of every rename and copy: a moved input changes
// what reads its old path. Without a base it is [], a full run. A diff git
// cannot produce throws UnreadableDiffError.
export function changedPathsFromGit({ base, head = 'HEAD', cwd }) {
  if (!base || /^0+$/.test(base)) return [];
  let output;
  try {
    output = execFileSync('git', ['diff', '-z', '--name-status', '--find-renames', '--find-copies', `${base}...${head}`], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    throw new UnreadableDiffError(`git diff ${base}...${head} failed: ${String(error.stderr || error.message).trim().split('\n')[0]}`);
  }
  const fields = output.split('\0');
  const paths = new Set();
  // Each entry is a status, then one path, or two for a rename (R) or copy (C).
  for (let index = 0; index < fields.length - 1;) {
    const status = fields[index++];
    const names = fields.slice(index, index += /^[RC]/.test(status) ? 2 : 1);
    if (!/^[A-Z]\d*$/.test(status) || names.length < (/^[RC]/.test(status) ? 2 : 1) || names.some((name) => !name)) {
      throw new UnreadableDiffError(`git diff ${base}...${head} printed an entry it cannot be read from (${JSON.stringify(status)})`);
    }
    for (const name of names) paths.add(name);
  }
  return [...paths];
}

const MANIFEST = /^(?:(?:packages|apps|exes)\/[^/]+\/)?package\.json$|^registry\/(?:offline-assets\.lock\.json|apps\.yml|app-information\.yml|standalone\.json)$|^pnpm-(?:lock\.yaml|workspace\.yaml)$|^\.gitattributes$|^\.github\/workflows\/ci\.yml$|^scripts\/lib\/e2e-test-data\.mjs$/;

// The text of each changed manifest (ci.yml included) and the lockfile for
// root manifest edits, at the merge base (changedPathsFromGit diffs from there)
// and at head. A manifest
// missing on either side, or every manifest when there is no merge base, is left
// out and counts as an ordinary code change.
export function changedManifests({ base, head = 'HEAD', cwd, changedPaths }) {
  const manifests = new Map();
  const paths = new Set(changedPaths.filter((path) => MANIFEST.test(path) || EMBEDDED_VERSION_FILES.has(path)));
  if (changedPaths.includes('package.json') || changedPaths.includes(WORKSPACE_CONFIG)) paths.add(LOCKFILE);
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
