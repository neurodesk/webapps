import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { HUB_SITE } from './catalog-sites.mjs';

// Which projected sites (dist-sites/<site>) a deploy publishes. Each published
// site carries DIGEST_FILE, a record of its content digest; a run publishes a
// site when the digest of its build differs from the one the host serves, so a
// failed or partial deploy is retried by the next run (.github/workflows/deploy-pages.yml).

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
  return !report.unavailable && typeof report.generatedAt === 'string' ? report.generatedAt : null;
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
  if (!live || Number.isNaN(Date.parse(live))) return true;
  return new Date(live) < lastAnalyticsRefresh(built);
}

/** Parse a served DIGEST_FILE: `{ record }`, or `{ error }` saying why it cannot be trusted. */
export function parseLiveRecord(text, site) {
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    return { error: 'not JSON' };
  }
  if (record?.schema !== DIGEST_SCHEMA) return { error: `schema ${JSON.stringify(record?.schema)}, expected ${DIGEST_SCHEMA}` };
  if (record.site !== site) return { error: `it describes site ${JSON.stringify(record.site)}` };
  if (!HEX64.test(record.digest ?? '')) return { error: 'no content digest' };
  return { record };
}

/** Read the digest record a host serves; any failure is an `{ error }`, never a throw. */
export async function readLiveRecord({ site, host, nonce, fetch = globalThis.fetch, timeoutMs = 30_000 }) {
  // A fresh query string keeps a CDN from answering with a copy cached before the last deploy.
  const url = `https://${host}/${DIGEST_FILE}?run=${encodeURIComponent(nonce)}`;
  try {
    const response = await fetch(url, { cache: 'no-store', headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { error: `HTTP ${response.status}` };
    return parseLiveRecord(await response.text(), site);
  } catch (error) {
    return { error: error.name === 'TimeoutError' ? `no answer in ${timeoutMs / 1000} s` : error.message };
  }
}

/**
 * Whether one site is published, and why. `verifyBuild` is true when the site's
 * content may differ from what is live, so the build's pre-deploy checks have to run.
 */
export function decideSite({ digest, analytics, live, deployAll }) {
  if (deployAll) return { publish: true, verifyBuild: true, reason: 'dispatched run: every site deploys' };
  if (live.error) return { publish: true, verifyBuild: true, reason: `live digest unreadable (${live.error})` };
  if (live.record.digest !== digest) return { publish: true, verifyBuild: true, reason: 'content changed' };
  if (analyticsStale(live.record.analyticsGeneratedAt, analytics)) {
    const since = live.record.analyticsGeneratedAt ?? 'never';
    return { publish: true, verifyBuild: false, reason: `usage report refresh (live report: ${since})` };
  }
  return { publish: false, verifyBuild: false, reason: 'unchanged: the live site has this content and a current usage report' };
}

/**
 * Digest every site in `sitesDir`, compare it with the record its host serves,
 * and write this build's record into each site. Returns one entry per site.
 */
export async function planDeploy({ registry, sitesDir, commit, deployAll = false, nonce, fetch, write }) {
  const sites = deploySites(registry);
  const planned = await Promise.all(sites.map(async ({ site, host, hosting }) => {
    const siteDir = join(sitesDir, site);
    const config = hosting === 'worker' ? await readFile(join(sitesDir, `${site}.wrangler.json`)) : undefined;
    const [digest, analytics, live] = await Promise.all([
      siteDigest(siteDir, { config }),
      analyticsGeneratedAt(siteDir),
      readLiveRecord({ site, host, nonce, fetch }),
    ]);
    const record = { schema: DIGEST_SCHEMA, site, digest, analyticsGeneratedAt: analytics, commit };
    return { site, host, hosting, url: `https://${host}/`, digest, live, record, ...decideSite({ digest, analytics, live, deployAll }) };
  }));
  for (const { site, record } of planned) await write(join(sitesDir, site, DIGEST_FILE), `${JSON.stringify(record, null, 2)}\n`);
  return planned;
}

/** The step outputs deploy-pages.yml reads. */
export function deployOutputs(planned) {
  const workers = planned.filter(({ hosting, publish }) => hosting === 'worker' && publish).map(({ site, url }) => ({ site, url }));
  return {
    pages: String(planned.some(({ hosting, publish }) => hosting === 'pages' && publish)),
    workers: JSON.stringify(workers),
    verify_workers: JSON.stringify(workers.filter(({ site }) => site !== HUB_SITE)),
    verify_build: String(planned.some(({ verifyBuild }) => verifyBuild)),
  };
}

const short = (digest) => (digest ? `\`${digest.slice(0, 12)}\`` : '-');

/** The job summary: one row per site saying whether it is published and why. */
export function deploySummary(planned) {
  const rows = planned.map(({ site, host, publish, reason, digest, live }) => {
    const liveDigest = live.record ? short(live.record.digest) : '-';
    const liveCommit = live.record?.commit ? `\`${String(live.record.commit).slice(0, 9)}\`` : '-';
    return `| ${site} | ${host} | ${publish ? 'publish' : 'skip'} | ${reason} | ${short(digest)} | ${liveDigest} | ${liveCommit} |`;
  });
  return [
    '### Sites',
    '',
    '| Site | Host | Decision | Why | Build digest | Live digest | Live commit |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
}
