import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { HUB_SITE } from './catalog-sites.mjs';

// Which projected sites (dist-sites/<site>) a deploy publishes and checks. Each
// published site carries DIGEST_FILE, a record of its content digest. A run skips
// a site only when the host serves this build's digest and the previous deploy
// run on main that did any work finished green, so a failed deploy or a failed
// check is retried by the next run (.github/workflows/deploy-pages.yml).

export const DIGEST_FILE = 'site-digest.json';
export const DIGEST_SCHEMA = 1;
// The usage report's counts move by the hour (scripts/write-analytics.mjs), so
// the digest leaves it out and analyticsStale decides when it is published.
export const ANALYTICS_FILE = 'analytics.json';
// Root files the content digest leaves out. Every other file counts, including
// calmar's build-info.json, which names the commit of its last uncached build.
export const UNDIGESTED = new Set([DIGEST_FILE, ANALYTICS_FILE]);
// The daily refresh of the usage reports: the deploy workflow's cron, '17 4 * * *'.
export const ANALYTICS_REFRESH_UTC = { hour: 4, minute: 17 };

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const HEX64 = /^[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const isInstant = (value) => typeof value === 'string' && ISO_INSTANT.test(value) && !Number.isNaN(Date.parse(value));
const message = (error) => String(error?.message ?? error);

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
export async function analyticsGeneratedAt(siteDir) {
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

/**
 * Parse a served DIGEST_FILE: `{ record }`, or `{ error }` saying why it cannot
 * be trusted. Every field the plan reads is checked here, so a record of the
 * wrong shape is unreadable instead of a throw later in the plan.
 */
export function parseLiveRecord(text, site) {
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    return { error: 'not JSON' };
  }
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return { error: 'not a JSON object' };
  if (record.schema !== DIGEST_SCHEMA) return { error: `schema ${JSON.stringify(record.schema)}, expected ${DIGEST_SCHEMA}` };
  if (record.site !== site) return { error: `it describes site ${JSON.stringify(record.site)}` };
  if (typeof record.digest !== 'string' || !HEX64.test(record.digest)) return { error: 'no content digest' };
  if (record.analyticsGeneratedAt !== null && !isInstant(record.analyticsGeneratedAt)) return { error: 'analyticsGeneratedAt is neither null nor an ISO instant' };
  if (record.commit !== null && !(typeof record.commit === 'string' && HEX40.test(record.commit))) return { error: 'commit is neither null nor a commit hash' };
  return { record };
}

/**
 * fetch with a deadline. A plain timer, unlike AbortSignal.timeout, keeps the
 * event loop alive while it waits on a fetch that never answers.
 */
async function fetchWithin(fetch, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException(`no answer in ${timeoutMs / 1000} s`, 'TimeoutError')), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read the digest record a host serves; any failure is an `{ error }`, never a
 * throw. Only a direct, uncached JSON answer counts: a redirect can lead to an
 * old copy elsewhere, and a cached copy can predate the last deploy.
 */
export async function readLiveRecord({ site, host, nonce, fetch = globalThis.fetch, timeoutMs = 30_000 }) {
  // A fresh query string keeps a CDN from answering with a copy cached before the last deploy.
  const url = `https://${host}/${DIGEST_FILE}?run=${encodeURIComponent(nonce)}`;
  try {
    const init = { cache: 'no-store', redirect: 'manual', headers: { 'cache-control': 'no-cache' } };
    const response = await fetchWithin(fetch, url, init, timeoutMs);
    if (response.status !== 200) return { error: `HTTP ${response.status}` };
    const age = response.headers.get('age');
    if (age !== null && Number(age.trim()) !== 0) return { error: `a cached copy (Age: ${age})` };
    const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') return { error: `content type ${JSON.stringify(type)}` };
    return parseLiveRecord(await response.text(), site);
  } catch (error) {
    return { error: message(error) };
  }
}

/**
 * Whether the previous deploy run on main that did any work finished green.
 * `runs` are this workflow's earlier runs on main, `{ id, status, conclusion, jobs }`,
 * where `jobs` counts the jobs of a cancelled run. A run cancelled while it waited
 * has no job: it did nothing and is passed over. Returns `{ green: true, run }`
 * or `{ green: false, reason }`.
 */
export function previousDeploy(runs) {
  for (const run of [...runs].sort((a, b) => b.id - a.id)) {
    if (run.status === 'completed' && run.conclusion === 'cancelled' && run.jobs === 0) continue;
    if (run.status === 'completed' && run.conclusion === 'success') return { green: true, run };
    return { green: false, reason: `previous deploy run ${run.id} ${run.status === 'completed' ? run.conclusion : run.status}` };
  }
  return { green: false, reason: 'no earlier deploy run on main' };
}

/**
 * Read this workflow's earlier runs on main for previousDeploy; any failure is
 * an `{ error }`, never a throw. `workflowRef` is GITHUB_WORKFLOW_REF.
 */
export async function readDeployHistory({ repository, workflowRef, runId, token, fetch = globalThis.fetch, timeoutMs = 30_000 }) {
  try {
    const workflow = /\/\.github\/workflows\/([^@/]+)@/.exec(workflowRef ?? '')?.[1];
    if (!repository || !workflow || !Number(runId) || !token) throw new Error('no repository, workflow, run id or token');
    const get = async (path) => {
      const headers = { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' };
      const response = await fetchWithin(fetch, `https://api.github.com/repos/${repository}${path}`, { headers }, timeoutMs);
      if (response.status !== 200) throw new Error(`GitHub API ${path}: HTTP ${response.status}`);
      return response.json();
    };
    const listed = (await get(`/actions/workflows/${encodeURIComponent(workflow)}/runs?branch=main&per_page=20`)).workflow_runs;
    if (!Array.isArray(listed)) throw new Error('GitHub API: no workflow_runs');
    const runs = [];
    for (const { id, status, conclusion } of listed.filter((run) => run.id < Number(runId))) {
      const jobs = conclusion === 'cancelled' ? (await get(`/actions/runs/${id}/jobs?filter=all&per_page=1`)).total_count : undefined;
      runs.push({ id, status, conclusion, jobs });
    }
    return { runs };
  } catch (error) {
    return { error: message(error) };
  }
}

/**
 * Whether one site is published, and why. `verifyBuild` is true when the site's
 * content may differ from what is live, so the build's pre-deploy checks have to run.
 * `forced` says why every site is published: the previous deploy run was not green.
 */
export function decideSite({ digest, analytics, live, deployAll, forced }) {
  if (deployAll) return { publish: true, verifyBuild: true, reason: 'dispatched run: every site deploys' };
  if (forced) return { publish: true, verifyBuild: true, reason: `forced: ${forced}` };
  if (live.error) return { publish: true, verifyBuild: true, reason: `live digest unreadable (${live.error})` };
  if (live.record.digest !== digest) return { publish: true, verifyBuild: true, reason: 'content changed' };
  if (analyticsStale(live.record.analyticsGeneratedAt, analytics)) {
    const since = live.record.analyticsGeneratedAt ?? 'never';
    return { publish: true, verifyBuild: false, reason: `usage report refresh (live report: ${since})` };
  }
  return { publish: false, verifyBuild: false, reason: 'unchanged: the live site has this content and a current usage report' };
}

/** Why every site is published, or null: the previous deploy run was not green or its history is unreadable. */
export function forcedReason(history) {
  if (!history?.runs) return `deploy history unreadable (${history?.error ?? 'not read'})`;
  const previous = previousDeploy(history.runs);
  return previous.green ? null : previous.reason;
}

/**
 * Digest every site in `sitesDir`, compare it with the record its host serves,
 * and write this build's record into each site. Returns one entry per site.
 * `history` is readDeployHistory's answer. `verifyAll` (the daily run) checks
 * every live site, published or not. A site whose plan throws is published.
 */
export async function planDeploy({ registry, sitesDir, commit, deployAll = false, verifyAll = false, history, nonce, fetch, write }) {
  const forced = forcedReason(history);
  return Promise.all(deploySites(registry).map(async ({ site, host, hosting }) => {
    const entry = { site, host, hosting, url: `https://${host}/` };
    try {
      const siteDir = join(sitesDir, site);
      const config = hosting === 'worker' ? await readFile(join(sitesDir, `${site}.wrangler.json`)) : undefined;
      const [digest, analytics, live] = await Promise.all([
        siteDigest(siteDir, { config }),
        analyticsGeneratedAt(siteDir),
        readLiveRecord({ site, host, nonce, fetch }),
      ]);
      const record = { schema: DIGEST_SCHEMA, site, digest, analyticsGeneratedAt: analytics, commit };
      const decision = decideSite({ digest, analytics, live, deployAll, forced });
      await write(join(siteDir, DIGEST_FILE), `${JSON.stringify(record, null, 2)}\n`);
      return { ...entry, digest, live, record, ...decision, verify: decision.publish || verifyAll };
    } catch (error) {
      return { ...entry, publish: true, verifyBuild: true, verify: true, reason: `plan failed (${message(error)})` };
    }
  }));
}

/**
 * The step outputs deploy-pages.yml reads. `verify` lists the catalogue sites the
 * verify-sites job checks; the Pages deploy job checks the site it publishes itself.
 */
export function deployOutputs(planned) {
  const workers = planned.filter(({ hosting, publish }) => hosting === 'worker' && publish).map(({ site, url }) => ({ site, url }));
  const checked = planned.filter(({ site, hosting, publish, verify }) => verify && site !== HUB_SITE && !(hosting === 'pages' && publish));
  return {
    pages: String(planned.some(({ hosting, publish }) => hosting === 'pages' && publish)),
    workers: JSON.stringify(workers),
    verify: JSON.stringify(checked.map(({ site, url }) => ({ site, url }))),
    verify_hub: String(planned.some(({ site, verify }) => site === HUB_SITE && verify)),
    verify_build: String(planned.some(({ verifyBuild }) => verifyBuild)),
  };
}

const short = (digest) => (typeof digest === 'string' ? `\`${digest.slice(0, 12)}\`` : '-');

/** The job summary: one row per site saying whether it is published and checked, and why. */
export function deploySummary(planned) {
  const rows = planned.map(({ site, host, publish, verify, reason, digest, live }) => {
    const liveDigest = live?.record ? short(live.record.digest) : '-';
    const liveCommit = live?.record?.commit ? `\`${live.record.commit.slice(0, 9)}\`` : '-';
    const checks = publish ? 'after publish' : verify ? 'live site' : '-';
    return `| ${site} | ${host} | ${publish ? 'publish' : 'skip'} | ${checks} | ${reason} | ${short(digest)} | ${liveDigest} | ${liveCommit} |`;
  });
  return [
    '### Sites',
    '',
    '| Site | Host | Decision | Deployed checks | Why | Build digest | Live digest | Live commit |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
}
