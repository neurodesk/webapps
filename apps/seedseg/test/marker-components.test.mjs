import assert from 'node:assert/strict';
import test from 'node:test';
import { dice } from '../../../test-utils/dice.mjs';
import { markerComponents, matchComponentsToSeeds } from './marker-components.mjs';
import { createProstateSeedMask, PROSTATE_FIXTURE_DIMS, PROSTATE_FIXTURE_SEEDS } from './prostate-fixture.mjs';

test('components are 26-connected and report voxel counts and centroids', () => {
  const dims = [4, 3, 2];
  const mask = new Uint8Array(24);
  // (0,0,0) and (1,1,1) touch only at a corner: one component under 26-connectivity.
  mask[0] = 1;
  mask[1 + 4 * (1 + 3 * 1)] = 1;
  // (3,2,0) is two voxels away from both: a second component.
  mask[3 + 4 * 2] = 1;
  assert.deepEqual(markerComponents(mask, dims), [
    { voxels: 2, centroid: [0.5, 0.5, 0.5] },
    { voxels: 1, centroid: [3, 2, 0] },
  ]);
});

test('the planted seed mask is three 39-voxel cylinders centred on the planted coordinates', () => {
  const components = markerComponents(createProstateSeedMask(), PROSTATE_FIXTURE_DIMS);
  assert.equal(components.length, 3);
  const matches = matchComponentsToSeeds(components, PROSTATE_FIXTURE_SEEDS);
  for (const match of matches) {
    assert.equal(match.component.voxels, 39);
    assert.equal(match.distance, 0);
  }
});

test('an all-zero or displaced marker mask fails the checks the browser test applies', () => {
  const truth = createProstateSeedMask();
  const [nx] = PROSTATE_FIXTURE_DIMS;
  const empty = new Uint8Array(truth.length);
  assert.equal(markerComponents(empty, PROSTATE_FIXTURE_DIMS).length, 0);
  assert.equal(dice(empty, truth), 0);
  assert.throws(() => matchComponentsToSeeds([], PROSTATE_FIXTURE_SEEDS), /No marker component/);
  // The same three cylinders moved 6 voxels along x: three components, none near a seed.
  const shifted = new Uint8Array(truth.length);
  truth.forEach((value, index) => {
    if (value) shifted[index + 6] = 1;
  });
  const matches = matchComponentsToSeeds(markerComponents(shifted, PROSTATE_FIXTURE_DIMS), PROSTATE_FIXTURE_SEEDS);
  assert.ok(nx > 6);
  assert.ok(matches.every(match => match.distance === 6));
  assert.equal(dice(shifted, truth), 0);
});

test('one component cannot stand in for two planted seeds', () => {
  const components = [{ voxels: 39, centroid: [64, 62, 16] }];
  assert.throws(() => matchComponentsToSeeds(components, PROSTATE_FIXTURE_SEEDS), /more than one planted seed/);
});
