import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import YAML from 'yaml';
import { createAppPlan } from '../scripts/lib/app-plan.mjs';
import { loadAppsRegistry } from '../scripts/lib/apps-registry.mjs';
import { isSharedFilter, pathGlob } from '../scripts/lib/workflow-gate.mjs';

const workflow = async (name) => YAML.parse(await readFile(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8'));
// What pr-gate.yml answers without a checkout: false for a draft, true for
// every event other than pull_request. A ready pull request is decided by
// scripts/lib/workflow-gate.mjs; `reached` stands for its answer.
const gate = (github, reached = true) => ({ gate: { outputs: { run: String(github.event_name !== 'pull_request' || (!github.event?.pull_request?.draft && reached)) } } });
const evaluate = (expression, github, inputs = {}, needs = gate(github)) => runInNewContext(expression.replace(/^\$\{\{\s*|\s*\}\}$/g, ''), { github, inputs, needs });

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
  let gated = 0;
  for (const file of await readdir(new URL('../.github/workflows', import.meta.url))) {
    if (!file.endsWith('.yml')) continue;
    const flow = await workflow(file);
    const usesGate = Object.hasOwn(flow.jobs, 'gate');
    if (usesGate) {
      gated++;
      // The gate always finishes, so jobs after the entry jobs keep their default conditions.
      assert.deepEqual(flow.jobs.gate, { uses: './.github/workflows/pr-gate.yml', permissions: { contents: 'read', actions: 'read' }, with: { workflow: file.slice(0, -'.yml'.length) } }, file);
    }
    if (file !== 'ci.yml' && flow.on?.pull_request?.types?.includes('ready_for_review')) {
      for (const [id, job] of Object.entries(flow.jobs)) {
        if (id === 'gate' || (job.needs && job.needs !== 'gate')) continue;
        assert.equal(evaluate(job.if ?? 'true', {
          event_name: 'pull_request', event: { pull_request: { draft: true } },
        }), false, `${file}: entry job ${id} must defer drafts or be restricted to non-PR events`);
      }
    }
    for (const [id, job] of Object.entries(flow.jobs)) {
      const deferred = String(job.if).includes('!github.event.pull_request.draft');
      const waits = String(job.if).includes('needs.gate.outputs.run');
      if (!deferred && !waits) continue;
      if (file === 'ci.yml') continue;
      guarded++;
      if (waits) {
        assert.equal(job.needs, 'gate', `${file}: ${id} reads the gate it waits for`);
        assert.doesNotMatch(job.if, /always\(|cancelled\(|failure\(/, `${file}: ${id} respects a failed gate`);
        const ready = { event_name: 'pull_request', event: { pull_request: { draft: false } } };
        assert.equal(evaluate(job.if, ready, {}, gate(ready, false)), false, `${file}: ${id} skips a pull request that does not reach it`);
      }
      for (const action of ['opened', 'synchronize', 'reopened', 'ready_for_review', 'converted_to_draft']) assert.ok(flow.on.pull_request.types.includes(action), `${file} ${action}`);
      for (const draft of [true, false]) {
        assert.equal(evaluate(job.if, { event_name: 'pull_request', event: { pull_request: { draft } } }), !draft, file);
      }
      for (const event_name of ['push', 'schedule', 'workflow_dispatch']) assert.equal(evaluate(job.if, { event_name, event: {} }), true, file);
    }
  }
  assert.ok(guarded > 30);
  assert.ok(gated > 20);
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

test('returning to draft cancels the prior run without starting CI jobs', async () => {
  const flow = await workflow('ci.yml');
  assert.ok(flow.on.pull_request.types.includes('converted_to_draft'));
  const skipped = new Set();
  for (const [id, job] of Object.entries(flow.jobs)) {
    const needs = [job.needs ?? []].flat();
    if (needs.length) {
      assert.ok(needs.every(dependency => skipped.has(dependency)), `${id} depends on skipped jobs`);
      assert.doesNotMatch(job.if ?? '', /always\(|!cancelled\(/, `${id} must respect skipped dependencies`);
    } else {
      assert.equal(evaluate(job.if, { event: { action: 'converted_to_draft' } }), false, id);
      for (const action of ['opened', 'synchronize', 'reopened', 'ready_for_review', undefined]) {
        assert.equal(evaluate(job.if, { event: { action } }), true, `${id}: ${action}`);
      }
    }
    skipped.add(id);
  }
});

test('NeuroFlow and the SDC registration gate start for a pull request only on their own paths', async () => {
  // Both take hours of runner time. A shared change reaches them nightly, and the SDC gate on main.
  for (const file of ['neuroflow.yml', 'sdc-registration-gate.yml']) {
    const flow = await workflow(file);
    const own = flow.on.pull_request.paths;
    assert.deepEqual(own.filter(isSharedFilter), [], `${file} filters pull requests on shared paths`);
    assert.equal(flow.jobs.gate, undefined, file);
    const push = flow.on.push.paths;
    const covers = push.map(pathGlob);
    // A nested file each pull request filter matches, which a push filter has to match too.
    const sample = (filter) => filter.replace('**', 'nested/file.js').replace('*', 'name');
    for (const filter of own) assert.ok(pathGlob(filter).test(sample(filter)), `${file}: ${sample(filter)} is a file ${filter} matches`);
    assert.deepEqual(own.filter((filter) => !covers.some((glob) => glob.test(sample(filter)))), [], `${file}: a push to main covers every pull request path`);
    // NeuroFlow runs for hours and nearly every merge touches a tree it builds on, so its nightly
    // run alone covers those; the SDC gate lists the few files it imports from other packages.
    if (file === 'neuroflow.yml') assert.deepEqual(push, own, `${file} starts for a merge only on its own paths`);
    else assert.ok(push.some(isSharedFilter), `${file} keeps its shared filters on main`);
    assert.deepEqual(flow.on.push.branches, ['main']);
    assert.ok(flow.on.schedule.length, `${file} keeps its nightly run`);
  }
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

test('the interface audit reads the example cache the job restored, filled and saves from main', async () => {
  const { steps } = (await workflow('ci.yml')).jobs['composite-site'];
  const position = (description, matches) => {
    const found = steps.flatMap((step, index) => matches(step) ? [index] : []);
    assert.equal(found.length, 1, `composite-site has one step that ${description}`);
    return found[0];
  };
  const restoreAt = position('restores the examples', step => String(step.uses).startsWith('actions/cache/restore@') && step.with.key.startsWith('example-assets-'));
  const fillAt = position('fills the example cache', step => step.run?.includes('scripts/fetch-example-cache.mjs'));
  const saveAt = position('saves the examples', step => String(step.uses).startsWith('actions/cache/save@') && step.with.key.includes('example-cache'));
  const auditAt = position('audits the interfaces', step => step.run === 'pnpm audit:interfaces');
  const [restore, fill, save, audit] = [restoreAt, fillAt, saveAt, auditAt].map(index => steps[index]);
  assert.ok(restoreAt < fillAt && fillAt < saveAt && fillAt < auditAt, 'restore, then fill, then save and audit');
  const directory = restore.with.path;
  assert.match(directory, /^\$\{\{ runner\.temp \}\}\/[\w-]+$/);
  assert.equal(fill.env.EXAMPLE_ASSET_CACHE, directory, 'the fill writes the restored directory');
  assert.match(fill.run, /fetch-example-cache\.mjs "\$EXAMPLE_ASSET_CACHE" --prune$/);
  assert.equal(audit.env.EXAMPLE_ASSET_CACHE, directory, 'the audit reads the filled directory instead of the network');
  assert.equal(save.with.path, directory, 'the save stores the filled directory');
  assert.equal(save.with.key, `\${{ steps.${restore.id}.outputs.cache-primary-key }}`, 'the save uses the key the restore looked up');
  assert.ok(restore.with['restore-keys'] && restore.with.key.startsWith(restore.with['restore-keys']), 'an older copy is restored and topped up');
  const saves = ref => runInNewContext(save.if.replace(/\.(\w+-[\w-]+)/g, '["$1"]'), { github: { ref }, steps: { [restore.id]: { outputs: { 'cache-hit': 'false' } } } });
  assert.equal(saves('refs/heads/main'), true);
  assert.equal(saves('refs/pull/809/merge'), false, 'a pull request stores no second copy');
  const diskAt = steps.flatMap((step, index) => /^df\b/.test(step.run ?? '') ? [index] : []);
  assert.ok(diskAt.some(index => index < restoreAt), 'free disk space is logged before the restore');
  assert.ok(diskAt.some(index => index > fillAt && index < auditAt), 'free disk space is logged after the fill');
});

test('superseded per-commit caches are deleted by a job that holds nothing else', async () => {
  const ci = await workflow('ci.yml');
  const pages = await workflow('deploy-pages.yml');
  const cacheKey = (job, prefix) => job.steps.map(step => step.with?.key).find(key => key?.startsWith(prefix));
  for (const [file, flow, id, saver, prefix] of [
    ['ci.yml', ci, 'example-cache-retention', 'composite-site', 'example-assets-'],
    ['deploy-pages.yml', pages, 'turbo-cache-retention', 'build', 'turbo-pages-'],
  ]) {
    const job = flow.jobs[id];
    assert.ok(job, `${file} deletes superseded ${prefix} caches`);
    assert.ok(cacheKey(flow.jobs[saver], prefix), `${file}: ${saver} saves the ${prefix} caches`);
    assert.equal(job.needs, saver, `${file}: ${id} runs once ${saver} has saved its cache`);
    assert.deepEqual(job.permissions, { actions: 'write' }, `${file}: ${id} can delete caches and nothing else`);
    assert.equal(job['continue-on-error'], true, `${file}: a failed cleanup does not fail the run`);
    assert.ok(job.steps.every(step => !step.uses), `${file}: ${id} runs no action with its write token`);
    const [{ run, env }] = job.steps;
    assert.equal(job.steps.length, 1);
    // Newest first, and everything after the first is deleted.
    assert.match(run, new RegExp(`^gh cache list --ref "\\$CACHE_REF" --key ${prefix} --sort created_at --order desc --limit 100 --json id --jq '\\.\\[1:\\]\\[\\]\\.id' \\|\\s+xargs --no-run-if-empty --max-args 1 gh cache delete\\s*$`));
    assert.deepEqual(Object.keys(env).sort(), ['CACHE_REF', 'GH_REPO', 'GH_TOKEN']);
    for (const [other, { needs }] of Object.entries(flow.jobs)) {
      assert.ok(![needs].flat().includes(id), `${file}: ${other} does not wait for the cleanup`);
    }
    for (const [other, { permissions }] of Object.entries(flow.jobs)) {
      if (other !== id) assert.notEqual(permissions?.actions, 'write', `${file}: only ${id} may delete caches`);
    }
    assert.notEqual(flow.permissions.actions, 'write', `${file}: the write permission is the job's alone`);
  }
  const retention = ci.jobs['example-cache-retention'];
  assert.equal(retention.steps[0].env.CACHE_REF, 'refs/heads/main');
  assert.equal(retention.if, "github.ref == 'refs/heads/main'", 'only main saves, so only main has a copy to supersede');
  assert.equal(pages.jobs['turbo-cache-retention'].if, undefined, 'every deploy build saves a cache');
  assert.equal(pages.jobs['turbo-cache-retention'].steps[0].env.CACHE_REF, '${{ github.ref }}');
});
