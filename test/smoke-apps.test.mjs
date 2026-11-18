import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadAppsRegistry, repoRoot, SHELLS } from '../scripts/lib/apps-registry.mjs';
import { appFileReaders, CANARY_APPS, requireChecked, siteCheckApps, smokeApps } from '../scripts/lib/smoke-apps.mjs';
import { assertParity, coveringSegmentations, parityPeers } from '../test-utils/shared-binary-startup.mjs';

const registry = await loadAppsRegistry();
const manifest = JSON.parse(await readFile(join(repoRoot, 'runtime-assets/manifest.json'), 'utf8'));
const ids = (selection) => selection.apps.map((app) => app.id);
const plan = (selected, outputs = {}) => ({ all_apps: 'false', site_code: 'false', selected_ids: JSON.stringify(selected), ...outputs });

test('without SMOKE_APPS a check covers the whole catalogue', () => {
  for (const value of [undefined, '', '  ']) {
    const selection = smokeApps(registry.apps, value);
    assert.equal(selection.filtered, false);
    assert.equal(selection.apps, registry.apps);
  }
});

test('SMOKE_APPS narrows a check to the apps it names, in registry order', () => {
  const [first, second] = registry.apps;
  const selection = smokeApps(registry.apps, ` ${second.id},${first.id} `);
  assert.equal(selection.filtered, true);
  assert.deepEqual(ids(selection), [first.id, second.id]);
});

test('an unknown or empty SMOKE_APPS entry is an error, not a pass over fewer apps', () => {
  assert.throws(() => smokeApps(registry.apps, 'niimath,not-an-app'), /registry does not have: not-an-app/);
  for (const value of ['niimath,', ',niimath', 'niimath,,zarro']) {
    assert.throws(() => smokeApps(registry.apps, value), /empty entry/, value);
  }
});

test('a check adds the apps it needs for a listed app, and widens to every app when it cannot tell', () => {
  const needs = (id, listed) => (id === 'zarro' && !listed.has('niimath') ? ['niimath'] : []);
  const expanded = smokeApps(registry.apps, 'zarro', needs);
  assert.deepEqual(ids(expanded).sort(), ['niimath', 'zarro']);
  assert.deepEqual(expanded.added, ['niimath']);
  assert.deepEqual(smokeApps(registry.apps, 'zarro,niimath', needs).added, []);
  const widened = smokeApps(registry.apps, 'zarro', () => null);
  assert.equal(widened.filtered, false);
  assert.equal(widened.apps, registry.apps);
  assert.throws(() => smokeApps(registry.apps, 'zarro', () => ['not-an-app']), /needs apps the registry does not have: not-an-app/);
  // Unset, every app runs already.
  assert.equal(smokeApps(registry.apps, '', () => null).apps, registry.apps);
});

test('a check that reads a file of one app runs the apps it checks with it when that app is listed', () => {
  const needs = appFileReaders({ 'apps/calmar/tests/fixtures/synthstrip-mini/T1.nii.gz': ['qsmbly', 'brain-extraction'] });
  assert.deepEqual(ids(smokeApps(registry.apps, 'calmar', needs)).sort(), ['brain-extraction', 'calmar', 'qsmbly']);
  assert.deepEqual(smokeApps(registry.apps, 'zarro', needs).added, []);
  assert.throws(() => appFileReaders({ 'test/fixture.nii': ['qsmbly'] }), /not a file of an app directory/);
});

// The MindGrab CPU segmentations verifySharedBinaries would run for `apps`, built as it builds them.
function segmentationsOf(apps) {
  const jobs = [];
  for (const family of manifest.families.filter((candidate) => candidate.deduplicate)) {
    for (const file of family.files.filter((candidate) => /^brainchop-[a-z0-9]+\.wasm$/.test(candidate.name))) {
      const consumers = file.consumers ?? family.consumers ?? [];
      for (const app of apps.filter((candidate) => consumers.includes(candidate.id))) {
        jobs.push({ family, file, app, consumers, binaryPath: `_runtime/${family.target}/${file.name}` });
      }
    }
  }
  return jobs;
}
const finished = (jobs, output = () => 'same') => jobs.map((job) => ({ job, sha256: output(job), label: `${job.app.id} ${job.file.name}` }));

test('MindGrab parity compares two apps for every shared CPU binary, and fails with one', () => {
  const everyApp = coveringSegmentations(segmentationsOf(registry.apps));
  const shared = segmentationsOf(registry.apps).filter((job) => job.consumers.length >= 2);
  for (const binary of new Set(shared.map((job) => job.file.name))) {
    const apps = new Set(everyApp.filter((job) => job.file.name === binary).map((job) => job.app.id));
    assert.ok(apps.size >= 2, `${binary} runs in ${[...apps].join(', ')}`);
  }
  assert.equal(new Set(everyApp.map((job) => job.app.id)).size, new Set(shared.map((job) => job.app.id)).size, 'every consumer runs once');
  assert.ok(assertParity(finished(everyApp)) > 0);
  // One app alone would compare its output with itself.
  const alone = segmentationsOf(registry.apps.filter((app) => app.id === 'noddi'));
  assert.throws(() => assertParity(finished(coveringSegmentations(alone))), /brainchop-mindgrab\.wasm: MindGrab parity ran in noddi only/);
  assert.throws(() => assertParity(finished(everyApp, (job) => job.app.id)), /the output differs from/);
});

test('an app that shares a MindGrab CPU binary brings one peer into a narrowed run, and only when none is listed', () => {
  const peers = parityPeers(manifest);
  const noddi = smokeApps(registry.apps, 'noddi', peers);
  assert.equal(noddi.added.length, 1);
  assert.doesNotThrow(() => assertParity(finished(coveringSegmentations(segmentationsOf(noddi.apps)))));
  assert.deepEqual(smokeApps(registry.apps, 'noddi,dwicorrect', peers).added, []);
  assert.deepEqual(smokeApps(registry.apps, 'zarro', peers).added, []);
  // brain2print shares three binaries; one peer that ships all three covers them.
  const brain2print = smokeApps(registry.apps, 'brain2print', peers);
  assert.doesNotThrow(() => assertParity(finished(coveringSegmentations(segmentationsOf(brain2print.apps)))));
});

test('a narrowed check that checked nothing fails, and only then', () => {
  const narrowed = smokeApps(registry.apps, 'zarro');
  assert.throws(() => requireChecked(0, narrowed, 'Runtime startup'), /Runtime startup: none of the apps SMOKE_APPS lists \(zarro\)/);
  requireChecked(1, narrowed, 'Runtime startup');
  requireChecked(0, smokeApps(registry.apps, ''), 'Runtime startup');
});

test('every shell has one canary app of that shell', () => {
  assert.deepEqual(Object.keys(CANARY_APPS).sort(), [...SHELLS].sort());
  for (const [shell, id] of Object.entries(CANARY_APPS)) {
    assert.equal(registry.apps.find((app) => app.id === id)?.shell, shell, `${id} is a registered ${shell} app`);
  }
});

test('a canary that is not registered or not of its shell fails the selection instead of being dropped', () => {
  const event = { event: 'pull_request', plan: plan(['zarro']) };
  const without = { ...registry, apps: registry.apps.filter((app) => app.id !== CANARY_APPS.react) };
  assert.throws(() => siteCheckApps(without, event), /the react canary dicompare is not a registered app/);
  const reshelled = { ...registry, apps: registry.apps.map((app) => (app.id === CANARY_APPS['static-html'] ? { ...app, shell: 'imaging-workspace' } : app)) };
  assert.throws(() => siteCheckApps(reshelled, event), /the static-html canary seedseg is a imaging-workspace app/);
  const newShell = { ...registry, apps: registry.apps.map((app) => (app.id === 'zarro' ? { ...app, shell: 'vue' } : app)) };
  assert.throws(() => siteCheckApps(newShell, event), /no canary stands for the vue shell/);
  // The nightly checks every app but still refuses a broken canary list.
  assert.throws(() => siteCheckApps(without, { event: 'schedule', plan: plan([]) }), /not a registered app/);
});

test('nightly, scope all or site, a whole-catalogue plan and site code changes check every app', () => {
  const whole = (event, scope, outputs) => siteCheckApps(registry, { event, scope, plan: plan(['niimath'], outputs) }).value;
  assert.equal(whole('schedule', ''), '');
  assert.equal(whole('workflow_dispatch', 'all'), '');
  assert.equal(whole('workflow_dispatch', 'site'), '');
  assert.equal(whole('pull_request', '', { all_apps: 'true' }), '');
  assert.equal(whole('push', '', { site_code: 'true' }), '');
  // An output the plan did not write is read as the wider answer.
  assert.equal(whole('pull_request', '', { site_code: undefined }), '');
  assert.equal(whole('merge_group', ''), '');
});

test('pull requests, pushes and affected dispatches check the selected apps and one canary per shell', () => {
  const canaries = Object.values(CANARY_APPS);
  const order = (list) => registry.apps.map((app) => app.id).filter((id) => list.includes(id));
  for (const [event, scope] of [['pull_request', ''], ['push', ''], ['workflow_dispatch', 'affected']]) {
    const scoped = siteCheckApps(registry, { event, scope, plan: plan(['zarro', 'niimath']) });
    assert.equal(scoped.value, order(['zarro', 'niimath', ...canaries]).join(','), event);
    assert.match(scoped.reason, /selected apps \(zarro, niimath\) and the canaries/);
  }
  // A push the plan selected no app for (the landing page) still checks the canaries.
  assert.equal(siteCheckApps(registry, { event: 'push', plan: plan([]) }).value, order(canaries).join(','));
  // A selected canary is listed once.
  assert.equal(siteCheckApps(registry, { event: 'push', plan: plan(['syncro']) }).value, order(canaries).join(','));
  assert.throws(() => siteCheckApps(registry, { event: 'push', plan: plan(['not-an-app']) }), /registry does not have/);
});

test('the CI step writes the value as the smoke_apps output', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'site-check-apps-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, 'output');
  const env = { ...process.env, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: '', EVENT: 'pull_request', SCOPE: '', ALL_APPS: 'false', SITE_CODE: 'false', SELECTED_IDS: '["zarro"]' };
  const stdout = execFileSync(process.execPath, ['scripts/site-check-apps.mjs'], { cwd: repoRoot, env, encoding: 'utf8' });
  assert.match(stdout, /SMOKE_APPS=.*zarro/);
  assert.equal(await readFile(output, 'utf8'), `smoke_apps=${siteCheckApps(registry, { event: 'pull_request', plan: plan(['zarro']) }).value}\n`);
  execFileSync(process.execPath, ['scripts/site-check-apps.mjs'], { cwd: repoRoot, env: { ...env, EVENT: 'schedule' } });
  assert.match(await readFile(output, 'utf8'), /\nsmoke_apps=\n$/);
});
