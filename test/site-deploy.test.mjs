import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { parse } from 'yaml';
import { loadAppsRegistry, repoRoot } from '../scripts/lib/apps-registry.mjs';
import { workerSites } from '../scripts/lib/catalog-sites.mjs';
import {
  ANALYTICS_REFRESH_UTC,
  DIGEST_FILE,
  analyticsStale,
  decideSite,
  deployOutputs,
  deploySites,
  deploySummary,
  lastAnalyticsRefresh,
  parseLiveRecord,
  planDeploy,
  readLiveRecord,
  siteDigest,
} from '../scripts/lib/site-deploy.mjs';

const registry = await loadAppsRegistry();

async function put(root, path, content) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}

async function tempDir(t) {
  const root = await mkdtemp(join(tmpdir(), 'site-deploy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

const report = (generatedAt, extra = {}) => JSON.stringify({ schemaVersion: 1, generatedAt, unavailable: false, totals: { users: 1 }, ...extra });

async function site(root, files = {}) {
  await put(root, 'index.html', '<!doctype html>');
  await put(root, 'app/index.html', '<!doctype html><title>app</title>');
  await put(root, 'app/assets/model.wasm', Buffer.from([0, 1, 2, 3]));
  await put(root, '.nojekyll', '');
  await put(root, 'analytics.json', report('2026-11-18T01:06:47.596Z'));
  for (const [path, content] of Object.entries(files)) await put(root, path, content);
  return root;
}

test('two builds of the same content have one digest, whatever their file times, usage report and digest record', async (t) => {
  const root = await tempDir(t);
  const first = await site(join(root, 'a'));
  const second = await site(join(root, 'b'), {
    'analytics.json': report('2026-11-18T04:24:04.998Z', { totals: { users: 9 } }),
    [DIGEST_FILE]: '{"schema":1}',
  });
  await utimes(join(second, 'index.html'), new Date(0), new Date(0));
  assert.equal(await siteDigest(first), await siteDigest(second));
  assert.match(await siteDigest(first), /^[0-9a-f]{64}$/);
});

test('any change to a file, a path, the file set or the Worker configuration changes the digest', async (t) => {
  const root = await tempDir(t);
  const base = await siteDigest(await site(join(root, 'base')));
  const variants = {
    bytes: async (dir) => put(dir, 'app/assets/model.wasm', Buffer.from([0, 1, 2, 4])),
    added: async (dir) => put(dir, 'app/new.js', ''),
    removed: async (dir) => rm(join(dir, '.nojekyll')),
    renamed: async (dir) => rename(join(dir, 'app/assets/model.wasm'), join(dir, 'app/assets/model2.wasm')),
    // Only the root usage report and digest record are left out: an app's file of the same name counts.
    nested: async (dir) => put(dir, `app/${DIGEST_FILE}`, '{}'),
    nestedReport: async (dir) => put(dir, 'app/analytics.json', '{}'),
    // A file named for a commit, such as calmar's build-info.json, redeploys its site when it changes.
    buildInfo: async (dir) => put(dir, 'app/build-info.json', '{"sha":"fd88968"}'),
  };
  const seen = new Set([base]);
  for (const [name, change] of Object.entries(variants)) {
    const dir = await site(join(root, name));
    await change(dir);
    const digest = await siteDigest(dir);
    assert.ok(!seen.has(digest), `${name} changes the digest`);
    seen.add(digest);
  }
  const dir = join(root, 'base');
  assert.notEqual(await siteDigest(dir, { config: '{"a":1}' }), await siteDigest(dir, { config: '{"a":2}' }));
  assert.notEqual(await siteDigest(dir, { config: '{"a":1}' }), base);
});

test('a path and the content of another file cannot be swapped without changing the digest', async (t) => {
  const root = await tempDir(t);
  const one = join(root, 'one');
  await put(one, 'a', 'x');
  await put(one, 'b', 'y');
  const two = join(root, 'two');
  await put(two, 'a', 'y');
  await put(two, 'b', 'x');
  assert.notEqual(await siteDigest(one), await siteDigest(two));
});

test('the usage report is refreshed once a day, by the first run after the scheduled refresh time', () => {
  assert.deepEqual(lastAnalyticsRefresh('2026-11-18T04:24:00Z').toISOString(), '2026-11-18T04:17:00.000Z');
  assert.deepEqual(lastAnalyticsRefresh('2026-11-18T04:16:59Z').toISOString(), '2026-11-17T04:17:00.000Z');
  assert.deepEqual(lastAnalyticsRefresh('2026-11-01T00:00:00Z').toISOString(), '2026-10-31T04:17:00.000Z');
  // The scheduled run at 04:22 refreshes a report a push published after the previous day's refresh.
  assert.equal(analyticsStale('2026-11-17T12:30:00Z', '2026-11-18T04:24:00Z'), true);
  // A push later that day finds the report the scheduled run published current.
  assert.equal(analyticsStale('2026-11-18T04:24:00Z', '2026-11-18T12:00:00Z'), false);
  assert.equal(analyticsStale('2026-11-18T01:06:00Z', '2026-11-18T04:10:00Z'), false, 'before the refresh time, the night\'s report is current');
  assert.equal(analyticsStale(null, '2026-11-18T04:24:00Z'), true, 'a live report GA4 could not fill is replaced');
  assert.equal(analyticsStale(undefined, '2026-11-18T04:24:00Z'), true);
  assert.equal(analyticsStale('garbage', '2026-11-18T04:24:00Z'), true);
  assert.equal(analyticsStale('2026-11-01T00:00:00Z', null), false, 'a build without a report never replaces one');
});

test('the refresh time is the deploy workflow\'s daily schedule', async () => {
  const workflow = parse(await readFile(join(repoRoot, '.github/workflows/deploy-pages.yml'), 'utf8'));
  assert.deepEqual(workflow.on.schedule, [{ cron: `${ANALYTICS_REFRESH_UTC.minute} ${ANALYTICS_REFRESH_UTC.hour} * * *` }]);
});

const digest = 'a'.repeat(64);
const record = (fields = {}) => ({ schema: 1, site: 'msk', digest, analyticsGeneratedAt: '2026-11-18T04:24:00Z', commit: 'fd08c1c20', ...fields });

test('a site is published when its content changed, its live record is unreadable, its report is stale, or the run is manual', () => {
  const analytics = '2026-11-18T12:00:00Z';
  const live = { record: record() };
  assert.deepEqual(decideSite({ digest, analytics, live }), {
    publish: false, verifyBuild: false, reason: 'unchanged: the live site has this content and a current usage report',
  });
  assert.deepEqual(decideSite({ digest: 'b'.repeat(64), analytics, live }), { publish: true, verifyBuild: true, reason: 'content changed' });
  assert.deepEqual(decideSite({ digest, analytics, live: { error: 'HTTP 404' } }), {
    publish: true, verifyBuild: true, reason: 'live digest unreadable (HTTP 404)',
  });
  assert.deepEqual(decideSite({ digest, analytics: '2026-11-19T04:30:00Z', live }), {
    publish: true, verifyBuild: false, reason: 'usage report refresh (live report: 2026-11-18T04:24:00Z)',
  });
  assert.deepEqual(decideSite({ digest, analytics, live, deployAll: true }), { publish: true, verifyBuild: true, reason: 'manual run: every site deploys' });
  // Content outranks the report: a changed site is verified before it is published.
  assert.equal(decideSite({ digest: 'b'.repeat(64), analytics: '2026-11-19T04:30:00Z', live }).verifyBuild, true);
});

test('a served record is trusted only when it is this schema\'s record of this site', () => {
  assert.deepEqual(parseLiveRecord(JSON.stringify(record()), 'msk'), { record: record() });
  assert.deepEqual(parseLiveRecord('<!doctype html>', 'msk'), { error: 'not JSON' });
  assert.deepEqual(parseLiveRecord('null', 'msk'), { error: 'schema undefined, expected 1' });
  assert.deepEqual(parseLiveRecord(JSON.stringify(record({ schema: 2 })), 'msk'), { error: 'schema 2, expected 1' });
  assert.deepEqual(parseLiveRecord(JSON.stringify(record()), 'neuro'), { error: 'it describes site "msk"' });
  assert.deepEqual(parseLiveRecord(JSON.stringify(record({ digest: 'abc' })), 'msk'), { error: 'no content digest' });
});

test('reading a live record bypasses caches and turns every failure into a reason to publish', async () => {
  const requests = [];
  const answer = (status, body) => async (url, init) => {
    requests.push({ url, init });
    return new Response(body, { status });
  };
  assert.deepEqual(await readLiveRecord({ site: 'msk', host: 'mskapps.sciget.org', nonce: '7-1', fetch: answer(200, JSON.stringify(record())) }), { record: record() });
  assert.equal(requests[0].url, `https://mskapps.sciget.org/${DIGEST_FILE}?run=7-1`);
  assert.equal(requests[0].init.cache, 'no-store');
  assert.deepEqual(await readLiveRecord({ site: 'msk', host: 'h', nonce: 'n', fetch: answer(404, 'Not found') }), { error: 'HTTP 404' });
  assert.deepEqual(await readLiveRecord({ site: 'msk', host: 'h', nonce: 'n', fetch: async () => { throw new TypeError('fetch failed'); } }), { error: 'fetch failed' });
  const hang = (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  assert.deepEqual(await readLiveRecord({ site: 'msk', host: 'h', nonce: 'n', fetch: hang, timeoutMs: 20 }), { error: 'no answer in 0.02 s' });
});

test('every catalogue and the hub is planned, and the Worker list is the one the registry declares', () => {
  assert.deepEqual(deploySites(registry).map(({ site }) => site), [...registry.site.catalogs.map(({ id }) => id), 'hub']);
  assert.deepEqual(deploySites(registry).filter(({ hosting }) => hosting === 'worker').map(({ site, host }) => ({ host, site })), workerSites(registry));
  assert.equal(deploySites(registry).filter(({ hosting }) => hosting === 'pages').length, 1);
});

async function sitesFixture(root) {
  for (const { site: id, hosting, host } of deploySites(registry)) {
    await site(join(root, id));
    // The hub has no usage report.
    if (id === 'hub') await rm(join(root, id, 'analytics.json'));
    if (hosting === 'worker') await put(root, `${id}.wrangler.json`, JSON.stringify({ name: host }));
  }
}

test('a plan publishes only what differs from the live hosts and writes each site its record', async (t) => {
  const root = await tempDir(t);
  await sitesFixture(root);
  const written = new Map();
  const write = async (path, text) => { written.set(path, text); await writeFile(path, text); };
  // First deploy: nothing is live yet, so every site is published.
  const missing = async () => new Response('Not found', { status: 404 });
  const first = await planDeploy({ registry, sitesDir: root, commit: 'c1', nonce: 'n', fetch: missing, write });
  assert.ok(first.every(({ publish, verifyBuild }) => publish && verifyBuild));
  assert.equal(written.size, deploySites(registry).length);
  const records = Object.fromEntries(first.map(({ site, record }) => [site, record]));
  assert.deepEqual(JSON.parse(await readFile(join(root, 'msk', DIGEST_FILE), 'utf8')), records.msk);
  assert.equal(records.msk.analyticsGeneratedAt, '2026-11-18T01:06:47.596Z');
  assert.equal(records.hub.analyticsGeneratedAt, null);
  assert.equal(records.msk.commit, 'c1');

  // The hosts now serve those records. One app of msk changes, and preclinical's deploy had failed.
  const served = async (url) => {
    const id = deploySites(registry).find(({ host }) => url.startsWith(`https://${host}/`)).site;
    if (id === 'preclinical') return new Response(JSON.stringify({ ...records.preclinical, digest: 'f'.repeat(64) }));
    return new Response(JSON.stringify(records[id]));
  };
  await put(join(root, 'msk'), 'app/assets/model.wasm', 'new model');
  const second = await planDeploy({ registry, sitesDir: root, commit: 'c2', nonce: 'n', fetch: served, write });
  const decision = Object.fromEntries(second.map(({ site, publish, reason }) => [site, publish ? reason : 'skip']));
  assert.deepEqual(decision, {
    neuro: 'skip', msk: 'content changed', microscopy: 'skip', preclinical: 'content changed', hub: 'skip',
  });
  assert.deepEqual(deployOutputs(second), {
    pages: 'false',
    workers: JSON.stringify([
      { site: 'msk', url: 'https://mskapps.sciget.org/' },
      { site: 'preclinical', url: 'https://preclinicalapps.sciget.org/' },
    ]),
    verify_workers: JSON.stringify([
      { site: 'msk', url: 'https://mskapps.sciget.org/' },
      { site: 'preclinical', url: 'https://preclinicalapps.sciget.org/' },
    ]),
    verify_build: 'true',
  });
  // The record a site now carries does not change its digest.
  assert.equal(second.find(({ site: id }) => id === 'neuro').digest, records.neuro.digest);
  assert.equal(await siteDigest(join(root, 'neuro')), records.neuro.digest);

  const summary = deploySummary(second);
  for (const { site: id, host } of deploySites(registry)) assert.match(summary, new RegExp(`\\| ${id} \\| ${host} \\| (publish|skip) \\| `));
  assert.match(summary, /\| neuro \| webapps\.neurodesk\.org \| skip \| unchanged: the live site has this content and a current usage report \|/);
  assert.match(summary, /\| msk \| mskapps\.sciget\.org \| publish \| content changed \|/);
});

test('a deploy whose content is all live publishes nothing and skips the build\'s browser checks', async (t) => {
  const root = await tempDir(t);
  await sitesFixture(root);
  const write = writeFile;
  const first = await planDeploy({ registry, sitesDir: root, commit: 'c1', nonce: 'n', fetch: async () => new Response('', { status: 404 }), write });
  const records = new Map(first.map(({ host, record }) => [host, record]));
  const served = async (url) => new Response(JSON.stringify(records.get(new URL(url).host)));
  const again = await planDeploy({ registry, sitesDir: root, commit: 'c1', nonce: 'n', fetch: served, write });
  assert.deepEqual(deployOutputs(again), { pages: 'false', workers: '[]', verify_workers: '[]', verify_build: 'false' });
  // The next day's scheduled run refreshes every catalogue's usage report, not the hub, and needs no browser check.
  for (const { site: id } of deploySites(registry).filter(({ site: s }) => s !== 'hub')) await put(join(root, id), 'analytics.json', report('2026-11-19T04:24:00Z'));
  const daily = await planDeploy({ registry, sitesDir: root, commit: 'c1', nonce: 'n', fetch: served, write });
  assert.deepEqual(daily.filter(({ publish }) => publish).map(({ site: id }) => id), registry.site.catalogs.map(({ id }) => id));
  assert.equal(deployOutputs(daily).verify_build, 'false');
  assert.equal(deployOutputs(daily).pages, 'true');
  // A manual run publishes and checks everything.
  const manual = await planDeploy({ registry, sitesDir: root, commit: 'c1', nonce: 'n', fetch: served, write, deployAll: true });
  assert.ok(manual.every(({ publish, verifyBuild }) => publish && verifyBuild));
});

const workflow = parse(await readFile(join(repoRoot, '.github/workflows/deploy-pages.yml'), 'utf8'));
// A GitHub expression of `needs`, `steps` and status functions, evaluated as JavaScript.
const expression = (source, context) => runInNewContext(
  source.replace(/^\$\{\{\s*|\s*\}\}$/g, '').replace(/\.(\w+-[\w-]+)/g, '["$1"]').replace(/\bfromJSON\(/g, 'JSON.parse('),
  { cancelled: () => false, success: () => true, ...context },
);

test('the build plans the deploy after its checks of the projected sites and before anything is uploaded', () => {
  const steps = workflow.jobs.build.steps;
  const at = (match) => {
    const index = steps.findIndex(match);
    assert.ok(index >= 0, `missing step ${match}`);
    return index;
  };
  const plan = at((step) => step.id === 'plan');
  assert.match(steps[plan].run, /^node scripts\/plan-site-deploy\.mjs \$\{\{ github\.event_name == 'workflow_dispatch' && '--deploy-all' \|\| '' \}\}$/);
  for (const [name, match] of [
    ['build', (step) => step.run === 'pnpm build'],
    ['usage report', (step) => step.run?.startsWith('node scripts/write-analytics.mjs')],
    ['artifact audit', (step) => step.run === 'pnpm audit:artifacts'],
    ['site check', (step) => step.run === 'node --test test/catalog-sites.test.mjs'],
  ]) assert.ok(at(match) < plan, `${name} runs before the plan`);
  const browser = [at((step) => step.name === 'Install runtime startup test browser'), at((step) => step.run?.includes('pnpm test:runtime-startup'))];
  for (const index of browser) {
    assert.ok(index > plan);
    assert.equal(steps[index].if, "steps.plan.outputs.verify_build == 'true'", `${steps[index].name} runs whenever content may be new`);
  }
  for (const [match, condition] of [
    [(step) => step.uses?.startsWith('actions/configure-pages'), "steps.plan.outputs.pages == 'true'"],
    [(step) => step.uses?.startsWith('actions/upload-pages-artifact'), "steps.plan.outputs.pages == 'true'"],
    [(step) => step.with?.name === 'worker-sites', "steps.plan.outputs.workers != '[]'"],
  ]) {
    const index = at(match);
    assert.ok(index > plan, 'the site records are written before the upload');
    assert.equal(steps[index].if, condition);
  }
  assert.deepEqual(workflow.jobs.build.outputs, Object.fromEntries(['pages', 'workers', 'verify_workers'].map((key) => [key, `\${{ steps.plan.outputs.${key} }}`])));
});

test('each deploy and verify job runs for exactly the sites the plan publishes', () => {
  const outputs = (fields) => ({ build: { result: 'success', outputs: { pages: 'true', workers: '[{"site":"msk"}]', verify_workers: '[{"site":"msk"}]', ...fields } } });
  const deployWorkers = workflow.jobs['deploy-workers'];
  assert.equal(expression(deployWorkers.if, { needs: outputs() }), true);
  assert.equal(expression(deployWorkers.if, { needs: outputs({ workers: '[]' }) }), false);
  const verifyWorkers = workflow.jobs['verify-workers'];
  assert.deepEqual(verifyWorkers.needs, ['build', 'deploy-workers']);
  assert.equal(expression(verifyWorkers.if, { needs: outputs() }), true);
  assert.equal(expression(verifyWorkers.if, { needs: outputs({ verify_workers: '[]' }) }), false, 'the hub alone has no browser check');

  const pages = workflow.jobs.deploy;
  assert.deepEqual(pages.needs, ['build', 'deploy-workers']);
  const runs = (workers, fields = {}, build = 'success') => expression(pages.if, {
    needs: { ...outputs(fields), build: { ...outputs(fields).build, result: build }, 'deploy-workers': { result: workers } },
  });
  assert.equal(runs('success'), true);
  assert.equal(runs('skipped'), true, 'Pages deploys when no Worker site changed');
  assert.equal(runs('failure'), false, 'the neuro 404 page never redirects to a host whose deploy failed');
  assert.equal(runs('cancelled'), false);
  assert.equal(runs('success', { pages: 'false' }), false);
  assert.equal(runs('skipped', {}, 'failure'), false);
});
