import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { HUB_SITE } from './catalog-sites.mjs';
import { DIGEST_FILE, DIGEST_SCHEMA, isInstant, message, readLiveRecord } from './site-record.mjs';

// Which projected sites (dist-sites/<site>) a deploy publishes. Each published
// site carries a record of its content digest (site-record.mjs). A run skips
// the publish of a site whose host already serves this build's digest; every
// check of every site still runs (.github/workflows/deploy-pages.yml).

// The usage report's counts move by the hour (scripts/write-analytics.mjs), so
// the digest leaves it out and analyticsStale decides when it is published.
const ANALYTICS_FILE = 'analytics.json';
// Root files the content digest leaves out. Every other file counts, including
// calmar's build-info.json, which names the commit of its last uncached build.
const UNDIGESTED = new Set([DIGEST_FILE, ANALYTICS_FILE]);
// The daily refresh of the usage reports: the deploy workflow's cron, '17 4 * * *'.
export const ANALYTICS_REFRESH_UTC = { hour: 4, minute: 17 };

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

/**
 * Whether one site is published, and why. `live` is the record its host serves
 * (`{ record }` or `{ error }`). A site is skipped only when the run was not
 * dispatched, its host serves this digest and its usage report is current.
 */
export function decideSite({ digest, analytics, live, deployAll = false }) {
  if (deployAll) return { publish: true, reason: 'dispatched run: every site is published' };
  if (live.error) return { publish: true, reason: `live digest unreadable (${live.error})` };
  if (live.record.digest !== digest) return { publish: true, reason: 'content changed' };
  if (analyticsStale(live.record.analyticsGeneratedAt, analytics)) {
    return { publish: true, reason: `usage report refresh (live report: ${live.record.analyticsGeneratedAt ?? 'never'})` };
  }
  return { publish: false, reason: 'the host serves this content and a current usage report' };
}

/**
 * Digest every site in `sitesDir`, compare it with the record its host serves,
 * and write this build's record into each site. Returns one entry per site. A
 * site whose plan throws is published; the other sites are still planned.
 */
export async function planDeploy({ registry, sitesDir, commit, deployAll = false, nonce, fetch, write, timeoutMs }) {
  return Promise.all(deploySites(registry).map(async ({ site, host, hosting }) => {
    const entry = { site, host, hosting, url: `https://${host}/` };
    try {
      const siteDir = join(sitesDir, site);
      const config = hosting === 'worker' ? await readFile(join(sitesDir, `${site}.wrangler.json`)) : undefined;
      const liveRead = readLiveRecord({ site, host, nonce, fetch, timeoutMs });
      const [digest, analytics] = await Promise.all([siteDigest(siteDir, { config }), analyticsGeneratedAt(siteDir)]);
      const live = await liveRead;
      const record = { schema: DIGEST_SCHEMA, site, digest, analyticsGeneratedAt: analytics, commit };
      await write(join(siteDir, DIGEST_FILE), `${JSON.stringify(record, null, 2)}\n`);
      return { ...entry, digest, live, record, ...decideSite({ digest, analytics, live, deployAll }) };
    } catch (error) {
      return { ...entry, publish: true, reason: `plan failed (${message(error)})` };
    }
  }));
}

/**
 * The step outputs deploy-pages.yml reads: `publish`, a JSON object of
 * whether each site is published; `any`, whether any site is, which runs the
 * build's runtime startup check; and `pages_url`, the Pages site's own URL,
 * which its checks use when its publish is skipped.
 */
export function deployOutputs(planned) {
  return {
    publish: JSON.stringify(Object.fromEntries(planned.map(({ site, publish }) => [site, publish]))),
    any: String(planned.some(({ publish }) => publish)),
    pages_url: planned.find(({ hosting }) => hosting === 'pages').url,
  };
}

const short = (digest) => (typeof digest === 'string' ? `\`${digest.slice(0, 12)}\`` : '-');

/** The job summary: one row per site saying whether it is published and why. */
export function deploySummary(planned) {
  const rows = planned.map(({ site, host, publish, reason, digest, live }) => {
    const liveCommit = live?.record?.commit ? `\`${live.record.commit.slice(0, 9)}\`` : '-';
    return `| ${site} | ${host} | ${publish ? 'published' : 'skipped'} | ${reason} | ${short(digest)} | ${short(live?.record?.digest)} | ${liveCommit} |`;
  });
  return [
    '### Sites',
    '',
    'Every site is checked against its public host, published or not.',
    '',
    '| Site | Host | Publish | Why | Build digest | Live digest | Live commit |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
}
