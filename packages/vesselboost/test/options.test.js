import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { DEFAULT_PARAMETERS, runSteps, validateParameters } from '../src/options.js';

test('CLI and app automation have identical default scientific parameters', async () => {
  const contract = JSON.parse(
    await readFile(new URL('../../../apps/vesselboost/automation.json', import.meta.url))
  );
  assert.deepEqual(
    DEFAULT_PARAMETERS,
    Object.fromEntries(
      Object.entries(contract.operations.segment.parameters).map(([key, spec]) => [
        key,
        spec.default,
      ])
    )
  );
});
test('the shared orchestration applies optional steps in the browser order', async () => {
  const steps = [];
  await runSteps(async (type, data) => steps.push([type, data]), {
    downsample: 2,
    biasCorrection: true,
    denoise: 'nlm-fast',
    brainExtraction: 'bet',
    brainThreshold: 0.7,
  });
  assert.deepEqual(
    steps.map(([type]) => type),
    ['downsample', 'run-n4', 'run-denoise', 'run-inference', 'run-bet', 'apply-brain-mask']
  );
  assert.deepEqual(steps[4][1], { method: 'bet', fractionalIntensity: 0.7 });
});
test('a failed preprocessing step prevents inference and postprocessing', async () => {
  const steps = [];
  await assert.rejects(
    runSteps(async (type) => {
      steps.push(type);
      if (type === 'run-n4') throw new Error('required kernel failed');
    }, {}),
    /kernel failed/
  );
  assert.deepEqual(steps, ['skip-downsample', 'run-n4']);
});
