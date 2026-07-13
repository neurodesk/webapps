#!/usr/bin/env node --no-warnings

import assert from 'node:assert/strict';
import '../web/js/modules/pipeline/n4-shrink-policy.js';

const policy = globalThis.VesselBoostN4Policy;

assert.ok(policy, 'N4 shrink policy should attach to globalThis');

assert.equal(
  policy.estimateExternalDownsampleFactor([0.6, 0.6, 0.6], [0.3, 0.3, 0.3]),
  2
);

assert.equal(
  policy.chooseN4ShrinkFactor([0.3, 0.3, 0.3], [0.3, 0.3, 0.3], [256, 256, 160]).shrinkFactor,
  4,
  'native-space N4 keeps the default shrink factor'
);

{
  const choice = policy.chooseN4ShrinkFactor([0.6, 0.6, 0.6], [0.3, 0.3, 0.3], [128, 128, 80]);
  assert.equal(choice.shrinkFactor, 2, 'factor-2 external downsample should reduce internal N4 shrink to 2');
  assert.equal(choice.effectiveShrinkFactor, 4, 'factor-2 downsample plus internal shrink should stay native-equivalent 4x');
}

{
  const choice = policy.chooseN4ShrinkFactor([1.2, 1.2, 1.2], [0.3, 0.3, 0.3], [64, 64, 40]);
  assert.equal(choice.shrinkFactor, 1, 'factor-4 external downsample should not shrink N4 internally');
  assert.equal(choice.effectiveShrinkFactor, 4);
}

{
  const choice = policy.chooseN4ShrinkFactor([0.6, 0.6, 0.6], [0.3, 0.3, 0.3], [28, 60, 60]);
  assert.equal(choice.shrinkFactor, 1, 'small downsampled axes should not be shrunk below the minimum useful size');
}

console.log('n4-shrink-policy OK: N4 internal shrink adapts to external downsampling.');
