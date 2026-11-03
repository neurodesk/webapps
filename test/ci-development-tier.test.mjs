import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import YAML from 'yaml';
import { createAppPlan } from '../scripts/lib/app-plan.mjs';
import { loadAppsRegistry } from '../scripts/lib/apps-registry.mjs';

const workflow = async (name) => YAML.parse(await readFile(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8'));
const evaluate = (expression, github, inputs = {}) => runInNewContext(expression.replace(/^\$\{\{\s*|\s*\}\}$/g, ''), { github, inputs });

test('draft feedback selects direct app edits; ready PRs retain shared coverage', async () => {
  const registry = await loadAppsRegistry();
  const changed = ['apps/niimath/main.js', 'pnpm-workspace.yaml'];
  const draft = createAppPlan(registry, changed, null, new Map(), { draft: true });
  assert.deepEqual(draft.selected.map(({ id }) => id), ['niimath']);
  assert.deepEqual(draft.browserApps.include.map(({ app }) => app), ['niimath']);
  assert.equal(createAppPlan(registry, changed).selected.length, registry.apps.length);
  assert.equal(createAppPlan(registry, ['pnpm-workspace.yaml'], null, new Map(), { draft: true }).selected.length, 0);
  assert.equal(createAppPlan(registry, [], null, new Map(), { draft: true }).selected.length, registry.apps.length, 'unknown diff fails open to complete coverage');
});

test('ready and updated PRs run deferred native jobs; push and dispatch retain their gates', async () => {
  let guarded = 0;
  for (const file of await readdir(new URL('../.github/workflows', import.meta.url))) {
    if (!file.endsWith('.yml')) continue;
    const flow = await workflow(file);
    if (file !== 'ci.yml' && flow.on?.pull_request?.types?.includes('ready_for_review')) {
      for (const [id, job] of Object.entries(flow.jobs)) {
        if (job.needs) continue;
        assert.equal(evaluate(job.if ?? 'true', {
          event_name: 'pull_request', event: { pull_request: { draft: true } },
        }), false, `${file}: entry job ${id} must defer drafts or be restricted to non-PR events`);
      }
    }
    for (const job of Object.values(flow.jobs)) {
      if (!String(job.if).includes('!github.event.pull_request.draft')) continue;
      if (file === 'ci.yml') continue;
      guarded++;
      for (const action of ['opened', 'synchronize', 'reopened', 'ready_for_review', 'converted_to_draft']) assert.ok(flow.on.pull_request.types.includes(action), `${file} ${action}`);
      for (const draft of [true, false]) {
        assert.equal(evaluate(job.if, { event_name: 'pull_request', event: { pull_request: { draft } } }), !draft, file);
      }
      for (const event_name of ['push', 'schedule', 'workflow_dispatch']) assert.equal(evaluate(job.if, { event_name, event: {} }), true, file);
    }
  }
  assert.ok(guarded > 30);
});

test('main CI can finish while PR pushes cancel their predecessors', async () => {
  const flow = await workflow('ci.yml');
  for (const event_name of ['push', 'schedule', 'workflow_dispatch', 'pull_request']) {
    assert.equal(evaluate(flow.concurrency['cancel-in-progress'], { event_name }), event_name === 'pull_request');
  }
  assert.ok(flow.on.pull_request.types.includes('ready_for_review'));
  const plan = flow.jobs['app-plan'].steps.find(({ id }) => id === 'plan');
  assert.equal(evaluate(plan.env.CI_DRAFT, { event_name: 'push', event: {} }), false);
  assert.equal(evaluate(plan.env.CI_DRAFT, { event_name: 'pull_request', event: { pull_request: { draft: true } } }), true);
});

test('NeuroFlow push coverage matches PR paths and retains the scheduled backstop', async () => {
  const flow = await workflow('neuroflow.yml');
  assert.deepEqual(flow.on.push.paths, flow.on.pull_request.paths);
  assert.ok(flow.on.schedule.length);
});

test('native driver filters are generated from their imported files', () => {
  execFileSync(process.execPath, ['scripts/sync-native-driver-paths.mjs', '--check']);
});


test('DWI2TRX preserves manual tracking-only selection', async () => {
  const flow = await workflow('dwi2trx-native.yml');
  const github = { event_name: 'workflow_dispatch', event: {} };
  for (const tracking_only of [true, false]) {
    for (const id of ['web-app-reference', 'portable']) {
      assert.equal(evaluate(flow.jobs[id].if, github, { tracking_only }), !tracking_only);
    }
    assert.equal(evaluate(flow.jobs.tracking.if, github, { tracking_only }), tracking_only);
  }
});
