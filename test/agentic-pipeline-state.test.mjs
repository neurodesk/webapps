import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pipelineSettled } from '../test-utils/agentic-pipeline-state.mjs';

test('Calmar stage progress cannot finish the analysis wait', () => {
  assert.equal(pipelineSettled('calmar', { text: 'Brain extraction complete.', value: 1, max: 1 }), false);
  assert.equal(pipelineSettled('calmar', { text: 'Patch 4/27 TTA 2/8', value: 1, max: 1 }), false);
  assert.equal(pipelineSettled('calmar', { text: 'Review and confirm the lesion mask', value: 1, max: 1 }), true);
  assert.equal(pipelineSettled('calmar', { text: 'Complete', value: 1, max: 1 }), true);
  assert.equal(pipelineSettled('calmar', { text: 'Threshold projection complete', value: 1, max: 1 }), true);
  assert.equal(pipelineSettled('calmar', { text: 'Analysis failed: model unavailable', value: 0, max: 1 }), true);
});

test('other apps retain their determinate and indeterminate completion contracts', () => {
  assert.equal(pipelineSettled('syncro', { text: 'Synthesizing', value: 0.3, max: 1 }), false);
  assert.equal(pipelineSettled('syncro', { text: 'Complete', value: 1, max: 1 }), true);
  assert.equal(pipelineSettled('dwi2trx', { text: 'Tracking', value: null, max: 1 }), false);
  assert.equal(pipelineSettled('dwi2trx', { text: 'Complete', value: 0, max: 1 }), true);
});
