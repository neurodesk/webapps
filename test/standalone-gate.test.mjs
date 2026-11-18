import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import YAML from 'yaml';
import { loadAppsRegistry, repoRoot } from '../scripts/lib/apps-registry.mjs';
import { moduleClosure } from '../scripts/lib/module-closure.mjs';
import {
  FORCED_BUILD_AFTER_MS, calledWorkflows, decideStandalone, nonInput, publishedBase, published, resolvePublishedBase,
} from '../scripts/lib/standalone-gate.mjs';
import { workflowScripts } from '../scripts/lib/workflow-gate.mjs';

// The scheduled desktop build is skipped only when nothing it reads changed
// since the suites were last published. A wrong skip leaves the published
// suites behind main for up to a week; a wrong build only costs minutes.
const registry = await loadAppsRegistry();
const read = async (name) => YAML.parse(await readFile(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));
const flow = await read('standalone');
const standaloneText = await readFile(new URL('../registry/standalone.json', import.meta.url), 'utf8');

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-11-19T03:30:00Z');
const PUBLISH_JOBS = [
  { name: 'bundle', conclusion: 'success' },
  { name: 'publish (neuro, webapps)', conclusion: 'success' },
  { name: 'publish (msk, msk-webapps)', conclusion: 'success' },
];
const SKIPPED_JOBS = [
  { name: 'gate', conclusion: 'success' },
  { name: 'bundle', conclusion: 'skipped' },
  { name: 'publish', conclusion: 'skipped' },
];
const run = (id, sha, { event = 'schedule', conclusion = 'success', started = NOW - 24 * HOUR, branch = 'main' } = {}) => ({
  id, head_sha: sha, event, conclusion, head_branch: branch, run_attempt: 1, run_started_at: new Date(started).toISOString(),
});
// A linear history c0 .. c9: a commit's distance to a later one is the index difference.
const git = {
  isAncestor: (a, b) => a.startsWith('c') && b.startsWith('c') && Number(a.slice(1)) <= Number(b.slice(1)),
  distance: (a, b) => Number(b.slice(1)) - Number(a.slice(1)),
};
const base = (sha, started = NOW - 24 * HOUR) => ({ base: sha, run: run(1, sha, { started }), reason: `base ${sha}` });
const schedule = (changedPaths, options = {}) => decideStandalone({
  event: 'schedule', base: base('c5'), head: 'c9', changedPaths, flow, registry, now: NOW, ...options,
});
const suitesOnly = () => {
  const catalog = JSON.parse(standaloneText);
  const [id] = Object.keys(catalog.suites);
  catalog.suites[id] = { ...catalog.suites[id], revision: '0'.repeat(40) };
  return new Map([['registry/standalone.json', { before: standaloneText, after: `${JSON.stringify(catalog, null, 2)}\n` }]]);
};

test('a dispatch always builds, without asking the API', () => {
  const decision = decideStandalone({ event: 'workflow_dispatch' });
  assert.equal(decision.run, true);
  assert.match(decision.reason, /workflow_dispatch run always builds/);
});

test('a changed desktop input builds', () => {
  for (const path of ['apps/brainchop/src/main.js', 'packages/desktop/src/main.js', 'scripts/desktop/smoke.mjs', 'docs/architecture/offline-executables.md',
    'pnpm-lock.yaml', '.github/workflows/standalone.yml', '.github/workflows/desktop-source-approval.yml', '.github/actions/setup-wasm-opt/action.yml']) {
    const decision = schedule(['.github/workflows/ci.yml', path]);
    assert.equal(decision.run, true, path);
    assert.match(decision.reason, new RegExp(`^${path.replaceAll('.', '\\.')} changed since c5`), path);
  }
});

test('an unchanged tree skips: other workflows and the published suites are not inputs', () => {
  const decision = schedule(['.github/workflows/ci.yml', '.github/workflows/deploy-pages.yml', 'registry/standalone.json'], { manifests: suitesOnly() });
  assert.equal(decision.run, false);
  assert.match(decision.reason, /no desktop input changed since c5 \(3 non-input paths aside\)/);
  assert.equal(schedule([], { head: 'c5' }).run, false, 'nothing changed since the published head');
});

test('a catalog change beyond the published suites is an input', () => {
  const catalog = JSON.parse(standaloneText);
  const [id] = Object.keys(catalog.apps);
  catalog.apps[id] = { ...catalog.apps[id], extraField: true };
  const apps = new Map([['registry/standalone.json', { before: standaloneText, after: JSON.stringify(catalog) }]]);
  assert.equal(nonInput('registry/standalone.json', { flow, manifests: apps, registry }), null, 'an app entry or an invalid catalog');
  assert.equal(nonInput('registry/standalone.json', { flow, manifests: new Map(), registry }), null, 'unreadable text');
  assert.equal(nonInput('registry/standalone.json', { flow, manifests: suitesOnly(), registry: undefined }), null, 'no registry to validate against');
  assert.equal(nonInput('registry/standalone.json', { flow, manifests: suitesOnly(), registry }), 'only the published suites changed');
  assert.equal(nonInput('.github/workflows/standalone.yml', { flow, registry }), null);
  assert.deepEqual(calledWorkflows(flow), ['desktop-source-approval']);
});

test('the seventh night builds whatever changed', () => {
  const week = schedule(['.github/workflows/ci.yml'], { base: base('c5', NOW - 7 * 24 * HOUR + 2 * HOUR) });
  assert.equal(week.run, true, 'a week minus a late start');
  assert.match(week.reason, /^the weekly build: the suites were last published by run 1/);
  assert.equal(schedule(['.github/workflows/ci.yml'], { base: base('c5', NOW - FORCED_BUILD_AFTER_MS + HOUR) }).run, false, 'six nights');
});

test('no published run, an unknown diff or an empty diff between different commits builds', () => {
  assert.equal(decideStandalone({ event: 'schedule', base: { base: null, reason: 'no run' }, now: NOW }).run, true);
  assert.equal(schedule(null).run, true);
  assert.match(schedule([]).reason, /git lists no changed path between c5 and c9/);
  assert.equal(schedule([], { base: { ...base('c5'), run: { id: 1, head_sha: 'c5' } } }).run, true, 'no start time');
});

test('the base is the nearest green run that published, never a skipped night', async () => {
  const jobs = new Map([[11, SKIPPED_JOBS], [12, PUBLISH_JOBS], [13, PUBLISH_JOBS], [14, PUBLISH_JOBS.slice(0, 1)], [15, PUBLISH_JOBS], [16, PUBLISH_JOBS]]);
  const runs = [
    run(11, 'c8'), // a skipped night: green, published nothing
    run(14, 'c7', { event: 'workflow_dispatch' }), // a dispatch without publish
    run(15, 'c7', { branch: 'feature' }), // another branch
    run(16, 'x1'), // not an ancestor of the head
    run(12, 'c4'),
    run(13, 'c2', { event: 'workflow_dispatch' }),
  ];
  const asked = [];
  const jobsOf = async (candidate) => {
    asked.push(candidate.id);
    return jobs.get(candidate.id);
  };
  const found = await publishedBase({ runs, head: 'c9', git, jobsOf });
  assert.equal(found.base, 'c4');
  assert.equal(found.run.id, 12);
  assert.deepEqual(asked, [11, 14, 12], 'nearest first, stopping at the first published run');
  assert.equal((await publishedBase({ runs: runs.slice(0, 4), head: 'c9', git, jobsOf })).base, null);
  assert.equal((await publishedBase({ runs: [run(17, 'c3', { conclusion: 'failure' })], head: 'c9', git, jobsOf })).base, null);
  assert.equal(published([{ name: 'bundle', conclusion: 'success' }, { name: 'publish (neuro, webapps)', conclusion: 'failure' }, ...PUBLISH_JOBS]), false);
  assert.equal(published(SKIPPED_JOBS), false);
});

test('an API error or a failed jobs listing builds', async () => {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  const env = { GITHUB_REPOSITORY: 'owner/repo', GITHUB_TOKEN: 'token' };
  const down = await resolvePublishedBase({ head, cwd: repoRoot, env, fetchImpl: async () => new Response('bad gateway', { status: 502 }) });
  assert.equal(down.base, null);
  assert.match(down.reason, /unknown: the Actions API answered 502/);
  assert.equal(decideStandalone({ event: 'schedule', base: down, now: NOW }).run, true);
  const listing = { workflow_runs: [run(21, head)] };
  const jobsDown = await resolvePublishedBase({
    head, cwd: repoRoot, env,
    fetchImpl: async (url) => (url.includes('/jobs') ? new Response('', { status: 500 }) : Response.json(listing)),
  });
  assert.equal(jobsDown.base, null);
  assert.match(jobsDown.reason, /answered 500 for the jobs of run 21/);
  const unauthenticated = await resolvePublishedBase({ head, cwd: repoRoot, env: {} });
  assert.equal(unauthenticated.base, null);
  const answered = await resolvePublishedBase({
    head, cwd: repoRoot, env,
    fetchImpl: async (url) => (url.includes('/jobs') ? Response.json({ jobs: PUBLISH_JOBS }) : Response.json(listing)),
  });
  assert.equal(answered.base, head);
  assert.equal(answered.head, head);
});

test('the scheduled build waits for the gate, and a skipped night finishes green without publishing', () => {
  const { decide: gate, bundle, publish } = flow.jobs;
  assert.deepEqual(gate.permissions, { contents: 'read', actions: 'read' });
  assert.equal(bundle.needs, 'decide');
  assert.equal(gate.outputs.run, '${{ steps.event.outputs.run || steps.decide.outputs.run }}');
  const step = gate.steps.find((candidate) => candidate.id === 'decide');
  assert.match(step.run, /node scripts\/standalone-gate\.mjs --event "\$EVENT_NAME" --head "\$HEAD_SHA"/);
  assert.equal(step.if, "steps.event.outputs.run == ''");
  for (const event of ['schedule', 'workflow_dispatch']) {
    for (const only of [false, true]) {
      const context = { github: { event_name: event }, inputs: { source_approval_only: only } };
      assert.equal(runInNewContext(gate.if, context), event !== 'workflow_dispatch' || !only);
    }
  }
  for (const answer of ['true', 'false', '']) {
    assert.equal(runInNewContext(bundle.if, { needs: { decide: { outputs: { run: answer } } } }), answer === 'true');
  }
  // publish keeps GitHub's implicit success(): it runs only after its needs ran and passed.
  assert.doesNotMatch(publish.if, /always\(\)|!cancelled\(\)|failure\(\)/);
  for (const name of ['assemble', 'desktop', 'models-offline', 'publish']) {
    const needs = [flow.jobs[name].needs].flat();
    assert.ok(needs.includes('bundle'), `${name} waits for the build`);
    assert.doesNotMatch(flow.jobs[name].if ?? '', /always\(\)|!cancelled\(\)/, name);
  }
});

// Another workflow's file is not an input only while nothing the desktop build
// runs reads one: the scripts this workflow names, what they load, and the
// apps, packages and shell `pnpm build` builds.
test('nothing the desktop build runs reads a workflow file', async () => {
  const called = await Promise.all(calledWorkflows(flow).map(read));
  const { decide, ...building } = flow.jobs;
  assert.ok(decide, 'the decide job builds nothing');
  const scripts = workflowScripts({ jobs: building }, called);
  assert.ok(scripts.includes('scripts/desktop/smoke.mjs') && scripts.includes('test/standalone.test.mjs'), 'the scripts are found');
  const closure = moduleClosure(repoRoot, scripts);
  const READS_WORKFLOWS = /['"`]\.github\/workflows|['"`]\.github['"`]/;
  const readers = [];
  for (const file of closure) {
    if (READS_WORKFLOWS.test(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'))) readers.push(file);
  }
  assert.deepEqual(readers, []);
  let built = [];
  try {
    built = execFileSync('git', ['grep', '-lE', READS_WORKFLOWS.source.replaceAll('\\/', '/'), '--', 'apps', 'packages', 'site', 'exes', ':!*.md', ':!*/upstream.json'], { cwd: repoRoot, encoding: 'utf8' })
      .split('\n').filter(Boolean);
  } catch (error) {
    if (error.status !== 1) throw error;
  }
  assert.deepEqual(built, [], 'upstream.json lists paths sync-upstream leaves out; no build reads it');
});
