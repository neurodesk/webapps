import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import YAML from 'yaml';
import { loadAppsRegistry, registryPath, repoRoot } from '../scripts/lib/apps-registry.mjs';
import { publishNative, pullRequestSelection, sweepSelection } from '../scripts/lib/native-decision.mjs';
import { WITHHELD_CONDITION, callCondition, dispatchedWorkflows } from '../scripts/lib/native-workflow.mjs';
import { certainOwnStart, dispatchDecision, reachesSharedPaths, readChangedPaths, swept } from '../scripts/lib/workflow-gate.mjs';
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
  // An own filter form it does not model is never certain, nor is any list with an exclusion.
  const unmodelled = { on: { pull_request: { paths: ['apps/**/main.js', 'apps/x/[ab].js'] } } };
  assert.equal(certainOwnStart(unmodelled, { paths: ['apps/x/main.js', 'apps/x/a.js'] }), null);
  const excluding = { on: { pull_request: { paths: ['packages/x/**', '!packages/x/skip/**'] } } };
  assert.equal(certainOwnStart(excluding, { paths: ['packages/x/a.js'] }), null);
  // The reviewer's case: GitHub's ** matches a newline, so the base gate ran and native.yml must too.
  const newline = 'packages/components/test/foo\nbar.txt';
  assert.equal(reachesSharedPaths(elastix, [newline]), true);
  assert.equal(dispatchDecision({ flow: elastix, changedPaths: [newline], ...context }).run, true);
  // A path it does not model reaches every shared filter; a plain one outside them does not.
  assert.equal(reachesSharedPaths(elastix, ['docs/a b.md']), true);
  assert.equal(reachesSharedPaths(elastix, ['docs/plain.md']), false);
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
  // The deadline covers the budget: past it the budget is not read, and a read that outlasts it is no denial.
  let now = 0;
  asked = false;
  const late = await pullRequest({ deadline: 10, clock: () => now, decide: ({ name }) => { now = 20; return decided[name]; }, budget: () => { asked = true; return { withheld: true }; } });
  assert.equal(asked, false);
  assert.equal(late.withheld, null);
  const slow = await pullRequest({ deadline: Date.now() + 50, budget: () => new Promise(() => {}) });
  assert.equal(slow.withheld, null);
  assert.deepEqual(selected(slow), ['reach']);
  // Only a confirmed denial withholds.
  for (const verdict of [undefined, null, {}, { withheld: 'true' }, { withheld: 1 }]) assert.equal((await pullRequest({ budget: () => verdict })).withheld, null, JSON.stringify(verdict));
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
const skipList = (output) => JSON.parse(output.match(/^skips=(.*)$/m)[1]);

test('the gate skips nothing when the pull request diff is unreadable', () => {
  const unreadable = gate(['--base', 'no-such-commit', '--head', 'HEAD']);
  assert.equal(unreadable.status, 0, unreadable.stderr);
  assert.deepEqual(skipList(unreadable.output), []);
  assert.match(unreadable.stderr, /bison-native runs: the changed paths are unknown/);
  // native.yml passes the workflows it may call.
  const listed = gate(['--base', 'no-such-commit', '--head', 'HEAD'], { NATIVE_ELIGIBLE: 'bison-native elastix-native' });
  assert.deepEqual(skipList(listed.output), []);
  assert.doesNotMatch(listed.stderr, /calmar-native/);
});

test('the sweep skips nothing whose history it could not read', () => {
  // No token: every history read fails.
  const sweep = gate(['--sweep', '--head', 'HEAD']);
  assert.equal(sweep.status, 0, sweep.stderr);
  assert.deepEqual(skipList(sweep.output), []);
  assert.match(sweep.stderr, /GITHUB_REPOSITORY and GITHUB_TOKEN are needed/);
});

// GitHub's expression functions as native.yml's conditions use them: string
// comparisons and contains() ignore case, and a missing output is ''.
function evaluate(condition, { result, skips, withheld, event = 'pull_request', cancelled = false }) {
  const text = (value) => (value === undefined || value === null ? '' : String(value)).toLowerCase();
  return Boolean(runInNewContext(condition.replace(/^\$\{\{\s*|\s*\}\}$/g, ''), {
    needs: { gate: { result, outputs: { skips, withheld } } },
    github: { event_name: event },
    cancelled: () => cancelled,
    startsWith: (search, item) => text(search).startsWith(text(item)),
    endsWith: (search, item) => text(search).endsWith(text(item)),
    contains: (search, item) => text(search).includes(text(item)),
  }));
}

test('native.yml runs a call unless a successful gate names it in its skip list', async () => {
  const native = (await workflow('native')).jobs;
  for (const [name, flow] of calls) assert.equal(native[name].if, callCondition(name, { sweep: swept(flow) }), name);
  assert.equal(native['full-plan-withheld'].if, WITHHELD_CONDITION);
  // The gate may name only the workflows native.yml lists, all of them for a draft.
  assert.deepEqual(native.gate.with.calls.split(' '), callNames);
  assert.deepEqual(native.gate.with.sweeps.split(' '), sweepNames);
  assert.ok(!sweepNames.includes('synthseg-native') && callNames.includes('synthseg-native'));
  const bison = callCondition('bison-native', { sweep: true });
  const outcomes = [
    // [gate result, skips, withheld, runs]
    ['success', '["bison-native","elastix-native"]', '', false],
    ['success', '["elastix-native"]', '', true],
    ['success', '[]', undefined, true],
    ['success', '', '', true],
    ['success', undefined, undefined, true],
    ['success', 'not json', '', true],
    ['success', '{"bison-native":true}', '', true],
    ['success', '["bison-native"', '', true],
    ['failure', '["bison-native"]', '', true],
    ['cancelled', '["bison-native"]', '', true],
    ['skipped', undefined, undefined, true],
    ['failure', undefined, 'true', false],
    ['success', '[]', 'true', false],
    ['failure', undefined, 'false', true],
    ['failure', undefined, ' true', true],
  ];
  for (const [result, skips, withheld, runs] of outcomes) {
    const label = `${result} ${skips} withheld=${withheld}`;
    assert.equal(evaluate(bison, { result, skips, withheld }), runs, label);
    assert.equal(evaluate(WITHHELD_CONDITION, { result, skips, withheld }), withheld === 'true', `full-plan-withheld: ${label}`);
  }
  // A cancelled run calls nothing; the sweep calls only what it sweeps, and a failed gate runs those.
  assert.equal(evaluate(bison, { result: 'failure', cancelled: true }), false);
  assert.equal(evaluate(WITHHELD_CONDITION, { result: 'success', withheld: 'true', cancelled: true }), false);
  assert.equal(evaluate(bison, { result: 'failure', event: 'schedule' }), true);
  const unswept = callCondition('synthseg-native', { sweep: false });
  assert.equal(evaluate(unswept, { result: 'failure', event: 'schedule' }), false);
  assert.equal(evaluate(unswept, { result: 'failure' }), true);
});

// A step of pr-gate.yml, run as GitHub runs it, with `node` or `jq` replaced by a stub.
async function gateStep(id, environment, stubs = {}, shells = [['-eo', 'pipefail'], ['-e']]) {
  const step = (await workflow('pr-gate')).jobs.decide.steps.find((each) => each.id === id);
  const bin = scratch('gate-stubs-');
  for (const [command, script] of Object.entries(stubs)) {
    writeFileSync(join(bin, command), `#!/bin/bash\n${script}\n`);
    chmodSync(join(bin, command), 0o755);
  }
  const temp = scratch('gate-step-');
  const output = join(temp, 'output');
  const results = [];
  for (const shell of shells) {
    writeFileSync(output, '');
    const run = spawnSync('bash', [...shell, '-c', step.run], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, WORKFLOW: 'native', EVENT_NAME: 'pull_request', BASE_SHA: 'base', HEAD_SHA: 'head', CALLS: callNames.join(' '), SWEEPS: sweepNames.join(' '), RUNNER_TEMP: temp, GITHUB_OUTPUT: output, ...environment },
    });
    results.push({ status: run.status, output: readFileSync(output, 'utf8'), stderr: run.stderr, stdout: run.stdout });
  }
  if (results.length > 1) assert.equal(results[1].status === 0, results[0].status === 0, 'bash -e and bash -eo pipefail agree');
  return results[0];
}
const decideStep = (environment, stubs, shells) => gateStep('decide', environment, stubs, shells);
const answering = (text) => `printf '%s' '${text}' > "$NATIVE_SKIPS"`;
const runsEverything = (output) => callNames.every((name) => evaluate(callCondition(name, { sweep: sweepNames.includes(name) }), { result: 'success', skips: output.match(/^skips=(.*)$/m)?.[1] }));

test('the decide step passes on only a skip list of workflows native.yml may call, and fails when the decision fails', async () => {
  const cases = {
    'a skip': [{ node: answering('["bison-native"]') }, 0, 'skips=["bison-native"]\n'],
    'no skips': [{ node: answering('[]') }, 0, 'skips=[]\n'],
    'a workflow native.yml does not call': [{ node: answering('["not-a-real-workflow"]') }, 1, ''],
    'a name that is not one': [{ node: answering('["bison native"]') }, 1, ''],
    'a name in another case': [{ node: answering('["BISON-NATIVE"]') }, 1, ''],
    'a blank value and exit 9': [{ node: `${answering('')}; exit 9` }, 9, ''],
    'a blank value and exit 0': [{ node: answering('') }, 1, ''],
    'no answer at all': [{ node: 'exit 0' }, 1, ''],
    'an object': [{ node: answering('{"bison-native":true}') }, 1, ''],
    'two arrays': [{ node: answering('[] ["bison-native"]') }, 1, ''],
    'a failing jq': [{ node: answering('["bison-native"]'), jq: 'exit 1' }, 1, ''],
    'a killed decision': [{ node: 'kill -9 $$' }, 137, ''],
    'a denial and then a crash': [{ node: `echo withheld=true >> "$GITHUB_OUTPUT"; exit 1` }, 0, 'withheld=true\n'],
  };
  for (const [label, [stubs, status, output]] of Object.entries(cases)) {
    const result = await decideStep({}, stubs);
    assert.equal(result.status, status, `${label}: ${result.stderr}`);
    assert.equal(result.output, output, label);
  }
  // The reviewer's cases: an unknown name skips nothing even if it were passed on, and an empty answer runs every call.
  assert.ok(runsEverything('skips=["not-a-real-workflow"]'));
  assert.ok(runsEverything((await decideStep({}, { node: answering('[]') })).output));
  // The sweep may name only what it sweeps.
  assert.equal((await decideStep({ EVENT_NAME: 'schedule' }, { node: answering('["synthseg-native"]') })).status, 1);
  assert.equal((await decideStep({ EVENT_NAME: 'schedule' }, { node: answering('["bison-native"]') })).output, 'skips=["bison-native"]\n');
});

test('a draft skips every workflow native.yml calls, each by name, before any checkout', async () => {
  const draft = await gateStep('event', { DRAFT: 'true' });
  assert.equal(draft.status, 0, draft.stderr);
  assert.match(draft.output, /^run=false\n/);
  const skips = draft.output.match(/^skips=(.*)$/m)[1];
  assert.deepEqual(JSON.parse(skips), callNames);
  for (const name of callNames) assert.equal(evaluate(callCondition(name, { sweep: sweepNames.includes(name) }), { result: 'success', skips }), false, name);
  // Without the list nothing is named, so a draft would run everything rather than nothing.
  assert.deepEqual(JSON.parse((await gateStep('event', { DRAFT: 'true', CALLS: '' })).output.match(/^skips=(.*)$/m)[1]), []);
});

// A seeded stream of corrupted skip lists: dropped, unknown, recased,
// reordered and repeated names, and truncated or rewrapped JSON text.
function* corruptions(count) {
  let seed = 11;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = (list) => list[Math.floor(random() * list.length)];
  for (let index = 0; index < count; index++) {
    let names = callNames.filter(() => random() < 0.3);
    if (random() < 0.3) names.push(pick(['not-a-real-workflow', 'bison', 'native', 'bison-native-extra', '']));
    if (random() < 0.2) names = names.map((name) => (random() < 0.5 ? name.toUpperCase() : name));
    if (random() < 0.3) names.reverse();
    if (random() < 0.2 && names.length) names.push(names[0]);
    let text = JSON.stringify(names);
    if (random() < 0.25) text = text.slice(0, Math.floor(random() * text.length));
    if (random() < 0.1) text = `{"skips":${text}}`;
    yield text;
  }
}

test('a call is skipped only when a successful gate names it exactly in a valid skip list', async () => {
  let skippedAny = 0;
  for (const text of corruptions(80)) {
    const result = await decideStep({}, { node: answering(text) }, [['-eo', 'pipefail']]);
    const output = result.output.match(/^skips=(.*)$/m)?.[1];
    let named = [];
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed) && parsed.every((name) => callNames.includes(name))) named = parsed;
    } catch {
      // Not valid JSON: it names nothing.
    }
    for (const name of callNames) {
      const skipped = !evaluate(callCondition(name, { sweep: sweepNames.includes(name) }), { result: result.status === 0 ? 'success' : 'failure', skips: output });
      if (skipped) skippedAny++;
      assert.ok(!skipped || named.includes(name), `${name} skipped for ${text}`);
    }
  }
  assert.ok(skippedAny > 0, 'some valid lists skip');
});

test('a confirmed denial is written first, and a summary that cannot be written changes nothing', async () => {
  const eligible = ['a', 'b'];
  const writes = [];
  const failing = () => { throw new Error('EISDIR'); };
  const denial = { decisions: new Map([['a', { run: true }], ['b', { run: false }]]), withheld: '#1 spent its budget' };
  assert.equal(await publishNative({ eligible, result: denial, writeOutput: (line) => writes.push(line), writeSkips: (json) => writes.push(json), writeSummary: failing }), 1);
  assert.deepEqual(writes, ['withheld=true']);
  writes.length = 0;
  // Only an explicit skip verdict is named; a workflow with no verdict runs.
  const decided = { decisions: new Map([['a', { run: true }], ['b', { run: false }]]) };
  assert.equal(await publishNative({ eligible: ['a', 'b', 'c'], result: decided, writeOutput: (line) => writes.push(line), writeSkips: (json) => writes.push(json), writeSummary: failing }), 0);
  assert.deepEqual(writes, ['["b"]']);
});

// The reviewer's case end to end: the real decide step and script, two full-plan
// ci runs from a `gh` stub, and a step summary that cannot be written. The
// head is a commit that changes one shared module, made in a scratch object
// store so that the checkout and its history (shallow in CI) stay untouched.
test('a confirmed budget denial survives an unwritable summary and skips every call', async () => {
  const temp = scratch('denial-');
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  const gitEnvironment = { GIT_OBJECT_DIRECTORY: join(temp, 'objects'), GIT_ALTERNATE_OBJECT_DIRECTORIES: join(common, 'objects'), GIT_INDEX_FILE: join(temp, 'index'), GIT_AUTHOR_NAME: 'gate', GIT_AUTHOR_EMAIL: 'gate@example.org', GIT_COMMITTER_NAME: 'gate', GIT_COMMITTER_EMAIL: 'gate@example.org' };
  mkdirSync(gitEnvironment.GIT_OBJECT_DIRECTORY);
  const git = (args, input) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', input, env: { ...process.env, ...gitEnvironment } }).trim();
  const base = git(['rev-parse', 'HEAD']);
  const module = 'packages/components/src/file-io/tiff.js';
  git(['read-tree', base]);
  const blob = git(['hash-object', '-w', '--stdin'], `${readFileSync(join(repoRoot, module), 'utf8')}// changed\n`);
  git(['update-index', '--cacheinfo', `100644,${blob},${module}`]);
  const head = git(['commit-tree', git(['write-tree']), '-p', base, '-m', 'shared change'], '');
  const bin = join(temp, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'package.json'), JSON.stringify({ type: 'commonjs' }));
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node
const state = JSON.parse(require('node:fs').readFileSync(process.env.GH_STUB_STATE, 'utf8'));
const path = process.argv.slice(2).find((arg) => arg.startsWith('repos/'));
if (/\\/pulls\\/\\d+$/.test(path)) console.log(JSON.stringify(state.labels));
else if (path.includes('/workflows/ci.yml/runs?')) for (const run of state.runs) console.log(JSON.stringify(run));
else if (/\\/runs\\/\\d+\\/jobs/.test(path)) for (const job of state.jobs[/\\/runs\\/(\\d+)\\//.exec(path)[1]] ?? []) console.log(JSON.stringify(job));
else { process.stderr.write('HTTP 404: unexpected ' + path); process.exit(1); }
`);
  chmodSync(join(bin, 'gh'), 0o755);
  const ago = (hours) => new Date(Date.now() - hours * 3600e3).toISOString().replace(/\.\d+Z$/, 'Z');
  const run = (id) => ({ id, name: 'ci', event: 'pull_request', status: 'completed', conclusion: 'success', head_branch: 'feature', head_sha: 'a'.repeat(40), created_at: ago(2), run_started_at: ago(2), updated_at: ago(1.5), pull_requests: [827], head_repository: 'neurodesk/webapps' });
  const marked = ['app-plan', 'full-plan', 'app-tests (calmar)'].map((job) => ({ name: job, conclusion: 'success' }));
  const state = (labels) => {
    const file = join(temp, `state-${labels.length}.json`);
    writeFileSync(file, JSON.stringify({ labels, runs: [run(101), run(102)], jobs: { 101: marked, 102: marked } }));
    return file;
  };
  writeFileSync(join(temp, 'event.json'), JSON.stringify({ pull_request: { number: 827, head: { ref: 'feature', sha: 'b'.repeat(40), repo: { full_name: 'neurodesk/webapps' } } } }));
  const summary = join(temp, 'summary-is-a-directory');
  mkdirSync(summary);
  const environment = (labels) => ({
    ...gitEnvironment, PATH: `${bin}:${process.env.PATH}`, GH_STUB_STATE: state(labels), BASE_SHA: base, HEAD_SHA: head, NATIVE_ELIGIBLE: 'calmar-native',
    GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: join(temp, 'event.json'), GITHUB_REPOSITORY: 'neurodesk/webapps', GITHUB_STEP_SUMMARY: summary,
  });
  const denied = await decideStep({ ...environment([]), CALLS: 'calmar-native' });
  assert.equal(denied.status, 0, denied.stderr);
  assert.equal(denied.output, 'withheld=true\n');
  assert.match(denied.stdout, /::error title=Full plan withheld::native: #827 already started 2 full-plan ci runs/);
  const calmar = callCondition('calmar-native', { sweep: true });
  assert.equal(evaluate(calmar, { result: 'success', withheld: 'true' }), false);
  assert.equal(evaluate(calmar, { result: 'success', skips: '[]' }), true);
  assert.equal(evaluate(WITHHELD_CONDITION, { result: 'success', withheld: 'true' }), true);
  // With the full-ci label the budget allows the full plan, and the decision runs CALMaR.
  const allowed = await decideStep({ ...environment(['full-ci']), CALLS: 'calmar-native' });
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.output, 'skips=[]\n');
});
