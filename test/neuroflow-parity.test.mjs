import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { resolveStepInputs, scientificProvenance } from '../scripts/lib/neuroflow-parity.mjs';

test('individual app comparisons resolve the exact chain files and constant settings', () => {
  const step = { inputs: {
    input_dwi: { ref: 'steps.correct.outputs.output_dwi' },
    input_mask: { ref: 'inputs.mask' },
    param_iterations: { constant: 20 },
  } };
  assert.deepEqual(resolveStepInputs(step, { mask: '/fixed/mask.nii.gz' }, { correct: { output_dwi: '/chain/corrected.nii.gz' } }),
    { input_dwi: '/chain/corrected.nii.gz', input_mask: '/fixed/mask.nii.gz', param_iterations: 20 });
  assert.throws(() => resolveStepInputs(step, {}, {}), /Missing fixed input/);
});

test('parity excludes execution durations and retains acquisition timing and scientific settings', () => {
  assert.deepEqual(scientificProvenance({ elapsedMs: 10, fitSeconds: 2, model: { seconds: 4, Seconds: 5, iterations: 20 }, acquisition: { EchoTime: 0.08, RepetitionTime: 3 } }),
    { model: { iterations: 20 }, acquisition: { EchoTime: 0.08, RepetitionTime: 3 } });
  assert.notDeepEqual(scientificProvenance({ acquisition: { EchoTime: 0.08 } }), scientificProvenance({ acquisition: { EchoTime: 0.09 } }));
});

test('archive evidence distinguishes timestamps from scientific member differences', async t => {
  const { createRequire } = await import('node:module');
  const { dirname } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { zipEvidence } = await import('../scripts/lib/neuroflow-parity.mjs');
  const require = createRequire(new URL('../apps/dwi2trx/package.json', import.meta.url));
  const entry = require.resolve('@dipy/gpu-streamlines');
  const { zipSync } = await import(pathToFileURL(require.resolve('fflate', { paths: [dirname(entry)] })));
  const root = await mkdtemp(join(tmpdir(), 'archive-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const header = Buffer.from(JSON.stringify({ NB_VERTICES: 1, NB_STREAMLINES: 1 }));
  const members = { 'header.json': header, 'positions.3.float32': new Uint8Array(new Float32Array([1, 2, 3]).buffer) };
  const first = join(root, 'first.trx');
  const later = join(root, 'later.trx');
  const changed = join(root, 'changed.trx');
  await writeFile(first, zipSync(members, { level: 0, mtime: new Date(2020, 0, 1) }));
  await writeFile(later, zipSync(members, { level: 0, mtime: new Date(2021, 0, 1) }));
  await writeFile(changed, zipSync({ ...members, 'positions.3.float32': new Uint8Array(new Float32Array([1, 2, 4]).buffer) }, { level: 0, mtime: new Date(2020, 0, 1) }));
  const a = await zipEvidence(first);
  const b = await zipEvidence(later);
  const c = await zipEvidence(changed);
  assert.notEqual(a.sha256, b.sha256);
  assert.deepEqual(a.members, b.members);
  assert.deepEqual(a.members['header.json'].header, { NB_VERTICES: 1, NB_STREAMLINES: 1 });
  assert.notEqual(a.members['positions.3.float32'].sha256, c.members['positions.3.float32'].sha256);
  assert.match(a.metadata, /20200101/);
});

test('independent failure retains snapshots and desktop stderr without accepting the failed run', async t => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { compareIndividualApps } = await import('../scripts/lib/neuroflow-parity.mjs');
  const scratch = await mkdtemp(join(tmpdir(), 'neuroflow-failed-comparison-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  let closed = false;
  const client = {
    initialize: async () => {},
    tool: async name => name === 'apps_validate' ? {} : { id: 'failed-model', state: 'failed', phase: 'complete',
      message: 'Fitting models: 42%', error: { code: 'RENDERER_EXIT', message: 'Browser renderer exited: oom (exit code 9)' } },
    close: async () => { closed = true; },
    diagnostics: () => ({ stderr: 'renderer process terminated\n' }),
  };
  const tool = { id: 'noddi-fit', inputs: {}, extensions: {
    'neurodesk/automation': { contract: { app: 'noddi', operations: { fit: { inputs: {}, engines: ['browser'] } } }, operation: 'fit', inputs: {}, parameters: {}, artifacts: {} },
  } };
  await assert.rejects(compareIndividualApps({ workflow: { steps: { models: { tool: tool.id, inputs: {} } } },
    inputs: {}, results: {}, tools: [tool], scratch, env: { NEURODESK_WEBAPPS_ARGS: '[]', NEURODESK_TIMEOUT_MS: '7200000' },
    connect: () => client }), /RENDERER_EXIT/);
  assert.equal(closed, true);
  const diagnostic = JSON.parse(await readFile(join(scratch, 'logs/models.desktop-diagnostics.json')));
  assert.equal(diagnostic.stderr, 'renderer process terminated\n');
  assert.equal(diagnostic.snapshots[0].snapshot.message, 'Fitting models: 42%');
  assert.equal(diagnostic.snapshots[0].snapshot.error.code, 'RENDERER_EXIT');
});

test('desktop diagnostics survive clean child shutdown with stderr and joined exit status', async () => {
  const { openDesktop } = await import('../packages/desktop/neuroflow/runtime/stdio.mjs');
  const client = openDesktop(process.execPath, ['-e', "process.stderr.write('diagnostic marker\\n');process.stdin.resume();process.stdin.on('end',()=>process.exit(0));"]);
  await client.close();
  const diagnostics = client.diagnostics();
  assert.ok(diagnostics.pid > 0);
  assert.deepEqual(diagnostics.exit, { code: 0, signal: null });
  assert.deepEqual(diagnostics.terminationSignals, []);
  assert.equal(diagnostics.stderr, 'diagnostic marker\n');
});

test('models diagnostics preserve original scientific settings and cannot weaken default full acceptance', async () => {
  const { readFile } = await import('node:fs/promises');
  const { validationPlan } = await import('../scripts/lib/neuroflow-validation.mjs');
  const workflow = JSON.parse(await readFile(new URL('../apps/pipeline-builder/src/workflows/dwi-preprocessing.workflow.json', import.meta.url)));
  const original = structuredClone(workflow);
  const full = validationPlan(workflow);
  assert.deepEqual(full.workflow, original);
  assert.deepEqual(full.comparisons, original);
  assert.equal(full.fullWorkflowAcceptance, true);
  assert.equal(Object.keys(full.workflow.steps).length, 6);
  const diagnostic = validationPlan(workflow, { diagnosticModels: true });
  assert.equal(diagnostic.fullWorkflowAcceptance, false);
  assert.deepEqual(Object.keys(diagnostic.workflow.steps), ['denoise', 'degibbs', 'correct', 'brain', 'models']);
  for (const [id, step] of Object.entries(diagnostic.workflow.steps)) assert.deepEqual(step, original.steps[id]);
  assert.deepEqual(Object.keys(diagnostic.comparisons.steps), ['models']);
  assert.ok(Object.values(diagnostic.workflow.outputs).every(output => !output.ref.includes('tractography')));
  assert.deepEqual(workflow, original);
});
