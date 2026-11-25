import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import YAML from 'yaml';
import { loadAppsRegistry, repoRoot } from '../scripts/lib/apps-registry.mjs';
import { commandLineClosure, moduleClosure, onlyAddsExports, onlyBumpsVersion } from '../scripts/lib/module-closure.mjs';
import { testedBase } from '../scripts/lib/tested-base.mjs';
import { MAX_CALLS_PER_DISPATCHER, NOT_DRAFT_CONDITION, callCondition, callerPermissions, dispatchedWorkflows, renderNativeWorkflows, shardWorkflows } from '../scripts/lib/native-workflow.mjs';
import { DISPATCHER, budgetedDecision, calledWorkflows, certainOwnStart, decideWorkflow, dispatchDecision, dispatched, dispatchedRuns, isDispatcher, isSharedFilter, mainWorkflow, ownedPackages, pathGlob, pullRequestFilters, pushWorkflow, sharedPaths, swept, sweepWorkflow, workflowApps, workflowScripts } from '../scripts/lib/workflow-gate.mjs';
import { loadConservativeWorkspaceGraph } from '../scripts/lib/workspace-graph.mjs';
import { syncDriverPathsInSource } from '../scripts/sync-native-driver-paths.mjs';

// The pull request gate skips a native suite only when no changed file can
// reach it. A wrong skip hides a regression until main; a wrong run only costs
// minutes. Each case below is one way a shared change does or does not reach
// a workflow.
const registry = await loadAppsRegistry();
const graph = await loadConservativeWorkspaceGraph(repoRoot);
const flowOf = (paths) => ({ on: { pull_request: { paths } } });
const real = async (name) => YAML.parse(await readFile(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));
const decideReal = async (name, changedPaths, manifests = new Map(), paths) => {
  const source = await real(name);
  // A workflow that filters only on its own paths is still a fixture when
  // `paths` lists every filter, own and shared, it should have.
  const flow = paths ? { ...source, on: { pull_request: { paths } }, jobs: { ...source.jobs, gate: { ...source.jobs.gate, with: { workflow: name } } } } : source;
  const calledFlows = await Promise.all(calledWorkflows(flow).map(real));
  return decideWorkflow({ flow, calledFlows, changedPaths, registry, graph, manifests, root: repoRoot });
};
// The trees NeuroFlow's apps reach, which its nightly run covers instead of a filter.
const NEUROFLOW_BUILDS_ON = ['packages/**', 'scripts/**', 'registry/**'];
const decide = (paths, changedPaths, manifests = new Map()) => decideWorkflow({ flow: flowOf(paths), changedPaths, registry, graph, manifests, root: repoRoot });

const dep = (version) => ({ specifier: version, version });
const lock = (version) => JSON.stringify({
  lockfileVersion: '9.0',
  settings: { autoInstallPeers: true },
  importers: {
    '.': {},
    'apps/elastix': { dependencies: { left: dep('1.0.0') } },
    'packages/node-drivers': { dependencies: { right: dep(version) } },
  },
  packages: Object.fromEntries(['left@1.0.0', `right@${version}`].map((key) => [key, { resolution: { integrity: `sha512-${key}` } }])),
  snapshots: { 'left@1.0.0': {}, [`right@${version}`]: {} },
});

test('shared filters are the root manifests, whole root trees and globs into the shared packages', () => {
  for (const filter of ['pnpm-lock.yaml', 'package.json', 'pnpm-workspace.yaml', 'packages/**', 'exes/**', 'scripts/**', 'test/**', 'test-utils/**', 'registry/**', 'models/**', 'packages/components/**', 'packages/components/src/file-io/**', 'packages/components/package.json', 'packages/runtime-support/src/mindgrab/**', 'packages/runtime-support/package.json', 'packages/node-drivers/package.json', 'packages/node-drivers/src/niimath.js']) {
    assert.equal(isSharedFilter(filter), true, filter);
  }
  for (const filter of ['packages/elastix/**', 'packages/node-drivers/**', 'apps/elastix/**', 'exes/dwi/**', 'packages/components/src/file-io/NiftiUtils.js', 'test-utils/native-nifti/**', 'test/neuroflow*', 'models/bison.manifest.json', '.github/workflows/elastix-native.yml', 'registry/offline-assets.sources.json']) {
    assert.equal(isSharedFilter(filter), false, filter);
  }
});

test('a change under any other filter is the workflow\'s own and runs it', () => {
  const paths = ['packages/elastix/**', 'packages/components/**', 'apps/elastix/**', '.github/workflows/elastix-native.yml'];
  for (const path of ['packages/elastix/src/presets.js', 'apps/elastix/src/main.js', '.github/workflows/elastix-native.yml']) {
    const decision = decide(paths, ['packages/components/src/ui/console.js', path]);
    assert.equal(decision.run, true, path);
    assert.match(decision.reason, /matches/);
  }
});

test('an unknown diff, an exclusion or a workflow without filters runs', () => {
  assert.equal(decide(['packages/components/**'], []).run, true);
  assert.equal(decide(['packages/components/**', '!packages/components/README.md'], ['packages/components/src/ui/console.js']).run, true);
  assert.equal(decideWorkflow({ flow: { on: { pull_request: {} } }, changedPaths: ['a'], registry, graph, root: repoRoot }).run, true);
  // GitHub matched a file this diff does not contain.
  assert.equal(decide(['packages/components/**'], ['docs/readme.md']).run, true);
});

test('a shared file runs the workflow only when a script of an owned package loads it', () => {
  const paths = ['packages/noddi/**', 'packages/components/src/file-io/**'];
  const imported = commandLineClosure(repoRoot, 'packages/noddi').find((path) => path.startsWith('packages/components/src/file-io/'));
  assert.ok(imported, 'the NODDI command line imports a shared file-io module');
  const reached = decide(paths, [imported]);
  assert.equal(reached.run, true);
  assert.match(reached.reason, /a script in packages\/noddi loads/);
  const unreached = ['packages/components/src/file-io/tiff.js', 'packages/components/src/file-io/a-new-reader.js'];
  for (const path of unreached) assert.ok(!commandLineClosure(repoRoot, 'packages/noddi').includes(path), path);
  const skipped = decide(paths, unreached);
  assert.equal(skipped.run, false);
  assert.match(skipped.reason, /only shared paths changed/);
});

test('a browser harness in an owned package reaches the shared modules it loads', async () => {
  // packages/sdc/validation/harness imports MindGrab's browser wrapper; the command line does not.
  for (const path of ['packages/runtime-support/src/mindgrab/index.js', 'packages/runtime-support/src/mindgrab/worker.js']) {
    const decision = await decideReal('sdc-native', [path]);
    assert.equal(decision.run, true, path);
    assert.match(decision.reason, /a script in packages\/sdc loads/);
  }
});

test('a root script a step names, and what it imports, runs the workflow', async () => {
  const flow = await real('neuroflow');
  const scripts = workflowScripts(flow);
  for (const script of ['scripts/desktop/neuroflow-smoke.mjs', 'scripts/desktop/artifact-completion-smoke.mjs']) assert.ok(scripts.includes(script), script);
  // The template smoke is imported by neuroflow-smoke.mjs, not named by a step.
  for (const script of ['scripts/desktop/neuroflow-smoke.mjs', 'scripts/desktop/neuroflow-template-smoke.mjs', 'scripts/desktop/artifact-completion-smoke.mjs']) {
    const decision = await decideReal('neuroflow', [script], new Map(), NEUROFLOW_BUILDS_ON);
    assert.equal(decision.run, true, script);
    assert.match(decision.reason, /loads/);
  }
  assert.deepEqual(workflowScripts({ jobs: { a: { steps: [{ run: 'node scripts/a.mjs --x\nENV=1 node "test-utils/b.js"' }, { uses: 'x/y@1' }] }, b: { uses: './w.yml' } } }), ['scripts/a.mjs', 'test-utils/b.js']);
});

test('a deleted file is still a dependency of the module that names it', () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-closure-'));
  const write = (path, text) => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  mkdirSync(join(root, 'exes'));
  write('packages/tool/package.json', JSON.stringify({ name: '@x/tool' }));
  write('packages/tool/validation/harness.js', "import '@x/shared/wrapper';\nimport './gone';\nimport './kept.js';\n");
  write('packages/tool/validation/kept.js', '');
  write('packages/shared/package.json', JSON.stringify({ name: '@x/shared', exports: { './wrapper': './src/wrapper.js' } }));
  const seeds = ['packages/tool/validation/harness.js'];
  assert.deepEqual(moduleClosure(root, seeds), ['packages/shared/package.json', 'packages/tool/validation/harness.js', 'packages/tool/validation/kept.js']);
  const withMissing = moduleClosure(root, seeds, { missing: true });
  for (const path of ['packages/shared/src/wrapper.js', 'packages/tool/validation/gone.js', 'packages/tool/validation/gone/index.js']) assert.ok(withMissing.includes(path), path);
  assert.ok(moduleClosure(root, ['scripts/removed.mjs'], { missing: true }).includes('scripts/removed.mjs'), 'a deleted seed stays');
  assert.deepEqual(moduleClosure(root, ['scripts/removed.mjs']), []);
  const flow = { on: { pull_request: { paths: ['packages/tool/**', 'packages/**'] } } };
  const decision = decideWorkflow({ flow, changedPaths: ['packages/shared/src/wrapper.js'], registry, graph: null, root });
  assert.equal(decision.run, true);
  assert.match(decision.reason, /a script in packages\/tool loads packages\/shared\/src\/wrapper\.js/);
  assert.equal(decideWorkflow({ flow, changedPaths: ['packages/shared/src/other.js'], registry, graph: null, root }).run, false);
});

test('what a called reusable workflow runs counts as the caller\'s', async () => {
  const hmc = await real('hmc-native');
  assert.deepEqual(calledWorkflows(hmc), ['node-cli-portable']);
  assert.deepEqual(calledWorkflows({ jobs: { gate: { uses: './.github/workflows/pr-gate.yml' }, a: { uses: 'org/repo/.github/workflows/x.yml@v1' }, b: { steps: [] } } }), []);
  assert.deepEqual(workflowScripts({ jobs: {} }, [{ jobs: { a: { steps: [{ run: 'node scripts/called.mjs' }] } } }]), ['scripts/called.mjs']);
  // A portable caller filtered on the shared trees, as hmc-native was before it listed its own closure.
  const sharedTrees = ['packages/hmc/**', 'packages/**', 'scripts/**', 'test-utils/**'];
  // The packager's Python imports scripts/lib/windows_signing.py; the closure follows only JS and TS.
  for (const path of ['scripts/lib/windows_signing.py', 'scripts/windows-signing.ps1', 'test-utils/fixture.sh']) {
    const decision = await decideReal('hmc-native', [path], new Map(), sharedTrees);
    assert.equal(decision.run, true, path);
    assert.match(decision.reason, /cannot follow/);
  }
  // Its release tests read every package's release specification.
  const spec = await decideReal('hmc-native', ['packages/topofit/release.json'], new Map(), sharedTrees);
  assert.equal(spec.run, true);
  assert.match(spec.reason, /shared packager/);
  // A workflow that does not call the packager has no use for another package's specification.
  assert.equal(decide(['packages/noddi/**', 'packages/**'], ['packages/topofit/release.json']).run, false);
});

test('the planner reads the whole diff, not only the paths the filters matched', async () => {
  // NeuroFlow does not filter on apps/topofit, but Pipeline Builder generates
  // tools from every app's automation contract.
  const path = 'registry/apps.yml';
  const before = readFileSync(join(repoRoot, path), 'utf8');
  const after = YAML.parse(before);
  after.apps.find((app) => app.id === 'topofit').description += ' Reworded.';
  const manifests = new Map([[path, { before, after: YAML.stringify(after) }]]);
  const filters = [...(await real('neuroflow')).on.pull_request.paths, ...NEUROFLOW_BUILDS_ON];
  assert.equal((await decideReal('neuroflow', [path], manifests, filters)).run, false);
  const decision = await decideReal('neuroflow', ['apps/topofit/automation.json', path], manifests, filters);
  assert.equal(decision.run, true);
  assert.match(decision.reason, /app planner selects pipeline-builder/);
});

test('a dependency manifest that only gains exports does not run its importers', () => {
  const paths = ['packages/noddi/**', 'packages/components/package.json'];
  const manifest = 'packages/components/package.json';
  assert.ok(commandLineClosure(repoRoot, 'packages/noddi').includes(manifest));
  const before = JSON.parse(readFileSync(join(repoRoot, manifest), 'utf8'));
  const text = (edit) => {
    const after = structuredClone(before);
    edit(after);
    return new Map([[manifest, { before: JSON.stringify(before), after: JSON.stringify(after) }]]);
  };
  assert.equal(decide(paths, [manifest], text((after) => { after.exports['./file-io/a-new-reader'] = './src/file-io/a-new-reader.js'; })).run, false);
  const [existing] = Object.keys(before.exports);
  assert.equal(decide(paths, [manifest], text((after) => { after.exports[existing] = './src/elsewhere.js'; })).run, true);
  assert.equal(decide(paths, [manifest], text((after) => { delete after.exports[existing]; })).run, true);
  assert.equal(decide(paths, [manifest], text((after) => { after.dependencies = { ...after.dependencies, added: '1.0.0' }; })).run, true);
  // A version bump is release bookkeeping, which no workflow tests.
  assert.equal(decide(paths, [manifest], text((after) => { after.version = '9.9.20991231'; })).run, false);
  assert.equal(decide(paths, [manifest], text((after) => { after.version = '9.9.20991231'; after.dependencies = { ...after.dependencies, added: '1.0.0' }; })).run, true);
  // Without both texts the change is an ordinary code change.
  assert.equal(decide(paths, [manifest]).run, true);
});

test('added exports are harmless only when no pattern entry can be shadowed', () => {
  const pair = (before, after) => ({ before: JSON.stringify(before), after: JSON.stringify(after) });
  assert.equal(onlyAddsExports(pair({ exports: { './a': './a.js' } }, { exports: { './a': './a.js', './b': './b.js' } })), true);
  assert.equal(onlyAddsExports(pair({ exports: { './x/*': './x/*.js' } }, { exports: { './x/*': './x/*.js', './x/b': './b.js' } })), false);
  assert.equal(onlyAddsExports(pair({ exports: './a.js' }, { exports: { '.': './a.js' } })), false);
  assert.equal(onlyAddsExports(pair({ main: './a.js' }, { main: './a.js', exports: { '.': './a.js' } })), false);
  assert.equal(onlyAddsExports({ before: '{', after: '{}' }), false);
});

test('a lockfile change runs a workflow whose owned package resolves differently', () => {
  const paths = ['packages/node-drivers/**', 'pnpm-lock.yaml'];
  const lockfile = (before, after) => new Map([['pnpm-lock.yaml', { before, after }]]);
  const moved = decide(paths, ['pnpm-lock.yaml'], lockfile(lock('1.0.0'), lock('2.0.0')));
  assert.equal(moved.run, true);
  assert.match(moved.reason, /packages\/node-drivers/);
  // Another importer changed: a new app added its own dependencies.
  const other = JSON.parse(lock('1.0.0'));
  other.importers['apps/new-app'] = { dependencies: { left: dep('1.0.0') } };
  assert.equal(decide(paths, ['pnpm-lock.yaml'], lockfile(lock('1.0.0'), JSON.stringify(other))).run, false);
  // The root importer resolves for every workspace member.
  const root = JSON.parse(lock('1.0.0'));
  root.importers['.'] = { dependencies: { left: dep('1.0.0') } };
  assert.equal(decide(paths, ['pnpm-lock.yaml'], lockfile(lock('1.0.0'), JSON.stringify(root))).run, true);
  // A section the analysis cannot scope, and a missing text.
  const settings = JSON.parse(lock('1.0.0'));
  settings.settings.autoInstallPeers = false;
  assert.equal(decide(paths, ['pnpm-lock.yaml'], lockfile(lock('1.0.0'), JSON.stringify(settings))).run, true);
  assert.equal(decide(paths, ['pnpm-lock.yaml']).run, true);
});

test('a shared change runs the workflow when the app planner selects an app it builds', () => {
  const paths = ['packages/elastix/**', 'apps/elastix/**', 'registry/**', 'pnpm-lock.yaml'];
  assert.deepEqual(workflowApps(paths, registry), ['elastix']);
  // The planner scopes a lockfile change to the importers it touches.
  const lockfile = (before, after) => new Map([['pnpm-lock.yaml', { before, after }]]);
  const own = JSON.parse(lock('1.0.0'));
  own.importers['apps/elastix'].dependencies.left = dep('1.0.1');
  own.packages['left@1.0.1'] = { resolution: { integrity: 'sha512-left@1.0.1' } };
  own.snapshots['left@1.0.1'] = {};
  const selected = decide(paths, ['pnpm-lock.yaml'], lockfile(lock('1.0.0'), JSON.stringify(own)));
  assert.equal(selected.run, true);
  assert.match(selected.reason, /app planner selects elastix/);
  const other = JSON.parse(lock('1.0.0'));
  other.importers['apps/new-app'] = { dependencies: { left: dep('1.0.0') } };
  assert.equal(decide(paths, ['pnpm-lock.yaml'], lockfile(lock('1.0.0'), JSON.stringify(other))).run, false);
  // A registry file the planner cannot scope selects every app.
  const fallback = decide(paths, ['registry/apps.yml']);
  assert.equal(fallback.run, true);
  assert.match(fallback.reason, /selects every app/);
});

test('the shared packages are never a workflow\'s own', () => {
  assert.deepEqual(ownedPackages(['packages/components/**', 'packages/runtime-support/**', 'packages/elastix/**', 'packages/missing/**'], repoRoot), ['packages/elastix']);
});

// A whole app, package or exes directory under a push filter receives every
// release's version bump and changelog.
const RELEASED_TREE = /^(?:apps|packages|exes)\/[^/*]+\/\*\*$/;

const workflowFiles = async () => (await readdir(new URL('../.github/workflows/', import.meta.url))).filter((name) => name.endsWith('.yml')).sort();
const parsed = async (file) => YAML.parse(await readFile(new URL(`../.github/workflows/${file}`, import.meta.url), 'utf8'));

test('every workflow with shared paths, or a released tree under its push filter, waits for the gate', async () => {
  let gated = 0;
  let released = 0;
  for (const file of await workflowFiles()) {
    // native.yml is the one workflow every shared path starts.
    if (file === `${DISPATCHER}.yml`) continue;
    const flow = await parsed(file);
    // A shared filter on pull requests would start the workflow for every change to the tree.
    assert.deepEqual((flow.on?.pull_request?.paths ?? []).filter(isSharedFilter), [], `${file}: shared paths belong in the gate's shared_paths`);
    const shared = dispatched(flow);
    const releases = (flow.on?.push?.paths ?? []).some((filter) => RELEASED_TREE.test(filter));
    if (!shared && !releases) {
      assert.ok(!flow.jobs.gate, `${file} has nothing for the gate to decide`);
      continue;
    }
    gated++;
    if (!shared) released++;
    if (shared) {
      const filters = pullRequestFilters(flow);
      assert.deepEqual(sharedPaths(flow).filter((filter) => !isSharedFilter(filter)), [], `${file}: shared_paths lists only shared filters`);
      // With nothing to follow, the gate would skip every shared change.
      assert.ok(ownedPackages(filters, repoRoot).length || workflowApps(filters, registry).length || workflowScripts(flow).length, `${file}: the gate can follow an owned package, an app or a script`);
      assert.ok(Object.hasOwn(flow.on, 'workflow_call'), `${file}: native.yml calls it`);
    }
    // Without ready_for_review, a draft's skipped run would never be followed by one.
    if (flow.on?.pull_request) assert.ok(flow.on.pull_request.types?.includes('ready_for_review'), `${file}: a pull request marked ready starts it`);
    assert.equal(flow.jobs.gate?.uses, './.github/workflows/pr-gate.yml', `${file} calls the gate`);
    assert.deepEqual(flow.jobs.gate.permissions, { contents: 'read', actions: 'read', 'pull-requests': 'read' }, `${file}: the sweep and pushes read this workflow's runs, pull requests their labels`);
    for (const [id, job] of Object.entries(flow.jobs)) {
      if (id === 'gate' || job.needs) continue;
      // An entry job that does not wait is one no pull request starts.
      assert.match(String(job.if), /^github\.event_name == 'workflow_dispatch' && /, `${file}: entry job ${id} waits for the gate`);
    }
  }
  assert.ok(gated > 40);
  assert.ok(released > 10);
});

// Every workflow native.yml calls, each with its parsed file.
const nativeCalls = await dispatchedWorkflows(repoRoot);

test('native.yml calls every workflow with shared paths, granting what its jobs ask for', async () => {
  assert.ok(nativeCalls.length > 25);
  const expectedShards = renderNativeWorkflows(nativeCalls);
  const shardGroups = new Map(shardWorkflows(nativeCalls));
  const diskDispatchers = (await workflowFiles()).map((file) => file.slice(0, -'.yml'.length)).filter(isDispatcher).sort();
  assert.deepEqual(diskDispatchers, [...expectedShards.keys()].sort(), 'dispatcher shards on disk must match renderNativeWorkflows: run node scripts/native-workflow.mjs');

  for (const [shardName, expectedText] of expectedShards) {
    const text = await readFile(new URL(`../.github/workflows/${shardName}.yml`, import.meta.url), 'utf8');
    assert.equal(text, expectedText, `${shardName}.yml is out of date: run node scripts/native-workflow.mjs`);
    const native = YAML.parse(text);
    const shardCalls = shardGroups.get(shardName);
    assert.deepEqual(Object.keys(native.on), ['pull_request', 'schedule']);
    assert.equal(native.on.schedule.length, 1);
    // The gate may name in its skip list only the workflows this dispatcher shard lists here.
    const lists = { calls: shardCalls.map(([name]) => name).join(' '), sweeps: shardCalls.filter(([, flow]) => swept(flow)).map(([name]) => name).join(' ') };
    assert.deepEqual(native.jobs.gate, { if: NOT_DRAFT_CONDITION, uses: './.github/workflows/pr-gate.yml', permissions: { contents: 'read', actions: 'read', 'pull-requests': 'read' }, with: { workflow: shardName, ...lists } });
    // A pull request that changes any workflow's shared path starts its dispatcher shard.
    const starts = native.on.pull_request.paths.map(pathGlob);
    for (const [name, flow] of shardCalls) {
      for (const filter of sharedPaths(flow)) assert.ok(starts.some((glob) => glob.test(filter.replace(/\*\*$/, 'any/file.js'))), `${name}: ${filter} starts ${shardName}.yml`);
      // The dispatcher tells whether GitHub started the workflow itself by matching these filters, without exclusions.
      assert.deepEqual(pullRequestFilters(flow).filter((filter) => filter.startsWith('!')), [], `${name} excludes no path`);
      const call = native.jobs[name];
      assert.equal(call.uses, `./.github/workflows/${name}.yml`);
      assert.equal(call.needs, 'gate');
      // Running is the default; the gate must prove a skip (test/native-decision.test.mjs).
      assert.equal(call.if, callCondition(name, { sweep: swept(flow) }));
      assert.equal(call.secrets, 'inherit');
      assert.deepEqual(call.permissions, callerPermissions(flow));
      // A called workflow reads the dispatcher's name in github.workflow, so its concurrency group names itself.
      assert.ok(String(flow.concurrency?.group).startsWith(`${name}-`), `${name}: its concurrency group is its own`);
      assert.doesNotMatch(JSON.stringify(flow), /github\.workflow\b(?!_)/, `${name} would read ${shardName} in github.workflow`);
    }
    // Each call's condition is test/native-decision.test.mjs's; full-plan-withheld fails a withheld run.
    assert.deepEqual(Object.keys(native.jobs).sort(), ['full-plan-withheld', 'gate', ...shardCalls.map(([name]) => name)].sort());
  }
  assert.deepEqual(callerPermissions({ permissions: { contents: 'read' }, jobs: { a: { permissions: { contents: 'write', 'id-token': 'write' } }, b: { permissions: { actions: 'read', contents: 'read' } }, c: {} } }), { actions: 'read', contents: 'write', 'id-token': 'write' });
  assert.throws(() => callerPermissions({ permissions: 'write-all', jobs: {} }), /not a map/);

  // Sharding splits workflows beyond MAX_CALLS_PER_DISPATCHER cleanly into native and native-2.
  const synthetic = Array.from({ length: MAX_CALLS_PER_DISPATCHER + 5 }, (_, i) => [
    `tool-${String(i).padStart(2, '0')}-native`,
    { on: { push: { paths: [`packages/tool-${i}/**`] }, pull_request: { paths: [`packages/tool-${i}/**`] } }, permissions: { contents: 'read' }, jobs: { gate: { with: { shared_paths: 'pnpm-lock.yaml' } } } },
  ]);
  const sharded = renderNativeWorkflows(synthetic);
  assert.deepEqual([...sharded.keys()], ['native', 'native-2']);
  const shard1 = YAML.parse(sharded.get('native'));
  const shard2 = YAML.parse(sharded.get('native-2'));
  assert.equal(shard1.jobs.gate.with.workflow, 'native');
  assert.equal(shard2.jobs.gate.with.workflow, 'native-2');
  assert.equal(shard1.on.schedule[0].cron, '5 13 * * *');
  assert.equal(shard2.on.schedule[0].cron, '10 13 * * *');
  assert.equal(Object.keys(shard1.jobs).length, MAX_CALLS_PER_DISPATCHER + 2);
  assert.equal(Object.keys(shard2.jobs).length, 5 + 2);
});

// What GitHub and the gate did when a workflow filtered pull requests on its
// shared paths too: GitHub started it when any changed path matched a
// filter, and its gate decided.
const before = (name, flow, changedPaths, calledFlows) => {
  const filters = pullRequestFilters(flow);
  const old = { ...flow, on: { ...flow.on, pull_request: { ...flow.on.pull_request, paths: filters } }, jobs: { ...flow.jobs, gate: { ...flow.jobs.gate, with: { workflow: name } } } };
  if (!changedPaths.some((path) => filters.some((filter) => pathGlob(filter).test(path)))) return false;
  return decideWorkflow({ flow: old, calledFlows, changedPaths, registry, graph, root: repoRoot }).run;
};
// A file the filter matches: a tracked one where there is one.
const tracked = execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' }).split('\n');
const sample = (filter) => tracked.find((path) => pathGlob(filter).test(path)) ?? filter.replace('**', 'src/new.js').replaceAll('*', 'new');

test('each pull request runs a workflow exactly as before, and twice only where its own start is not certain', async () => {
  let cases = 0;
  let runs = 0;
  let twice = 0;
  for (const [name, flow] of nativeCalls) {
    const calledFlows = await Promise.all(calledWorkflows(flow).map(real));
    const own = flow.on.pull_request.paths.map(sample);
    const shared = sharedPaths(flow).map(sample);
    const diffs = [[own[0]], ...shared.map((path) => [path]), [own.at(-1), shared[0]], shared, [shared[0], 'docs/readme.md'], ['docs/readme.md']];
    for (const changedPaths of diffs) {
      const ownRun = changedPaths.some((path) => flow.on.pull_request.paths.some((filter) => pathGlob(filter).test(path)));
      const gate = ownRun && decideWorkflow({ flow, calledFlows, changedPaths, registry, graph, root: repoRoot }).run;
      const native = dispatchDecision({ flow, calledFlows, changedPaths, registry, graph, root: repoRoot }).run;
      // A lost run is a hidden regression; a second run only costs one.
      assert.equal(gate || native, before(name, flow, changedPaths, calledFlows), `${name}: ${changedPaths}`);
      assert.ok(!(certainOwnStart(flow, { paths: changedPaths }) && native), `${name} would run twice although GitHub started it for ${changedPaths}`);
      cases++;
      if (gate || native) runs++;
      if (gate && native) twice++;
    }
  }
  assert.ok(cases > 150 && runs > 30 && runs < cases, `${runs} of ${cases}`);
  // Only the samples a dotfile or a rename makes uncertain run twice.
  assert.ok(twice < cases / 20, `${twice} of ${cases} run twice`);
});

test('native.yml leaves a workflow to its own run, and decides one only its shared paths reach', () => {
  const flow = { on: { pull_request: { paths: ['packages/elastix/**'] } }, jobs: { gate: { with: { workflow: 'x', shared_paths: 'packages/components/**\npnpm-lock.yaml\n' } } } };
  const dispatch = (changedPaths) => dispatchDecision({ flow, changedPaths, registry, graph, root: repoRoot });
  assert.deepEqual(sharedPaths(flow), ['packages/components/**', 'pnpm-lock.yaml']);
  assert.deepEqual(pullRequestFilters(flow), ['packages/elastix/**', 'packages/components/**', 'pnpm-lock.yaml']);
  assert.match(dispatch(['packages/elastix/src/index.js', 'packages/components/src/ui/theme.js']).reason, /^starts itself: packages\/elastix\/src\/index\.js matches its own filter packages\/elastix\/\*\*, and its own pull request run decides$/);
  assert.deepEqual(dispatch(['docs/readme.md']), { run: false, reason: 'none of its shared paths changed' });
  assert.equal(dispatch(['packages/components/src/ui/theme.js']).run, false, 'elastix does not load the theme');
  assert.match(dispatch(['packages/components/src/file-io/NiftiUtils.js']).reason, /a script in packages\/elastix loads packages\/components\/src\/file-io\/NiftiUtils\.js/);
  // Past GitHub's 3,000 files it cannot tell whether GitHub started the workflow, so it decides too.
  const many = ['packages/elastix/src/index.js', ...Array.from({ length: 3000 }, (_, index) => `docs/${index}.md`), 'packages/components/src/file-io/NiftiUtils.js'];
  assert.equal(dispatch(many).run, true);
  assert.equal(dispatched(flow), true);
  assert.equal(swept(flow), false, 'no push trigger: nothing on main to sweep');
  assert.equal(swept({ ...flow, on: { ...flow.on, push: { paths: ['packages/elastix/**'] } } }), true);
  assert.equal(dispatched({ on: flow.on, jobs: { gate: { with: { workflow: 'x' } } } }), false);
});

test('a scheduled native.yml run counts for a workflow it called when that workflow\'s part was green', () => {
  const run = (id, conclusion, head_sha = `sha${id}`) => ({ id, conclusion, head_sha, head_branch: 'main', event: 'schedule', run_attempt: 1 });
  const listed = new Map([
    [2, [{ name: 'gate / decide', conclusion: 'success' }, { name: 'bison-native', conclusion: 'skipped' }, { name: 'hmc-native / test', conclusion: 'failure' }]],
    [3, [{ name: 'gate / decide', conclusion: 'success' }, { name: 'bison-native / web-app-reference', conclusion: 'success' }, { name: 'bison-native / portable / linux-x64', conclusion: 'skipped' }, { name: 'bison-native-extra / test', conclusion: 'failure' }]],
    [4, [{ name: 'gate / decide', conclusion: 'success' }, { name: 'bison-native / web-app-reference', conclusion: 'cancelled' }]],
    [5, [{ name: 'gate / decide', conclusion: 'failure' }, { name: 'bison-native', conclusion: 'skipped' }]],
  ]);
  const runs = [run(1, 'success'), run(2, 'failure'), run(3, 'failure'), run(4, 'cancelled'), run(5, 'failure'), run(6, 'failure'), run(7, 'success')];
  const read = (workflow) => dispatchedRuns(workflow, runs, { calls: (each) => each.id !== 7, jobs: (each) => listed.get(each.id) ?? null });
  assert.deepEqual(read('bison-native').map(({ id, conclusion, event }) => `${id} ${conclusion} ${event}`), [
    '1 success schedule',
    // A skipped call is a sweep that found nothing to test.
    '2 success schedule',
    '3 success schedule',
    '4 failure schedule',
    // The gate failed, or the jobs are unknown: nothing was tested.
    '5 failure schedule',
    '6 failure schedule',
  ]);
  assert.deepEqual(read('hmc-native').map(({ id, conclusion }) => `${id} ${conclusion}`), ['1 success', '2 failure', '3 failure', '4 failure', '5 failure', '6 failure'], 'a run without the workflow\'s jobs did not test it');
});

// GitHub: "You can call a maximum of 50 unique reusable workflows from a
// single workflow file. This limit includes any trees of nested reusable
// workflows", and up to ten levels of workflows connect.
test('no workflow calls more than 50 unique reusable workflows or nests more than ten levels', async () => {
  const flows = new Map(await Promise.all((await workflowFiles()).map(async (file) => [file.slice(0, -'.yml'.length), await parsed(file)])));
  const tree = (name, depth = 1, seen = new Set()) => {
    let deepest = depth;
    for (const called of calledWorkflows(flows.get(name)).concat(Object.values(flows.get(name).jobs).some((job) => job.uses === './.github/workflows/pr-gate.yml') ? ['pr-gate'] : [])) {
      seen.add(called);
      deepest = Math.max(deepest, tree(called, depth + 1, seen).depth);
    }
    return { seen, depth: deepest };
  };
  for (const name of flows.keys()) {
    const { seen, depth } = tree(name);
    assert.ok(seen.size <= 50, `${name} reaches ${seen.size} reusable workflows; split native.yml before it reaches GitHub's limit of 50`);
    assert.ok(depth <= 10, `${name} nests ${depth} levels`);
  }
  for (const [shardName, shardCalls] of shardWorkflows(nativeCalls)) {
    const { seen } = tree(shardName);
    assert.ok(seen.size >= shardCalls.length + 1 && seen.size <= shardCalls.length + 2, `${shardName} reaches ${seen.size} reusable workflows for ${shardCalls.length} calls`);
  }
});

// native.yml runs the workflows it calls in one workflow run, where an
// artifact name must be unique (node-cli-portable names its own after the
// package; test/independent-workflows.test.mjs).
test('the workflows native.yml calls upload artifacts under names no other one uses', async () => {
  const steps = (flow, action) => Object.values(flow.jobs).flatMap((job) => job.steps ?? []).filter((step) => step.uses?.startsWith(`actions/${action}-artifact@`));
  const owners = new Map();
  for (const [name, flow] of nativeCalls) {
    for (const { with: { name: artifact } } of steps(flow, 'upload')) {
      assert.ok(artifact && (!owners.has(artifact) || owners.get(artifact) === name), `${name} and ${owners.get(artifact)} both upload ${artifact}`);
      owners.set(artifact, name);
    }
  }
  for (const [name, flow] of nativeCalls) {
    for (const step of steps(flow, 'download')) assert.equal(owners.get(step.with?.name), name, `${name} downloads only its own artifacts, by name`);
  }
  assert.ok(owners.size > 3);
});

test('a push to main starts a workflow only for its own paths, and native.yml sweeps the shared ones nightly', async () => {
  let sweeps = 0;
  for (const [name, flow] of nativeCalls) {
    // Without the sweep nothing would build every target for a shared change.
    assert.equal(flow.on.schedule, undefined, `${name}: native.yml's nightly run is its sweep`);
    if (!flow.on.push) {
      assert.equal(swept(flow), false, `${name} never runs on main, so nothing is swept`);
      continue;
    }
    sweeps++;
    assert.equal(swept(flow), true);
    const pushes = flow.on.push.paths;
    // A shared filter on push starts every native suite for every merge.
    assert.deepEqual(pushes.filter(isSharedFilter), [], `${name}: pushes filter on no shared path`);
    assert.deepEqual(flow.on.pull_request.paths.filter((filter) => !pushes.includes(filter)), [], `${name}: a push covers each of the workflow's own paths`);
    assert.match(String(flow.concurrency['cancel-in-progress']), /github\.event_name == 'pull_request'/, `${name}: a push must not cancel a running sweep`);
  }
  assert.ok(sweeps > 20);
  for (const [shardName] of shardWorkflows(nativeCalls)) {
    const native = await parsed(`${shardName}.yml`);
    assert.equal(native.concurrency['cancel-in-progress'], "${{ github.event_name == 'pull_request' }}", 'a newer pull request run replaces the last; a sweep is never cancelled');
  }
  // A gated workflow without shared paths keeps its own schedule: a plain nightly run, not a sweep.
  for (const file of await workflowFiles()) {
    const flow = await parsed(file);
    if (flow.on?.schedule && flow.jobs?.gate && !isDispatcher(file.slice(0, -'.yml'.length))) assert.equal(dispatched(flow), false, file);
  }
});

test('the sweep runs a workflow when a shared path changed, whether or not the change reaches it', () => {
  const flow = flowOf(['packages/elastix/**', 'packages/components/**', 'pnpm-lock.yaml']);
  const sweep = (changedPaths) => sweepWorkflow({ flow, changedPaths });
  assert.equal(sweep(['packages/components/src/ui/theme.js']).run, true);
  assert.match(sweep(['docs/readme.md', 'pnpm-lock.yaml']).reason, /^pnpm-lock\.yaml changed on main and matches pnpm-lock\.yaml/);
  // A push already ran the workflow for its own paths.
  assert.equal(sweep(['packages/elastix/src/index.js']).run, false);
  assert.equal(sweep([]).run, false);
  assert.equal(sweepWorkflow({ flow: { on: {} }, changedPaths: [] }).run, true);
});

test('the sweep leaves release bookkeeping aside: changelogs, version bumps and other apps\' downloads', async () => {
  const manifest = (fields) => JSON.stringify({ name: '@neurodesk/webapp-components', version: '0.26.0', exports: { './ui': './src/ui/index.js' }, ...fields });
  const bump = { before: manifest({}), after: manifest({ version: '0.27.0' }) };
  assert.equal(onlyBumpsVersion(bump), true);
  assert.equal(onlyBumpsVersion({ before: manifest({}), after: manifest({}) }), false);
  assert.equal(onlyBumpsVersion({ before: manifest({}), after: manifest({ version: '0.27.0', dependencies: { left: '1.0.0' } }) }), false);
  assert.equal(onlyBumpsVersion({ before: manifest({}), after: 'not json' }), false);

  const flow = flowOf(['packages/elastix/**', 'apps/elastix/**', 'packages/components/**', 'registry/**']);
  const release = ['packages/components/CHANGELOG.md', 'packages/components/package.json'];
  const sweep = (changedPaths, manifests) => sweepWorkflow({ flow, changedPaths, manifests, registry });
  const released = sweep(release, new Map([['packages/components/package.json', bump]]));
  assert.equal(released.run, false);
  assert.match(released.reason, /2 release bookkeeping files aside/);
  // Code that merged beside the release still runs the workflow.
  assert.equal(sweep([...release, 'packages/components/src/ui/theme.js'], new Map([['packages/components/package.json', bump]])).run, true);
  // A dependency changed with the version, or the manifest texts are unknown.
  const dependency = { before: manifest({}), after: manifest({ version: '0.27.0', dependencies: { left: '1.0.0' } }) };
  assert.equal(sweep(release, new Map([['packages/components/package.json', dependency]])).run, true);
  assert.equal(sweep(release, new Map()).run, true);

  const text = await readFile(new URL('../registry/standalone.json', import.meta.url), 'utf8');
  const other = registry.apps.map((app) => app.id).find((id) => id !== 'elastix');
  const downloads = (id) => {
    const catalog = JSON.parse(text);
    catalog.apps[id].profile = catalog.apps[id].profile === 'batch' ? 'interactive' : 'batch';
    return new Map([['registry/standalone.json', { before: text, after: JSON.stringify(catalog) }]]);
  };
  const standalone = (manifests) => sweepWorkflow({ flow, changedPaths: ['registry/standalone.json'], manifests, registry });
  assert.equal(standalone(downloads(other)).run, false);
  assert.equal(standalone(downloads('elastix')).run, true);
  // An invalid catalog, or one without its texts, stays a shared change.
  assert.equal(standalone(new Map([['registry/standalone.json', { before: '{', after: '{' }]])).run, true);
  assert.equal(standalone(new Map()).run, true);
  // A workflow that builds no registry app cannot be matched to an entry.
  assert.equal(sweepWorkflow({ flow: flowOf(['packages/node-drivers/**', 'registry/**']), changedPaths: ['registry/standalone.json'], manifests: downloads(other), registry }).run, true);
});

test('the sweep starts from the last merge or sweep that finished green, however long ago', () => {
  // main: a - b - c - head, oldest first.
  const order = ['a', 'b', 'c', 'head'];
  const git = { isAncestor: (a, b) => order.indexOf(a) >= 0 && order.indexOf(a) <= order.indexOf(b), distance: (a, b) => order.indexOf(b) - order.indexOf(a) };
  const green = (head_sha, event, id) => ({ id, head_sha, event, conclusion: 'success', head_branch: 'main' });
  const sweepBase = (runs) => testedBase({ runs, head: 'head', branch: 'main', git, workflow: 'hmc-native', atHead: true, events: new Set(['push', 'schedule']) });
  // Two sweeps were dropped after the one at a: everything since a is still unswept.
  assert.equal(sweepBase([green('a', 'schedule', 1)]).base, 'a');
  // A merge of the workflow's own paths tested the tree as it was then.
  assert.equal(sweepBase([green('a', 'schedule', 1), green('c', 'push', 2)]).base, 'c');
  // A failed sweep and a dispatch, which may run part of the workflow, move nothing.
  assert.equal(sweepBase([green('a', 'schedule', 1), { ...green('b', 'schedule', 2), conclusion: 'failure' }, green('c', 'workflow_dispatch', 3)]).base, 'a');
  // Nothing merged since the last green run.
  assert.equal(sweepBase([green('head', 'push', 4)]).base, 'head');
  // No green run at all: the caller runs the workflow.
  assert.equal(sweepBase([]).base, null);
  assert.match(sweepBase([]).reason, /no successful hmc-native run on main/);
});

test('the gate answers drafts, dispatches and calls from native.yml without a checkout, and decides ready pull requests, pushes and sweeps', async () => {
  const flow = YAML.parse(await readFile(new URL('../.github/workflows/pr-gate.yml', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(flow.on), ['workflow_call']);
  // The sweep and pushes read the caller's runs and a pull request its labels; a caller cannot be granted more than its gate job passes on.
  assert.deepEqual(flow.permissions, { contents: 'read', actions: 'read', 'pull-requests': 'read' });
  const job = flow.jobs.decide;
  assert.equal(job.if, undefined, 'a skipped gate would skip every job after the entry jobs');
  assert.equal(job.outputs.run, '${{ steps.event.outputs.run || steps.decide.outputs.run }}');
  // native.yml reads the workflows the gate skips; there is no list of workflows to run.
  assert.equal(job.outputs.skips, '${{ steps.event.outputs.skips || steps.decide.outputs.skips }}');
  assert.equal(flow.on.workflow_call.outputs.skips.value, '${{ jobs.decide.outputs.skips }}');
  assert.equal(job.outputs.workflows, undefined);
  assert.equal(flow.on.workflow_call.outputs.workflows, undefined);
  assert.equal(flow.on.workflow_call.inputs.shared_paths.default, '');
  const [event, ...rest] = job.steps;
  assert.equal(event.id, 'event');
  for (const step of rest) assert.equal(step.if, "steps.event.outputs.run == ''", step.name ?? step.uses);
  const checkout = rest.find((step) => step.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with['fetch-depth'], 0);
  assert.equal(checkout.with['persist-credentials'], false);
  for (const step of rest) if (step.uses) assert.match(step.uses, /^[\w-]+\/[\w-]+@[0-9a-f]{40}$/);
  const decideStep = rest.find((step) => step.id === 'decide');
  assert.match(decideStep.run, /node scripts\/workflow-gate\.mjs --workflow "\$WORKFLOW" --base "\$BASE_SHA" --head "\$HEAD_SHA"/);
  assert.match(decideStep.run, /"\$EVENT_NAME" = schedule \]; then\n\s+node scripts\/workflow-gate\.mjs --workflow "\$WORKFLOW" --sweep --head "\$HEAD_SHA"/);
  assert.match(decideStep.run, /"\$EVENT_NAME" = push \]; then\n\s+node scripts\/workflow-gate\.mjs --workflow "\$WORKFLOW" --push --head "\$HEAD_SHA"/);
  assert.match(decideStep.run, /if is_dispatcher "\$WORKFLOW"; then\n\s+if \[ "\$EVENT_NAME" = schedule \]; then\n\s+eligible=\$SWEEPS\n\s+set -- --sweep\n\s+else\n\s+eligible=\$CALLS\n\s+set -- --base "\$BASE_SHA"\n\s+fi/);
  assert.match(decideStep.run, /NATIVE_ELIGIBLE="\$eligible" NATIVE_SKIPS="\$answer" node scripts\/workflow-gate\.mjs --native --workflow "\$WORKFLOW" "\$@" --head "\$HEAD_SHA" \|\| status=\$\?/);
  assert.equal(job.outputs.withheld, '${{ steps.decide.outputs.withheld }}');
  assert.equal(flow.on.workflow_call.outputs.withheld.value, '${{ jobs.decide.outputs.withheld }}');
  assert.equal(event.env.TOP_WORKFLOW, '${{ github.workflow_ref }}');
  assert.equal(decideStep.env.GITHUB_TOKEN, '${{ github.token }}');
  assert.equal(decideStep.env.HEAD_SHA, '${{ github.event.pull_request.head.sha || github.sha }}');
  assert.equal(decideStep.env.WORKFLOW, '${{ inputs.workflow }}');

  const answer = (EVENT_NAME, DRAFT, WORKFLOW = 'bison-native', TOP_WORKFLOW = `neurodesk/webapps/.github/workflows/${WORKFLOW}.yml@refs/pull/1/merge`) => {
    const output = join(mkdtempSync(join(tmpdir(), 'pr-gate-')), 'output');
    execFileSync('bash', ['-e', '-c', event.run], { env: { ...process.env, EVENT_NAME, DRAFT, WORKFLOW, TOP_WORKFLOW, GITHUB_OUTPUT: output } });
    return readFileSync(output, { encoding: 'utf8', flag: 'a+' }).trim();
  };
  assert.equal(answer('workflow_dispatch', ''), 'run=true');
  for (const name of ['push', 'schedule']) assert.equal(answer(name, ''), '', name);
  assert.equal(answer('pull_request', 'true'), 'run=false');
  assert.equal(answer('pull_request', 'false'), '');
  // native.yml (and native-2.yml when sharded) decides before it calls a workflow, so that workflow's own gate answers at once.
  for (const dispatcher of ['native', 'native-2']) {
    const called = `neurodesk/webapps/.github/workflows/${dispatcher}.yml@refs/pull/1/merge`;
    for (const name of ['pull_request', 'schedule']) assert.equal(answer(name, 'false', 'bison-native', called), 'run=true', `${dispatcher}/${name}`);
    // A draft skips every workflow the dispatcher lists, by name (test/native-decision.test.mjs).
    assert.equal(answer('pull_request', 'true', dispatcher, called), 'run=false\nskips=[]');
    for (const name of ['pull_request', 'schedule']) assert.equal(answer(name, 'false', dispatcher, called), '', `${dispatcher}/${name}`);
  }
  for (const rejected of ['not-native', 'native-0', 'native-1']) {
    assert.equal(answer('pull_request', 'false', 'bison-native', `neurodesk/webapps/.github/workflows/${rejected}.yml@refs/pull/1/merge`), '', rejected);
  }
});

// What a release leaves in a workflow's own package and app: version-only manifests and changelogs.
const versionBump = (path) => {
  const before = readFileSync(join(repoRoot, path), 'utf8');
  return [path, { before, after: JSON.stringify({ ...JSON.parse(before), version: '9.9.20991231' }, null, 2) }];
};
const elastixRelease = new Map([versionBump('packages/elastix/package.json'), versionBump('apps/elastix/package.json')]);
const elastixReleasePaths = ['packages/elastix/package.json', 'packages/elastix/CHANGELOG.md', 'apps/elastix/package.json', 'apps/elastix/CHANGELOG.md', '.changeset/elastix-fix.md'];

test('a pull request that only releases runs no gated workflow, even for its own package', async () => {
  const released = await decideReal('elastix-native', elastixReleasePaths, elastixRelease);
  assert.deepEqual(released, { run: false, reason: 'only release bookkeeping (changelogs and version bumps) matches its filters' });
  assert.equal((await decideReal('elastix-native', [...elastixReleasePaths, 'packages/elastix/src/presets.js'], elastixRelease)).run, true);
  // Without the manifest texts a manifest change is code.
  assert.equal((await decideReal('elastix-native', elastixReleasePaths)).run, true);
});

test('a gated workflow\'s own paths on main ask only whether more than release bookkeeping changed', async () => {
  const flow = await real('elastix-native');
  const push = (changedPaths, manifests = elastixRelease) => pushWorkflow({ flow, changedPaths, manifests, registry });
  assert.equal(push(elastixReleasePaths).run, false);
  assert.match(push(elastixReleasePaths).reason, /^only release bookkeeping changed under its push filters \(packages\/elastix\/package\.json/);
  // Shared paths outside the push filters are mainWorkflow's second question, not this one.
  assert.equal(push([...elastixReleasePaths, 'packages/components/src/ui.js']).run, false);
  assert.deepEqual(push([...elastixReleasePaths, 'apps/elastix/src/main.js']), { run: true, known: true, reason: 'apps/elastix/src/main.js matches apps/elastix/**' });
  assert.equal(push(elastixReleasePaths, new Map()).run, true, 'a manifest without its texts is code');
  assert.equal(push(['docs/readme.md']).run, true, 'a range that matches no push filter is not what started the run');
  assert.equal(pushWorkflow({ flow: { on: { push: {} } }, changedPaths: ['a'], registry }).run, true);
  assert.equal(pushWorkflow({ flow: { on: { push: { paths: ['apps/**', '!apps/x/**'] } } }, changedPaths: ['apps/y/CHANGELOG.md'], registry }).run, true);
});

// A push and the sweep both diff from the last green push or sweep, and a
// skipped run is green, so each must also ask the other's question.
test('a skipped push or sweep never moves the base past a change the other would test', async () => {
  const flow = await real('elastix-native');
  const onMain = (event, changedPaths, manifests = elastixRelease) => mainWorkflow({ flow, changedPaths, manifests, registry, event });
  const tiff = 'packages/components/src/file-io/tiff.js';
  // A shared change merged before a release: the release push must run, or the sweep would start after it.
  assert.deepEqual(onMain('push', [tiff, ...elastixReleasePaths]).run, true);
  assert.match(onMain('push', [tiff, ...elastixReleasePaths]).reason, /tiff\.js changed on main/);
  assert.equal(onMain('push', elastixReleasePaths).run, false);
  // An own change whose push run failed or was cancelled: the sweep runs, or a later release push would skip past it.
  assert.deepEqual(onMain('schedule', ['apps/elastix/src/main.js']), { run: true, reason: 'apps/elastix/src/main.js matches apps/elastix/**' });
  assert.equal(onMain('schedule', elastixReleasePaths).run, false);
  assert.equal(onMain('schedule', []).run, false, 'nothing changed since the last green run');
  assert.equal(onMain('schedule', ['docs/readme.md']).run, false);
  assert.equal(onMain('push', ['docs/readme.md']).run, true);
  // A workflow without a shared pull request filter keeps a plain nightly run; its pushes still skip release bookkeeping.
  const neuroflow = await real('neuroflow');
  assert.equal(mainWorkflow({ flow: neuroflow, changedPaths: [], registry, event: 'schedule' }).run, true);
  const appsRelease = new Map([versionBump('apps/n4/package.json')]);
  assert.equal(mainWorkflow({ flow: neuroflow, changedPaths: ['apps/n4/package.json', 'apps/n4/CHANGELOG.md'], manifests: appsRelease, registry, event: 'push' }).run, false);
  assert.equal(mainWorkflow({ flow: neuroflow, changedPaths: ['apps/n4/src/main.js'], registry, event: 'push' }).run, true);
});

test('a ready pull request over its full-plan budget skips a gated workflow only where ci withholds too', async () => {
  const shared = ['packages/components/src/styles/imaging-workspace.css'];
  const own = ['apps/elastix/src/main.js'];
  const runs = { run: true, reason: 'reaches it' };
  let asked = 0;
  const gate = (decision, changedPaths, budget) => budgetedDecision(decision, { registry, graph, changedPaths, budget: async () => { asked++; return budget(); }, log: () => {} });
  const spent = () => ({ withheld: true, reason: '#814 already started 2 full-plan ci runs in 24 hours (budget 2)' });
  const withheld = await gate(runs, shared, spent);
  assert.equal(withheld.run, false);
  assert.equal(withheld.withheld, true, 'a withheld suite fails its gate instead of reading as green');
  assert.match(withheld.reason, /^#814 already started 2 full-plan ci runs in 24 hours \(budget 2\), and its ci run withholds the full plan too; add the full-ci label/);
  assert.deepEqual(await gate(runs, shared, () => ({ withheld: false, reason: '1 of 2' })), runs);
  assert.deepEqual(await gate(runs, shared, () => { throw new Error('HTTP 403'); }), runs, 'a failed check runs the workflow');
  asked = 0;
  // Where the draft plan is the full plan, ci never withholds, so neither does the gate.
  assert.deepEqual(await gate(runs, own, spent), runs);
  const skipped = { run: false, reason: 'does not reach it' };
  assert.deepEqual(await gate(skipped, shared, spent), skipped);
  assert.equal(asked, 0);
});

test('driver consumers route packages/node-drivers through native.yml shared_paths and missing blocks fail sync', async () => {
  for (const [name, driver] of [
    ['brain-extraction-native', 'packages/node-drivers/src/mindgrab.js'],
    ['mri2vid-native', 'packages/node-drivers/src/dcm2niix.js'],
    ['niimath-native', 'packages/node-drivers/src/niimath.js'],
    ['dwi-native', 'packages/node-drivers/src/mindgrab.js'],
    ['bison-native', 'packages/node-drivers/src/niimath.js'],
  ]) {
    const flow = await real(name);
    assert.ok(!(flow.on?.push?.paths ?? []).includes(driver), `${name}: push.paths leaves shared ${driver} to native.yml nightly sweep`);
    assert.ok(!(flow.on?.pull_request?.paths ?? []).includes(driver), `${name}: pull_request.paths routes ${driver} via native.yml`);
    assert.ok(sharedPaths(flow).includes(driver), `${name}: gate shared_paths includes ${driver}`);
  }
  const otherJobFirst = `on:\n  push:\n    paths:\n      - 'packages/x/**'\njobs:\n  helper:\n    uses: ./.github/workflows/other.yml\n    with:\n      shared_paths: |\n        packages/node-drivers/package.json\n  gate:\n    with:\n      shared_paths: |\n        packages/components/**\n`;
  assert.throws(() => syncDriverPathsInSource('x.yml', otherJobFirst, ['packages/node-drivers/package.json']), /missing packages\/node-drivers\/ entries in jobs\.gate\.with\.shared_paths/);
});
