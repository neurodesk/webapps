import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { matchesGlob } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { parse } from 'yaml';
import { fileURLToPath } from 'node:url';
import { loadConservativeWorkspaceGraph, reachableFrom } from '../scripts/lib/workspace-graph.mjs';

const root = new URL('../', import.meta.url);
const flow = parse(await readFile(new URL('.github/workflows/neuroflow.yml', root), 'utf8'));
const matrixFor = (event, diagnostic) => runInNewContext(flow.jobs['exported-template'].strategy.matrix.slice(3, -2),
  { github: { event_name: event }, inputs: { diagnostic_models: diagnostic }, fromJSON: JSON.parse });
const template = JSON.parse(await readFile(new URL('apps/pipeline-builder/src/workflows/t1-segmentation.workflow.json', root)));
const dwi = JSON.parse(await readFile(new URL('apps/pipeline-builder/src/workflows/dwi-preprocessing.workflow.json', root)));

test('the NeuroFlow scientific run covers builder, runtime and every template application change', () => {
  const paths = flow.on.pull_request.paths;
  const required = [
    'apps/pipeline-builder/src/model.js',
    'apps/pipeline-builder/src/workflows/t1-segmentation.workflow.json',
    'packages/desktop/neuroflow/runtime/neurodesk.mjs',
    'scripts/desktop/neuroflow-smoke.mjs',
    'scripts/desktop/neuroflow-template-smoke.mjs',
    'registry/offline-assets.lock.json',
    ...Object.values(template.steps).map(step => `apps/${step.tool.split('/')[1]}/automation.json`),
    ...Object.values(dwi.steps).map(step => `apps/${step.tool.split('/')[1]}/automation.json`),
  ];
  for (const file of required) assert.ok(paths.some(pattern => matchesGlob(file, pattern)), `${file} must run the exported workflow`);
  assert.deepEqual(flow.on.push.branches, ['main']);
  assert.ok(Object.hasOwn(flow.on, 'workflow_dispatch'));
});

test('the workflow builds a fixed real upstream runtime and executes both templates on hardware', () => {
  const job = flow.jobs['exported-template'];
  assert.equal(job['runs-on'], 'macos-15');
  assert.equal(job.env.NEURODESK_HARDWARE_GPU, '1');
  const upstream = job.steps.find(step => step.with?.repository === 'cdrake/neuroflow');
  assert.equal(upstream.with.ref, 'fc6ec6075108306a588d48e2c1b66ffb924284a6');
  assert.equal(upstream.with.ref, job.env.NEUROFLOW_COMMIT);
  assert.ok(job.steps.some(step => step.run?.includes('cargo build --release --locked -p neuroflow-mcp')));
  assert.ok(job.steps.some(step => step.run?.includes('cargo test --locked -p neuroflow-mcp orders_steps_by_dependency')));
  assert.ok(job.steps.some(step => step.uses?.startsWith('actions/cache@') && step.with.path.includes('.audit/neuroflow-runtime/target')));
  for (const [name, workflow] of [['t1', template], ['dwi', dwi]]) {
    const build = matrixFor('push', false).include.find(entry => entry.template === name);
    assert.ok(build, `${name} needs an actual CI run`);
    for (const app of new Set(Object.values(workflow.steps).map(step => step.tool.split('/')[1]))) {
      assert.ok(build.apps.includes(`--filter ${app}`), `${app} needs current production bytes`);
    }
  }
  assert.ok(job.steps.some(step => (step.run ?? '').includes('node scripts/desktop/neuroflow-smoke.mjs --${{ matrix.template }}')));
  for (const step of job.steps.filter(step => step.uses)) {
    assert.match(step.uses, /^[\w-]+\/[\w-]+@[0-9a-f]{40}$/);
    if (step.uses.startsWith('actions/checkout@')) assert.equal(step.with['persist-credentials'], false);
  }
});

test('scientific workflow triggers cover the actual transitive workspace graph', async () => {
  const graph = await loadConservativeWorkspaceGraph(fileURLToPath(root));
  const apps = new Set(['pipeline-builder', ...[template, dwi].flatMap(workflow => Object.values(workflow.steps).map(step => step.tool.split('/')[1]))]);
  const paths = flow.on.pull_request.paths;
  for (const app of apps) {
    for (const node of reachableFrom(graph, `apps/${app}`)) {
      if (node.startsWith('(')) continue;
      const file = /^(apps|packages|exes)\/[^/]+$/.test(node) ? `${node}/new-source.js` : node;
      assert.ok(paths.some(pattern => matchesGlob(file, pattern)), `${app} reaches ${node}, which must run scientific workflow CI`);
    }
  }
});


test('the DWI job installs the toolchain that the real shoreline build requires', async () => {
  const build = await readFile(new URL('packages/shoreline/scripts/build-wasm.mjs', root), 'utf8');
  const toolchain = build.match(/const toolchain\s*=\s*["']([^"']+)["']/)[1];
  const steps = flow.jobs['exported-template'].steps;
  const install = steps.findIndex(step => step.run?.includes(`rustup toolchain install ${toolchain}`));
  const compile = steps.findIndex(step => step.name === "Build the exported workflow's applications");
  assert.ok(install >= 0 && install < compile, 'Install the pinned toolchain before building DWI Correct');
  assert.match(steps[install].run, /--component rust-src/);
  assert.match(steps[install].run, /--target wasm32-unknown-unknown/);
  assert.match(steps[install].run, /cargo install wasm-pack --version 0\.13\.1 --locked/);
});


test('only explicit manual diagnostics replace the complete T1/DWI matrix', () => {
  assert.equal(flow.on.workflow_dispatch.inputs.diagnostic_models.default, false);
  for (const event of ['pull_request', 'push', 'schedule', 'workflow_dispatch']) {
    for (const diagnostic of [false, true]) {
      const selected = matrixFor(event, diagnostic).include;
      assert.deepEqual(Array.from(selected, entry => entry.template), event === 'workflow_dispatch' && diagnostic ? ['dwi'] : ['t1', 'dwi']);
    }
  }
});
