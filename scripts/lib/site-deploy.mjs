import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { HUB_SITE } from './catalog-sites.mjs';

// Which projected sites (dist-sites/<site>) a deploy publishes and checks. Each
// published site carries DIGEST_FILE, a record of its content digest. A run skips
// a site only when the host serves this build's digest and the deploy run before
// it, on any ref, finished green, so a failed deploy or a failed check is retried
// by the next run. A re-run publishes and checks every site
// (.github/workflows/deploy-pages.yml).

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

// Each read of a live record, and the whole read of the run history, ends at its
// deadline, so the plan ends within HISTORY_TIMEOUT_MS plus the time to digest the sites.
export const RECORD_TIMEOUT_MS = 30_000;
export const HISTORY_TIMEOUT_MS = 120_000;
// GitHub re-runs a workflow run only up to 30 days after its first attempt. The
// history lists every run created in the last HISTORY_DAYS days, so no run it
// leaves out can have an attempt that started after since + RERUN_LIMIT_DAYS;
// one day more is the margin. That makes the history certain of a deciding run
// that started in the last two days, and the daily schedule keeps one there.
export const RERUN_LIMIT_DAYS = 30;
export const HISTORY_DAYS = 33;
// 700 to 825 runs in 33 days in November 2026; a page of 100 takes about 2 s.
export const HISTORY_MAX_RUNS = 2000;
const HISTORY_PAGE = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const HEX64 = /^[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
// A calendar instant that reads back as written: 2026-02-31 or 24:00 is refused, not moved to another day.
const isInstant = (value) => typeof value === 'string'
  && ISO_INSTANT.test(value)
  && !Number.isNaN(Date.parse(value))
  && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
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
 * One deadline over a whole exchange: every request, its headers and its body.
 * `within` settles with a promise or rejects when the deadline passes first,
 * and the signal aborts the requests then. The plain timer, unlike
 * AbortSignal.timeout, stays referenced until `end`, so a stalled read still ends.
 */
function deadline(ms, what) {
  const controller = new AbortController();
  let timer;
  const expired = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      const reason = new DOMException(`${what}no complete answer in ${ms / 1000} s`, 'TimeoutError');
      controller.abort(reason);
      reject(reason);
    }, ms);
  });
  expired.catch(() => {});
  return {
    signal: controller.signal,
    within: (promise) => Promise.race([promise, expired]),
    end: () => clearTimeout(timer),
  };
}

/**
 * Read the digest record a host serves; any failure is an `{ error }`, never a
 * throw. Only a direct, uncached JSON answer counts: a redirect can lead to an
 * old copy elsewhere, and a cached copy can predate the last deploy.
 */
export async function readLiveRecord({ site, host, nonce, fetch = globalThis.fetch, timeoutMs = RECORD_TIMEOUT_MS }) {
  // A fresh query string keeps a CDN from answering with a copy cached before the last deploy.
  const url = `https://${host}/${DIGEST_FILE}?run=${encodeURIComponent(nonce)}`;
  const limit = deadline(timeoutMs, '');
  try {
    const init = { cache: 'no-store', redirect: 'manual', headers: { 'cache-control': 'no-cache' }, signal: limit.signal };
    const response = await limit.within(fetch(url, init));
    if (response.status !== 200) return { error: `HTTP ${response.status}` };
    const age = response.headers.get('age');
    if (age !== null && Number(age.trim()) !== 0) return { error: `a cached copy (Age: ${age})` };
    const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') return { error: `content type ${JSON.stringify(type)}` };
    return parseLiveRecord(await limit.within(response.text()), site);
  } catch (error) {
    return { error: message(error) };
  } finally {
    limit.end();
  }
}

/** Why a run record cannot be read, or null. */
function malformedRun(run) {
  if (run === null || typeof run !== 'object') return 'a run record that is not an object';
  if (!Number.isSafeInteger(run.id) || run.id < 1) return `a run with id ${JSON.stringify(run.id)}`;
  if (!Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) return `run ${run.id}: run_attempt ${JSON.stringify(run.run_attempt)}`;
  if (typeof run.status !== 'string') return `run ${run.id}: status ${JSON.stringify(run.status)}`;
  if (run.conclusion !== null && typeof run.conclusion !== 'string') return `run ${run.id}: conclusion ${JSON.stringify(run.conclusion)}`;
  if (!isInstant(run.run_started_at)) return `run ${run.id}: run_started_at ${JSON.stringify(run.run_started_at)}`;
  if ('jobs' in run && !(Number.isSafeInteger(run.jobs) && run.jobs >= 0)) return `run ${run.id}: job count ${JSON.stringify(run.jobs)}`;
  return null;
}

/**
 * Whether the deploy work before this run finished green. `history` is
 * `{ runId, attempt, since, runs }`: this run's id and attempt, and every run of
 * this workflow on every ref created at or after `since` (they share one
 * concurrency group, so any of them can publish), as the API lists them, with
 * `jobs`, the job count of a run's latest attempt, where the reader fetched it.
 *
 * A re-run (attempt above 1) publishes and checks every site. Otherwise the run
 * that decides is the one whose latest attempt started last
 * (`run_started_at`, which a re-run moves), other than this run, among those
 * that started a job; it must have succeeded. A run cancelled while it waited
 * started no job and is passed over. Every doubt about that order publishes
 * every site.
 *
 * Returns `{ green: true, run }`, `{ green: false, reason }`, or `{ need: id }`
 * when it needs that run's job count to go on.
 */
export function previousDeploy({ runId, attempt, since, runs } = {}) {
  const doubt = (reason) => ({ green: false, reason });
  const attemptNumber = Number(attempt);
  if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 1) return doubt(`this run's attempt is unknown (${JSON.stringify(attempt)})`);
  if (attemptNumber > 1) return doubt(`re-run (attempt ${attemptNumber})`);
  if (!Number.isSafeInteger(runId) || !isInstant(since) || !Array.isArray(runs)) return doubt('no run history');
  const malformed = runs.map(malformedRun).find(Boolean);
  if (malformed) return doubt(`malformed run history (${malformed})`);
  const current = runs.find(({ id }) => id === runId);
  if (!current) return doubt(`run ${runId} is not in the run history`);
  if (current.run_attempt !== 1) return doubt(`the run history has run ${runId} at attempt ${current.run_attempt}`);
  const started = (run) => Date.parse(run.run_started_at);
  const start = started(current);
  const others = runs.filter((run) => run !== current);
  // The concurrency group runs one deploy at a time, so an earlier run still going means the order is unknown.
  const unfinished = others.find((run) => run.status !== 'completed' && started(run) <= start);
  if (unfinished) return doubt(`run ${unfinished.id} is ${unfinished.status} and started before this run`);
  const sameStart = new Map();
  for (const run of runs) sameStart.set(started(run), (sameStart.get(started(run)) ?? 0) + 1);
  const completed = others.filter(({ status }) => status === 'completed').sort((a, b) => started(b) - started(a));
  for (const run of completed) {
    if (sameStart.get(started(run)) > 1) return doubt(`run ${run.id} started at the same instant as another run`);
    if (!('jobs' in run)) return { need: run.id };
    if (run.jobs === 0 && run.run_attempt === 1) continue;
    // A later attempt that started no job leaves an earlier attempt's work unaccounted for.
    if (run.jobs === 0) return doubt(`run ${run.id} attempt ${run.run_attempt} started no job after an earlier attempt`);
    if (started(run) >= start) return doubt(`run ${run.id} ran after this run started`);
    if (started(run) < Date.parse(since) + (RERUN_LIMIT_DAYS + 1) * DAY_MS) {
      return doubt(`run ${run.id} started ${run.run_started_at}, before the run history read is certain`);
    }
    if (run.conclusion !== 'success') {
      return doubt(`previous deploy run ${run.id}${run.run_attempt > 1 ? ` attempt ${run.run_attempt}` : ''} ${run.conclusion}`);
    }
    return { green: true, run };
  }
  return doubt('no earlier deploy run that started a job');
}

/**
 * Read the run history previousDeploy decides on; any failure is an
 * `{ error }`, never a throw. A re-run reads nothing. It lists every run of this
 * workflow on every ref created in the last HISTORY_DAYS days, then the job
 * count of each run previousDeploy asks for. One deadline covers every request
 * and body. `workflowRef` is GITHUB_WORKFLOW_REF.
 */
export async function readDeployHistory({ repository, workflowRef, runId, attempt, token, apiUrl, fetch = globalThis.fetch, timeoutMs = HISTORY_TIMEOUT_MS, now = Date.now() }) {
  if (String(attempt) !== '1') return { runId: Number(runId), attempt };
  const limit = deadline(timeoutMs, 'GitHub API: ');
  try {
    const workflow = /\/\.github\/workflows\/([^@/]+)@/.exec(workflowRef ?? '')?.[1];
    if (!repository || !workflow || !Number(runId) || !token) throw new Error('no repository, workflow, run id or token');
    const headers = { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' };
    const get = async (path) => {
      const response = await limit.within(fetch(`${apiUrl ?? 'https://api.github.com'}/repos/${repository}${path}`, { headers, signal: limit.signal }));
      if (response.status !== 200) throw new Error(`GitHub API ${path}: HTTP ${response.status}`);
      return JSON.parse(await limit.within(response.text()));
    };
    const since = new Date(Math.floor((now - HISTORY_DAYS * DAY_MS) / 1000) * 1000).toISOString().replace('.000Z', 'Z');
    const listed = new Map();
    let total;
    for (let page = 1; total === undefined || (page - 1) * HISTORY_PAGE < total; page++) {
      const query = `per_page=${HISTORY_PAGE}&page=${page}&exclude_pull_requests=true&created=${encodeURIComponent(`>=${since}`)}`;
      const answer = await get(`/actions/workflows/${encodeURIComponent(workflow)}/runs?${query}`);
      if (!Number.isSafeInteger(answer?.total_count) || !Array.isArray(answer.workflow_runs)) throw new Error('GitHub API: no workflow runs');
      if (total !== undefined && answer.total_count !== total) throw new Error('the run history changed while it was read');
      total = answer.total_count;
      if (total > HISTORY_MAX_RUNS) throw new Error(`${total} runs since ${since}, more than the ${HISTORY_MAX_RUNS} the plan reads`);
      for (const run of answer.workflow_runs) {
        listed.set(run?.id, { id: run?.id, run_attempt: run?.run_attempt, status: run?.status, conclusion: run?.conclusion, run_started_at: run?.run_started_at });
      }
    }
    if (listed.size !== total) throw new Error(`the run history lists ${listed.size} distinct runs of ${total}`);
    const history = { runId: Number(runId), attempt: 1, since, runs: [...listed.values()] };
    for (let reads = 0; ; reads++) {
      const { need } = previousDeploy(history);
      if (need === undefined) return history;
      if (reads >= history.runs.length) throw new Error('the run history asks for more job counts than it has runs');
      const jobs = (await get(`/actions/runs/${need}/jobs?filter=latest&per_page=1`))?.total_count;
      history.runs = history.runs.map((run) => (run.id === need ? { ...run, jobs } : run));
    }
  } catch (error) {
    return { error: message(error) };
  } finally {
    limit.end();
  }
}

/**
 * Whether one site is published, and why. `verifyBuild` is true when the site's
 * content may differ from what is live, so the build's pre-deploy checks have to run.
 * `forced` says why every site is published: a re-run, or a doubt about the deploy run before this one.
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

/** Why every site is published, or null: a re-run, a deploy run before this one that was not green, or any doubt about it. */
export function forcedReason(history) {
  if (!history || history.error) return `deploy history unreadable (${history?.error ?? 'not read'})`;
  const previous = previousDeploy(history);
  if (previous.need !== undefined) return `deploy history incomplete (no job count for run ${previous.need})`;
  return previous.green ? null : previous.reason;
}

/**
 * Digest every site in `sitesDir`, compare it with the record its host serves,
 * and write this build's record into each site. Returns one entry per site.
 * `history` is readDeployHistory's answer or a promise of it, read while the
 * sites are digested. `verifyAll` (the daily run) checks every live site,
 * published or not. A site whose plan throws is published.
 */
export async function planDeploy({ registry, sitesDir, commit, deployAll = false, verifyAll = false, history, nonce, fetch, write, timeoutMs }) {
  const forced = Promise.resolve(history).then(forcedReason).catch((error) => `deploy history unreadable (${message(error)})`);
  return Promise.all(deploySites(registry).map(async ({ site, host, hosting }) => {
    const entry = { site, host, hosting, url: `https://${host}/` };
    try {
      const siteDir = join(sitesDir, site);
      const config = hosting === 'worker' ? await readFile(join(sitesDir, `${site}.wrangler.json`)) : undefined;
      const [digest, analytics, live] = await Promise.all([
        siteDigest(siteDir, { config }),
        analyticsGeneratedAt(siteDir),
        readLiveRecord({ site, host, nonce, fetch, timeoutMs }),
      ]);
      const record = { schema: DIGEST_SCHEMA, site, digest, analyticsGeneratedAt: analytics, commit };
      const decision = decideSite({ digest, analytics, live, deployAll, forced: await forced });
      await write(join(siteDir, DIGEST_FILE), `${JSON.stringify(record, null, 2)}\n`);
      return { ...entry, digest, live, record, ...decision, verify: decision.publish || verifyAll };
    } catch (error) {
      return { ...entry, publish: true, verifyBuild: true, verify: true, reason: `plan failed (${message(error)})` };
    }
  }));
}

/**
 * The plan deploy-pages.yml runs, from the Actions environment. The run history
 * and every site's live record are read at once, each under its own deadline,
 * so it returns its outputs within HISTORY_TIMEOUT_MS plus the time to digest
 * the sites, whatever the network does. Returns the plan, its step outputs and
 * the job summary.
 */
export async function planSiteDeploy({ registry, sitesDir, env, deployAll = false, verifyAll = false, fetch = globalThis.fetch, write, timeouts = {}, now = Date.now() }) {
  const history = readDeployHistory({
    repository: env.GITHUB_REPOSITORY,
    workflowRef: env.GITHUB_WORKFLOW_REF,
    runId: env.GITHUB_RUN_ID,
    attempt: env.GITHUB_RUN_ATTEMPT,
    token: env.GITHUB_TOKEN,
    apiUrl: env.GITHUB_API_URL,
    fetch,
    timeoutMs: timeouts.history,
    now,
  });
  const planned = await planDeploy({
    registry,
    sitesDir,
    commit: env.GITHUB_SHA ?? null,
    deployAll,
    verifyAll,
    history,
    nonce: `${env.GITHUB_RUN_ID ?? 'local'}-${env.GITHUB_RUN_ATTEMPT ?? now}`,
    fetch,
    write,
    timeoutMs: timeouts.record,
  });
  const forced = forcedReason(await history);
  const summary = `${forced ? `Every site is published: ${forced}.\n\n` : ''}${deploySummary(planned)}`;
  return { planned, outputs: deployOutputs(planned), summary };
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
