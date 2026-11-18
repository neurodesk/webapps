import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { basename, dirname, join, posix, relative, sep } from 'node:path';
import { catalogApps, findCatalog } from './apps-registry.mjs';
import { HUB_SITE } from './catalog-sites.mjs';
import { moduleClosure } from './module-closure.mjs';
import { DIGEST_FILE, DIGEST_SCHEMA, exchange, isInstant, message, readLiveRecord } from './site-record.mjs';

// Which projected sites (dist-sites/<site>) a deploy publishes and checks. Each
// published site carries a record of its content digest (site-record.mjs). The
// job that checks a site against its public host saves a verified marker, a
// GitHub Actions cache entry whose key names the site, the digest the host
// served before and after the checks, and a hash of the check inputs. A run
// skips a site only when the host serves this build's digest and that marker
// exists (.github/workflows/deploy-pages.yml).

// The usage report's counts move by the hour (scripts/write-analytics.mjs), so
// the digest leaves it out and analyticsStale decides when it is published.
const ANALYTICS_FILE = 'analytics.json';
// Root files the content digest leaves out. Every other file counts, including
// calmar's build-info.json, which names the commit of its last uncached build.
const UNDIGESTED = new Set([DIGEST_FILE, ANALYTICS_FILE]);
// The daily refresh of the usage reports: the deploy workflow's cron, '17 4 * * *'.
export const ANALYTICS_REFRESH_UTC = { hour: 4, minute: 17 };

// The workflow that publishes and checks the sites; its check steps and hub check are check inputs.
export const DEPLOY_WORKFLOW = '.github/workflows/deploy-pages.yml';
// The landing page probe, which every check job and the Worker deploy run.
export const SITE_PROBE = 'scripts/check-site-answers.mjs';
// The scripts the deployed checks of a catalogue site run, and the files they
// read from the checkout to decide pass or fail besides the modules they import.
// The hub's checks are the probe and a step of the workflow.
// test/site-deploy.test.mjs holds both lists to the workflow's check steps.
export const DEPLOYED_CHECKS = [SITE_PROBE, 'test/deployed-site.smoke.mjs', 'test/standalone-downloads.smoke.mjs', 'test/image-upload.smoke.mjs'];
export const HUB_CHECKS = [SITE_PROBE];
export const CHECK_DATA = ['package.json', 'registry/apps.yml', 'registry/standalone.json', DEPLOY_WORKFLOW];
// A new marker schema leaves every older marker unread.
export const MARKER_PREFIX = 'deploy-verified-1-';
// Each marker lookup ends at this deadline.
const MARKER_TIMEOUT_MS = 30_000;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Every site a deploy publishes: the catalogues, then the hub. */
export function deploySites(registry) {
  return [
    ...registry.site.catalogs.map(({ id, host, hosting }) => ({ site: id, host, hosting })),
    { site: HUB_SITE, host: registry.site.hub.host, hosting: 'worker' },
  ];
}

async function siteFiles(root, prefix = '') {
  const files = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? posix.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) files.push(...await siteFiles(root, path));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`${join(root, path)}: a site holds only files and directories`);
  }
  return files;
}

/**
 * The content digest of one projected site: SHA-256 over each file's relative
 * path and the SHA-256 of its bytes, in path order, with the root files in
 * UNDIGESTED left out. `config` is the site's Wrangler configuration, which
 * changes what the host serves without changing a file.
 */
export async function siteDigest(siteDir, { config } = {}) {
  const lines = [`neurodesk-site-digest/${DIGEST_SCHEMA}`];
  const paths = (await siteFiles(siteDir)).filter((path) => !UNDIGESTED.has(path)).sort();
  for (const path of paths) lines.push(`${path}\0${sha256(await readFile(join(siteDir, path)))}`);
  if (config !== undefined) lines.push(`<wrangler config>\0${sha256(config)}`);
  return sha256(`${lines.join('\n')}\n`);
}

/** When the site's usage report was generated, or null when it has none or GA4 was unavailable. */
async function analyticsGeneratedAt(siteDir) {
  let report;
  try {
    report = JSON.parse(await readFile(join(siteDir, ANALYTICS_FILE), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  return !report?.unavailable && isInstant(report?.generatedAt) ? report.generatedAt : null;
}

/** The most recent daily refresh time at or before `time`. */
export function lastAnalyticsRefresh(time) {
  const at = new Date(time);
  const refresh = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), ANALYTICS_REFRESH_UTC.hour, ANALYTICS_REFRESH_UTC.minute));
  if (refresh > at) refresh.setUTCDate(refresh.getUTCDate() - 1);
  return refresh;
}

/**
 * A live usage report is stale when this build has a report and the live one
 * predates the last daily refresh before this build's report was generated, so
 * each catalogue's report is refreshed once a day, by the first run after 04:17 UTC.
 */
export function analyticsStale(live, built) {
  if (!built) return false;
  if (!isInstant(live)) return true;
  return new Date(live) < lastAnalyticsRefresh(built);
}

const IMPORT = /(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g;

// The real path of the manifest Node finds for package `name` from directory
// `from`, looking in node_modules of `from` and its ancestors within `realRoot`.
function installedManifest(realRoot, from, name) {
  for (let dir = from; `${dir}${sep}`.startsWith(`${realRoot}${sep}`); dir = dirname(dir)) {
    const manifest = join(dir, 'node_modules', name, 'package.json');
    if (basename(dir) !== 'node_modules' && existsSync(manifest)) return realpathSync(manifest);
  }
  return null;
}

/**
 * The npm packages `files` import by name and every package they depend on,
 * each as installed for its importer: `name@version`, with the pnpm store
 * directory, which also names a patch. An override or a patch of a dependency,
 * such as the playwright-core that @playwright/test runs, changes the list.
 * Workspace packages are left out: their files are in the module closure.
 */
function installedPackages(root, files) {
  const realRoot = realpathSync(root);
  const pending = [];
  for (const file of files.filter((path) => /\.[cm]?[jt]s$/.test(path) && existsSync(join(root, path)))) {
    for (const match of readFileSync(join(root, file), 'utf8').matchAll(IMPORT)) {
      const specifier = match[1] ?? match[2] ?? match[3];
      if (/^(\.|\/|node:)/.test(specifier)) continue;
      pending.push({ name: specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/'), from: dirname(realpathSync(join(root, file))) });
    }
  }
  const packages = new Set();
  const seen = new Set();
  while (pending.length) {
    const { name, from, optional } = pending.pop();
    const manifest = installedManifest(realRoot, from, name);
    if (!manifest) {
      if (!optional) packages.add(`${name}@unresolved`);
      continue;
    }
    const path = relative(realRoot, manifest).split(sep).join('/');
    if ((!path.startsWith('..') && !path.includes('node_modules/')) || seen.has(manifest)) continue;
    seen.add(manifest);
    const { version, dependencies = {}, optionalDependencies = {} } = JSON.parse(readFileSync(manifest, 'utf8'));
    const store = path.match(/node_modules\/\.pnpm\/([^/]+)\//)?.[1];
    packages.add(`${name}@${version}${store ? ` (${store})` : ''}`);
    for (const dependency of Object.keys(dependencies)) pending.push({ name: dependency, from: dirname(manifest) });
    for (const dependency of Object.keys(optionalDependencies)) pending.push({ name: dependency, from: dirname(manifest), optional: true });
  }
  return [...packages].sort();
}

/**
 * The inputs of each site's deployed checks, by site: the check scripts with
 * every module they import and the installed npm packages among them
 * (installedPackages), the files they read to decide pass or fail (CHECK_DATA,
 * and the package.json of each app of the site), and the workflow that runs
 * them. The hub's checks are the probe and a step of the workflow.
 */
export function checkInputs(root, registry) {
  const scripts = moduleClosure(root, DEPLOYED_CHECKS, { missing: true });
  const files = [...new Set([...scripts, ...CHECK_DATA])];
  const packages = installedPackages(root, scripts);
  const hub = moduleClosure(root, HUB_CHECKS, { missing: true });
  const inputs = { [HUB_SITE]: { files: [...new Set([...hub, DEPLOY_WORKFLOW])].sort(), packages: installedPackages(root, hub) } };
  for (const catalog of registry.site.catalogs) {
    const apps = catalogApps(registry, findCatalog(registry, catalog.id)).map(({ id }) => `apps/${id}/package.json`);
    inputs[catalog.id] = { files: [...new Set([...files, ...apps])].sort(), packages };
  }
  return inputs;
}

/** A hash of each site's check inputs (checkInputs), by site: a changed check gives a hash no marker has. */
export function checkHashes(root, registry) {
  return Object.fromEntries(Object.entries(checkInputs(root, registry)).map(([site, { files, packages }]) => {
    const lines = ['neurodesk-deploy-checks/1'];
    for (const path of files) lines.push(`file\0${path}\0${existsSync(join(root, path)) ? sha256(readFileSync(join(root, path))) : 'missing'}`);
    for (const pkg of packages) lines.push(`npm\0${pkg}`);
    return [site, sha256(`${lines.join('\n')}\n`)];
  }));
}

/** The cache key of the marker that says site `site` at digest `digest` passed the checks whose inputs hash to `checks`. */
export const markerKey = (site, digest, checks) => `${MARKER_PREFIX}${site}-${digest}-${checks}`;

/**
 * Whether the verified marker `key` exists in the Actions cache of `ref`:
 * `{ present }`, or `{ error }`, never a throw. The REST API matches `key` as a
 * prefix, so an entry counts only when its key and its ref are both equal. An
 * answer with more than one page of matches is unknown, even with a match on it.
 */
export async function readMarker({ key, repository, ref, token, apiUrl = 'https://api.github.com', fetch = globalThis.fetch, timeoutMs = MARKER_TIMEOUT_MS }) {
  try {
    if (!key || !repository || !ref || !token) throw new Error('no key, repository, ref or token');
    return await exchange(timeoutMs, 'GitHub API: ', async ({ signal, within }) => {
      const query = new URLSearchParams({ key, ref, per_page: '100' });
      const headers = { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' };
      const response = await within(fetch(`${apiUrl}/repos/${repository}/actions/caches?${query}`, { headers, signal }));
      if (response.status !== 200) throw new Error(`GitHub API: HTTP ${response.status}`);
      const answer = JSON.parse(await within(response.text()));
      if (!Number.isSafeInteger(answer?.total_count) || !Array.isArray(answer.actions_caches)) throw new Error('GitHub API: no cache list');
      if (answer.total_count > answer.actions_caches.length) throw new Error(`GitHub API: ${answer.total_count} caches match, more than one page`);
      return { present: answer.actions_caches.some((entry) => entry?.key === key && entry?.ref === ref) };
    });
  } catch (error) {
    return { error: message(error) };
  }
}

/**
 * Whether one site is published and checked, and why. `live` is the record its
 * host serves (`{ record }` or `{ error }`), `marker` the lookup of its verified
 * marker (`{ present }` or `{ error }`). A site is skipped only when the host
 * serves this digest, its marker exists, its usage report is current and the
 * run was not dispatched. `verifyBuild` is true when the site's content may
 * differ from what is live, so the build's pre-deploy checks have to run;
 * `verify` when its deployed checks run: after a publish, and on the daily
 * run (`verifyAll`) for every site.
 */
export function decideSite({ digest, analytics, live, marker, deployAll = false, verifyAll = false }) {
  const decide = (publish, verifyBuild, reason) => ({ publish, verifyBuild, verify: publish || verifyAll, reason });
  if (deployAll) return decide(true, true, 'dispatched run: every site deploys');
  if (live.error) return decide(true, true, `live digest unreadable (${live.error})`);
  if (live.record.digest !== digest) return decide(true, true, 'content changed');
  // The live bytes are this build's, and they passed the build's checks when they were first published.
  if (marker.error) return decide(true, false, `marker unknown (${marker.error})`);
  if (!marker.present) return decide(true, false, 'no verified marker for this content and these checks');
  if (analyticsStale(live.record.analyticsGeneratedAt, analytics)) {
    return decide(true, false, `usage report refresh (live report: ${live.record.analyticsGeneratedAt ?? 'never'})`);
  }
  return decide(false, false, 'verified: the host serves this content, checked by these checks, with a current usage report');
}

/**
 * Digest every site in `sitesDir`, compare it with the record its host serves,
 * look up its verified marker, and write this build's record into each site.
 * Returns one entry per site. `checks` maps each site to its check hash
 * (checkHashes); `lookup(key)` reads a marker (readMarker). A site whose plan
 * throws is published and checked.
 */
export async function planDeploy({ registry, sitesDir, commit, deployAll = false, verifyAll = false, checks = {}, lookup, nonce, fetch, write, timeoutMs }) {
  return Promise.all(deploySites(registry).map(async ({ site, host, hosting }) => {
    const entry = { site, host, hosting, url: `https://${host}/` };
    try {
      const siteDir = join(sitesDir, site);
      const config = hosting === 'worker' ? await readFile(join(sitesDir, `${site}.wrangler.json`)) : undefined;
      const liveRead = readLiveRecord({ site, host, nonce, fetch, timeoutMs });
      const [digest, analytics] = await Promise.all([siteDigest(siteDir, { config }), analyticsGeneratedAt(siteDir)]);
      const key = checks[site] ? markerKey(site, digest, checks[site]) : null;
      const [live, marker] = await Promise.all([liveRead, key ? lookup(key) : { error: 'no check hash' }]);
      const record = { schema: DIGEST_SCHEMA, site, digest, analyticsGeneratedAt: analytics, commit };
      const decision = decideSite({ digest, analytics, live, marker, deployAll, verifyAll });
      await write(join(siteDir, DIGEST_FILE), `${JSON.stringify(record, null, 2)}\n`);
      return { ...entry, digest, live, record, key, marker, ...decision };
    } catch (error) {
      return { ...entry, publish: true, verifyBuild: true, verify: true, reason: `plan failed (${message(error)})` };
    }
  }));
}

/**
 * The plan deploy-pages.yml runs, from the Actions environment: the check
 * hashes from the checkout at `root`, the markers from the Actions cache of
 * GITHUB_REF, read with GITHUB_TOKEN. Every site's live record and marker are
 * read at once, each under its own deadline, so it returns its outputs within
 * about MARKER_TIMEOUT_MS plus the time to digest the sites, whatever the
 * network does. Returns the plan, its step outputs and the job summary.
 */
export async function planSiteDeploy({ registry, sitesDir, root, env, deployAll = false, verifyAll = false, fetch = globalThis.fetch, write, timeouts = {} }) {
  let checks = {};
  let checksError = null;
  try {
    checks = checkHashes(root, registry);
  } catch (error) {
    checksError = message(error);
  }
  const lookup = (key) => readMarker({ key, repository: env.GITHUB_REPOSITORY, ref: env.GITHUB_REF, token: env.GITHUB_TOKEN, apiUrl: env.GITHUB_API_URL, fetch, timeoutMs: timeouts.marker });
  const planned = await planDeploy({
    registry,
    sitesDir,
    commit: env.GITHUB_SHA ?? null,
    deployAll,
    verifyAll,
    checks,
    lookup,
    nonce: randomUUID(),
    fetch,
    write,
    timeoutMs: timeouts.record,
  });
  const summary = `${checksError ? `The check inputs could not be hashed (${checksError}), so no marker is read.\n\n` : ''}${deploySummary(planned)}`;
  return { planned, outputs: deployOutputs(planned), summary };
}

/**
 * The step outputs deploy-pages.yml reads. `verify` lists the catalogue sites the
 * verify-sites job checks; the Pages deploy job checks the site it publishes
 * itself, and verify-hub the hub. `markers` gives each checked site's URL,
 * build digest and marker key, for the job that checks it to save the marker.
 */
export function deployOutputs(planned) {
  const workers = planned.filter(({ hosting, publish }) => hosting === 'worker' && publish).map(({ site, url }) => ({ site, url }));
  const checked = planned.filter(({ site, hosting, publish, verify }) => verify && site !== HUB_SITE && !(hosting === 'pages' && publish));
  const markers = Object.fromEntries(planned.filter(({ verify, key }) => verify && key).map(({ site, url, digest, key }) => [site, { url, digest, key }]));
  return {
    pages: String(planned.some(({ hosting, publish }) => hosting === 'pages' && publish)),
    workers: JSON.stringify(workers),
    verify: JSON.stringify(checked.map(({ site, url }) => ({ site, url }))),
    verify_hub: String(planned.some(({ site, verify }) => site === HUB_SITE && verify)),
    verify_build: String(planned.some(({ verifyBuild }) => verifyBuild)),
    markers: JSON.stringify(markers),
  };
}

const short = (digest) => (typeof digest === 'string' ? `\`${digest.slice(0, 12)}\`` : '-');
const markerCell = (marker) => (!marker ? '-' : marker.error ? `unknown (${marker.error})` : marker.present ? 'found' : 'none');

/** The job summary: one row per site saying whether it is published and checked, why, and whether its marker was found. */
export function deploySummary(planned) {
  const rows = planned.map(({ site, host, publish, verify, reason, marker, digest, live }) => {
    const liveDigest = live?.record ? short(live.record.digest) : '-';
    const liveCommit = live?.record?.commit ? `\`${live.record.commit.slice(0, 9)}\`` : '-';
    const checks = publish ? 'after publish' : verify ? 'live site' : '-';
    return `| ${site} | ${host} | ${publish ? 'publish' : 'skip'} | ${checks} | ${reason} | ${markerCell(marker)} | ${short(digest)} | ${liveDigest} | ${liveCommit} |`;
  });
  return [
    '### Sites',
    '',
    '| Site | Host | Decision | Deployed checks | Why | Verified marker | Build digest | Live digest | Live commit |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
}
