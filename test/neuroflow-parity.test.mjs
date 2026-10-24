import assert from 'node:assert/strict';
import test from 'node:test';
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
