import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import YAML from 'yaml';
import { loadAppsRegistry, repoRoot } from '../scripts/lib/apps-registry.mjs';
import { commandLineClosure, moduleClosure } from '../scripts/lib/module-closure.mjs';
import { calledWorkflows, decideWorkflow, isSharedFilter, onlyAddsExports, ownedPackages, workflowApps, workflowScripts } from '../scripts/lib/workflow-gate.mjs';
import { loadConservativeWorkspaceGraph } from '../scripts/lib/workspace-graph.mjs';

// The pull request gate skips a native suite only when no changed file can
// reach it. A wrong skip hides a regression until main; a wrong run only costs
// minutes. Each case below is one way a shared change does or does not reach
// a workflow.
const registry = await loadAppsRegistry();
const graph = await loadConservativeWorkspaceGraph(repoRoot);
const flowOf = (paths) => ({ on: { pull_request: { paths } } });
const real = async (name) => YAML.parse(await readFile(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));
const decideReal = async (name, changedPaths, manifests = new Map()) => {
  const flow = await real(name);
  const calledFlows = await Promise.all(calledWorkflows(flow).map(real));
  return decideWorkflow({ flow, calledFlows, changedPaths, registry, graph, manifests, root: repoRoot });
};
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
  for (const filter of ['pnpm-lock.yaml', 'package.json', 'pnpm-workspace.yaml', 'packages/**', 'exes/**', 'scripts/**', 'test/**', 'test-utils/**', 'registry/**', 'models/**', 'packages/components/**', 'packages/components/src/file-io/**', 'packages/components/package.json', 'packages/runtime-support/src/mindgrab/**', 'packages/runtime-support/package.json']) {
    assert.equal(isSharedFilter(filter), true, filter);
  }
  for (const filter of ['packages/elastix/**', 'apps/elastix/**', 'exes/dwi/**', 'packages/components/src/file-io/NiftiUtils.js', 'packages/node-drivers/package.json', 'packages/node-drivers/src/niimath.js', 'test-utils/native-nifti/**', 'test/neuroflow*', 'models/bison.manifest.json', '.github/workflows/elastix-native.yml', 'registry/offline-assets.sources.json']) {
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
    const decision = await decideReal('neuroflow', [script]);
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
  // The packager's Python imports scripts/lib/windows_signing.py; the closure follows only JS and TS.
  for (const path of ['scripts/lib/windows_signing.py', 'scripts/windows-signing.ps1', 'test-utils/fixture.sh']) {
    const decision = await decideReal('hmc-native', [path]);
    assert.equal(decision.run, true, path);
    assert.match(decision.reason, /cannot follow/);
  }
  // Its release tests read every package's release specification.
  const spec = await decideReal('hmc-native', ['packages/topofit/release.json']);
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
  assert.equal((await decideReal('neuroflow', [path], manifests)).run, false);
  const decision = await decideReal('neuroflow', ['apps/topofit/automation.json', path], manifests);
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
  assert.equal(decide(paths, [manifest], text((after) => { after.version = '9.9.20991231'; })).run, true);
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

test('every workflow with a shared pull request filter waits for the gate', async () => {
  const files = (await readdir(new URL('../.github/workflows/', import.meta.url))).filter((name) => name.endsWith('.yml')).sort();
  let gated = 0;
  for (const file of files) {
    const flow = YAML.parse(await readFile(new URL(`../.github/workflows/${file}`, import.meta.url), 'utf8'));
    const filters = flow.on?.pull_request?.paths ?? [];
    if (!filters.some(isSharedFilter)) {
      assert.ok(!flow.jobs.gate, `${file} has no shared filter for the gate to decide`);
      continue;
    }
    gated++;
    // With nothing to follow, the gate would skip every shared change.
    assert.ok(ownedPackages(filters, repoRoot).length || workflowApps(filters, registry).length || workflowScripts(flow).length, `${file}: the gate can follow an owned package, an app or a script`);
    assert.equal(flow.jobs.gate?.uses, './.github/workflows/pr-gate.yml', `${file} filters on shared paths, so it calls the gate`);
    for (const [id, job] of Object.entries(flow.jobs)) {
      if (id === 'gate' || job.needs) continue;
      // An entry job that does not wait is one no pull request starts.
      assert.match(String(job.if), /^github\.event_name == 'workflow_dispatch' && /, `${file}: entry job ${id} waits for the gate`);
    }
  }
  assert.ok(gated > 20);
});

test('the gate answers drafts and other events without a checkout, and decides ready pull requests', async () => {
  const flow = YAML.parse(await readFile(new URL('../.github/workflows/pr-gate.yml', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(flow.on), ['workflow_call']);
  assert.deepEqual(flow.permissions, { contents: 'read' });
  const job = flow.jobs.decide;
  assert.equal(job.if, undefined, 'a skipped gate would skip every job after the entry jobs');
  assert.equal(job.outputs.run, '${{ steps.event.outputs.run || steps.decide.outputs.run }}');
  const [event, ...rest] = job.steps;
  assert.equal(event.id, 'event');
  for (const step of rest) assert.equal(step.if, "steps.event.outputs.run == ''", step.name ?? step.uses);
  const checkout = rest.find((step) => step.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with['fetch-depth'], 0);
  assert.equal(checkout.with['persist-credentials'], false);
  for (const step of rest) if (step.uses) assert.match(step.uses, /^[\w-]+\/[\w-]+@[0-9a-f]{40}$/);
  const decideStep = rest.find((step) => step.id === 'decide');
  assert.match(decideStep.run, /node scripts\/workflow-gate\.mjs --workflow "\$WORKFLOW" --base "\$BASE_SHA" --head "\$HEAD_SHA"/);
  assert.equal(decideStep.env.WORKFLOW, '${{ inputs.workflow }}');

  const answer = (EVENT_NAME, DRAFT) => {
    const output = join(mkdtempSync(join(tmpdir(), 'pr-gate-')), 'output');
    execFileSync('bash', ['-e', '-c', event.run], { env: { ...process.env, EVENT_NAME, DRAFT, GITHUB_OUTPUT: output } });
    return readFileSync(output, { encoding: 'utf8', flag: 'a+' }).trim();
  };
  for (const name of ['push', 'schedule', 'workflow_dispatch']) assert.equal(answer(name, ''), 'run=true', name);
  assert.equal(answer('pull_request', 'true'), 'run=false');
  assert.equal(answer('pull_request', 'false'), '');
});
