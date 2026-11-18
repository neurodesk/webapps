import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadAppsRegistry, repoRoot, SHELLS } from '../scripts/lib/apps-registry.mjs';
import { CANARY_APPS, requireChecked, siteCheckApps, smokeApps } from '../scripts/lib/smoke-apps.mjs';

const registry = await loadAppsRegistry();
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
