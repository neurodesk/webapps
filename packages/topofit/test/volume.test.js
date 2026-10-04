import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateConformMemoryBytes, needsConform } from '../src/volume.js';

test('needsConform matches the reference np.allclose identity tolerances', () => {
  const affine = [
    [1, 0, 0, 70],
    [0, 1, 0, -20],
    [0, 0, 1, 5],
    [0, 0, 0, 1],
  ];
  assert.equal(needsConform(affine), false);
  affine[0][0] = 1 + 1.0005e-5;
  assert.equal(needsConform(affine), false);
  affine[0][0] = 1 + 1.002e-5;
  assert.equal(needsConform(affine), true);
  affine[0][0] = 1;
  affine[0][1] = 1e-8;
  assert.equal(needsConform(affine), false);
  affine[0][1] = 1.01e-8;
  assert.equal(needsConform(affine), true);
  affine[0][1] = NaN;
  assert.equal(needsConform(affine), true);
});

test('conform memory bound covers every orientation of an anisotropic grid', () => {
  const retainedBytes = 1024;
  const bound = estimateConformMemoryBytes([64, 512, 512], retainedBytes);
  assert.equal(estimateConformMemoryBytes([512, 64, 512], retainedBytes), bound);
  assert.equal(estimateConformMemoryBytes([512, 512, 64], retainedBytes), bound);
  const source = 64 * 512 * 512;
  const afterX = 256 * 512 * 512;
  const afterY = 256 * 256 * 512;
  assert.ok(bound >= retainedBytes + 8 * (source + afterX + afterY));
});
