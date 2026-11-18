import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import YAML from 'yaml';
import { loadAppsRegistry, registryPath, repoRoot } from '../scripts/lib/apps-registry.mjs';
import { pullRequestSelection, sweepSelection } from '../scripts/lib/native-decision.mjs';
import { dispatchedWorkflows } from '../scripts/lib/native-workflow.mjs';
import { certainOwnStart, dispatchDecision, readChangedPaths, swept } from '../scripts/lib/workflow-gate.mjs';
import { loadConservativeWorkspaceGraph } from '../scripts/lib/workspace-graph.mjs';

// native.yml's gate may leave a workflow out only on what it read in full.
// A wrong skip hides a regression until main; a wrong run costs one run.
const scratch = (prefix) => mkdtempSync(join(tmpdir(), prefix));
const workflow = async (name) => YAML.parse(await readFile(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));
const calls = await dispatchedWorkflows(repoRoot);
const callNames = calls.map(([name]) => name);
const sweepNames = calls.filter(([, flow]) => swept(flow)).map(([name]) => name);

function repository(files) {
  const root = scratch('changed-paths-');
  const git = (...args) => execFileSync('git', ['-c', 'user.name=gate', '-c', 'user.email=gate@example.org', ...args], { cwd: root, encoding: 'utf8' }).trim();
  git('init', '--quiet');
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  git('add', '-A');
  git('commit', '--quiet', '-m', 'base');
  return { root, git, base: git('rev-parse', 'HEAD') };
}

test('changed paths are read whole, renames on both sides, and an unreadable comparison is not an empty one', () => {
  const { root, git, base } = repository({ 'keep.txt': 'a long enough text to be found as the same file\n'.repeat(20), 'other.txt': 'x\n' });
  mkdirSync(join(root, 'moved'));
  git('mv', 'keep.txt', 'moved/keep.txt');
  writeFileSync(join(root, '.github-elastix-native.yml '), 'trailing space\n');
  writeFileSync(join(root, 'tab\tname.js'), 'tab\n');
  git('add', '-A');
  git('commit', '--quiet', '-m', 'head');
  const head = git('rev-parse', 'HEAD');
  const diff = readChangedPaths({ base, head, cwd: root });
  assert.equal(diff.ok, true);
  assert.deepEqual([...diff.paths].sort(), ['.github-elastix-native.yml ', 'keep.txt', 'moved/keep.txt', 'tab\tname.js']);
  assert.deepEqual([...diff.renamed].sort(), ['keep.txt', 'moved/keep.txt']);
  assert.deepEqual(readChangedPaths({ base: head, head, cwd: root }), { ok: true, paths: [], renamed: new Set() });
  const unreadable = readChangedPaths({ base: 'no-such-commit', head, cwd: root });
  assert.equal(unreadable.ok, false);
  assert.match(unreadable.reason, /no-such-commit/);
  assert.equal(readChangedPaths({ base: '', head, cwd: root }).ok, false);
});

test('native.yml leaves a workflow out only where GitHub certainly started it itself', async () => {
  const elastix = await workflow('elastix-native');
  const context = { registry: await loadAppsRegistry(), graph: await loadConservativeWorkspaceGraph(repoRoot), root: repoRoot };
  const shared = 'packages/components/src/file-io/NiftiUtils.js';
  // The reviewer's case: git keeps the trailing space and GitHub's literal filter does not match it.
  assert.equal(dispatchDecision({ flow: elastix, changedPaths: ['.github/workflows/elastix-native.yml ', shared], ...context }).run, true);
  assert.deepEqual(certainOwnStart(elastix, { paths: ['.github/workflows/elastix-native.yml'] }), { path: '.github/workflows/elastix-native.yml', filter: '.github/workflows/elastix-native.yml' });
  const own = 'packages/elastix/src/presets.js';
  assert.equal(certainOwnStart(elastix, { paths: [own] }).filter, 'packages/elastix/**');
  assert.equal(dispatchDecision({ flow: elastix, changedPaths: [own, shared], ...context }).run, false);
  // A rename or copy, an unusual name, a hidden file under a wildcard, or no comparison under GitHub's 3,000 files: not certain.
  for (const [paths, renamed] of [
    [[own], new Set([own])],
    [['packages/elastix/src/a b.js']],
    [['packages/elastix/src/é.js']],
    [['packages/elastix/.hidden']],
    [[own, ...Array.from({ length: 2999 }, (_, index) => `docs/${index}.md`)]],
  ]) {
    assert.equal(certainOwnStart(elastix, { paths, renamed }), null, `${paths[0]} (${paths.length} paths)`);
  }
  assert.ok(certainOwnStart(elastix, { paths: [own, ...Array.from({ length: 2998 }, (_, index) => `docs/${index}.md`)] }));
  // An own filter form it does not model is never certain.
  const unmodelled = { on: { pull_request: { paths: ['apps/**/main.js', 'apps/x/[ab].js'] } } };
  assert.equal(certainOwnStart(unmodelled, { paths: ['apps/x/main.js', 'apps/x/a.js'] }), null);
});

// Three workflows: `own` changed one of its own paths, `skip` is not reached
// by the change, `reach` is.
const flowOf = (name) => ({ on: { pull_request: { paths: [`packages/${name}/**`] } }, jobs: { gate: { with: { workflow: name, shared_paths: 'packages/components/**' } } } });
const eligible = ['own', 'skip', 'reach'];
const pullRequestDiff = { ok: true, paths: ['packages/own/x.js', 'packages/components/y.js'], renamed: new Set() };
const decided = { skip: { run: false, reason: 'not reached' }, reach: { run: true, reason: 'reached' } };
function pullRequest(overrides = {}) {
  return pullRequestSelection({
    eligible,
    readDiff: () => pullRequestDiff,
    readFlow: (name) => flowOf(name),
    readContext: () => ({ registry: {}, graph: null }),
    decide: ({ name }) => decided[name],
    budget: () => ({ withheld: false }),
    ...overrides,
  });
}
const selected = ({ decisions }) => [...decisions].filter(([, decision]) => decision.run).map(([name]) => name);
const fail = (stage) => () => {
  throw new Error(`${stage} failed`);
};

test('a pull request selection narrows only on what it read in full', async () => {
  assert.deepEqual(selected(await pullRequest()), ['reach']);
  // Each stage that fails leaves selected every workflow not proven to have started itself.
  const cases = {
    'the diff throws': [{ readDiff: fail('diff') }, eligible],
    'the diff is unreadable': [{ readDiff: () => ({ ok: false, reason: 'bad base' }) }, eligible],
    'a workflow file throws': [{ readFlow: (name) => (name === 'skip' ? fail('flow')() : flowOf(name)) }, ['skip', 'reach']],
    'the registry or graph throws': [{ readContext: fail('context') }, ['skip', 'reach']],
    'one decision throws': [{ decide: ({ name }) => (name === 'skip' ? fail('decide')() : decided[name]) }, ['skip', 'reach']],
    'the deadline passes': [{ deadline: 0, clock: () => 1 }, ['skip', 'reach']],
  };
  for (const [label, [overrides, expected]] of Object.entries(cases)) {
    const result = await pullRequest(overrides);
    assert.deepEqual(selected(result), expected, label);
    assert.equal(result.decisions.get('own').run, expected.includes('own'), `${label}: own`);
    assert.ok(!result.withheld, label);
  }
  // A budget check that fails runs them; a spent budget withholds them, and the gate fails.
  assert.deepEqual(selected(await pullRequest({ budget: fail('budget') })), ['reach']);
  const withheld = await pullRequest({ budget: () => ({ withheld: true, reason: '#1 spent its budget' }) });
  assert.equal(withheld.withheld, '#1 spent its budget');
  // Nothing reached: no budget is read.
  let asked = false;
  await pullRequest({ decide: () => ({ run: false, reason: 'no' }), budget: () => { asked = true; return { withheld: true }; } });
  assert.equal(asked, false);
});

test('a sweep selection runs every workflow whose history, range or registry it could not read', async () => {
  const sweep = (overrides = {}) => sweepSelection({
    eligible: ['a', 'b'],
    readRegistry: () => ({}),
    readFlow: (name) => flowOf(name),
    readBase: () => ({ base: 'base' }),
    readRange: () => ({ ok: true, paths: [], manifests: new Map() }),
    decide: () => ({ run: false, reason: 'nothing changed' }),
    ...overrides,
  });
  assert.deepEqual(selected(await sweep()), []);
  const cases = {
    'the registry throws': [{ readRegistry: fail('registry') }, ['a', 'b']],
    'a workflow file throws': [{ readFlow: (name) => (name === 'a' ? fail('flow')() : flowOf(name)) }, ['a']],
    'a history read fails': [{ readBase: (name) => (name === 'b' ? Promise.reject(new Error('the Actions API answered 502')) : { base: 'base' }) }, ['b']],
    'no green run is known': [{ readBase: () => ({ base: null, reason: 'no successful run' }) }, ['a', 'b']],
    'the range is unreadable': [{ readRange: () => ({ ok: false, reason: 'bad base' }) }, ['a', 'b']],
    'a decision throws': [{ decide: fail('decide') }, ['a', 'b']],
  };
  for (const [label, [overrides, expected]] of Object.entries(cases)) assert.deepEqual(selected(await sweep(overrides)), expected, label);
  // The history reads share one deadline: what it has not reached by then runs.
  let now = 0;
  const late = await sweep({ deadline: 10, clock: () => now, readBase: () => { now = 20; return { base: 'base' }; } });
  assert.deepEqual(selected(late), ['b']);
  assert.match(late.decisions.get('b').reason, /deadline/);
  // The reviewer's case: a registry that does not validate.
  const invalid = join(scratch('registry-'), 'apps.yml');
  writeFileSync(invalid, readFileSync(registryPath, 'utf8').replace(/^site:\n/m, 'site: invalid\nformer_site:\n'));
  await assert.rejects(loadAppsRegistry(invalid));
  assert.deepEqual(selected(await sweep({ readRegistry: () => loadAppsRegistry(invalid) })), ['a', 'b']);
});

function gate(args, environment = {}) {
  const output = join(scratch('native-gate-'), 'output');
  writeFileSync(output, '');
  const { GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_EVENT_NAME, GITHUB_EVENT_PATH, GITHUB_STEP_SUMMARY, ...rest } = process.env;
  const result = spawnSync(process.execPath, ['scripts/workflow-gate.mjs', '--native', ...args], { cwd: repoRoot, encoding: 'utf8', env: { ...rest, GITHUB_OUTPUT: output, ...environment } });
  return { status: result.status, stderr: result.stderr, output: readFileSync(output, 'utf8') };
}
const selection = (output) => JSON.parse(output.match(/^workflows=(.*)$/m)[1]);

test('the gate selects every workflow native.yml may call when the pull request diff is unreadable', () => {
  const unreadable = gate(['--base', 'no-such-commit', '--head', 'HEAD']);
  assert.equal(unreadable.status, 0, unreadable.stderr);
  assert.deepEqual(selection(unreadable.output), callNames);
  // native.yml passes the lists itself.
  const listed = gate(['--base', 'no-such-commit', '--head', 'HEAD'], { NATIVE_ELIGIBLE: 'bison-native elastix-native' });
  assert.deepEqual(selection(listed.output), ['bison-native', 'elastix-native']);
});

test('the sweep selects every workflow whose history it could not read', () => {
  // No token: every history read fails.
  const sweep = gate(['--sweep', '--head', 'HEAD']);
  assert.equal(sweep.status, 0, sweep.stderr);
  assert.deepEqual(selection(sweep.output), sweepNames);
  assert.match(sweep.stderr, /GITHUB_REPOSITORY and GITHUB_TOKEN are needed/);
});

// The decide step's shell around the script, with `node` replaced by a stub.
test('a native decision that ends without a selection runs every workflow native.yml lists; a withheld one fails', async () => {
  const flow = await workflow('pr-gate');
  const step = flow.jobs.decide.steps.find((each) => each.id === 'decide');
  const native = (await workflow('native')).jobs.gate.with;
  assert.deepEqual(native.calls.split(' '), callNames);
  assert.deepEqual(native.sweeps.split(' '), sweepNames);
  assert.equal(step.env.CALLS, '${{ inputs.calls }}');
  assert.equal(step.env.SWEEPS, '${{ inputs.sweeps }}');
  const bin = scratch('fake-node-');
  writeFileSync(join(bin, 'node'), `#!/bin/bash
case "$FAKE" in
  crash) exit 3 ;;
  withheld) printf 'workflows=[]\\nwithheld=true\\n' >> "$GITHUB_OUTPUT"; exit 1 ;;
  decided) echo "workflows=[\\"$NATIVE_ELIGIBLE\\"]" >> "$GITHUB_OUTPUT" ;;
esac
`);
  chmodSync(join(bin, 'node'), 0o755);
  const run = (FAKE, EVENT_NAME = 'pull_request') => {
    const output = join(scratch('decide-step-'), 'output');
    writeFileSync(output, '');
    const result = spawnSync('bash', ['-e', '-c', step.run], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE, EVENT_NAME, WORKFLOW: 'native', CALLS: 'a b', SWEEPS: 'a', BASE_SHA: 'base', HEAD_SHA: 'head', GITHUB_OUTPUT: output } });
    return { status: result.status, output: readFileSync(output, 'utf8') };
  };
  assert.deepEqual(run('crash'), { status: 0, output: 'workflows=["a","b"]\n' });
  assert.deepEqual(run('crash', 'schedule'), { status: 0, output: 'workflows=["a"]\n' });
  assert.equal(run('withheld').status, 1);
  assert.deepEqual(run('decided'), { status: 0, output: 'workflows=["a b"]\n' });
});
