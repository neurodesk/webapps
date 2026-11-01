import assert from 'node:assert/strict';
import test from 'node:test';
import { compareDetections } from '../validation/detection-parity.mjs';
const report = (positions, extra = {}) => ({
  markers: positions.map(centroidVox => ({ centroidVox, meanProb: 0.5 })),
  nCandidates: positions.length, countFlag: positions.length < 3, ...extra,
});

test('v2 uses upstream one-voxel detection parity without requiring identical boundaries', () => {
  const reference = report([[1, 2, 3], [5, 6, 7]]);
  const result = compareDetections(report([[2, 2, 3], [5, 6, 7]]), reference);
  assert.equal(result.sameTopK, true);
  assert.equal(result.sameOrder, true);
  assert.equal(result.maximumCentroidShiftVoxels, 1);
  assert.equal(compareDetections(report([[2.01, 2, 3], [5, 6, 7]]), reference).sameTopK, false);
  assert.equal(compareDetections(report([[5, 6, 7], [1, 2, 3]]), reference).sameOrder, false);
  assert.equal(compareDetections(report([[1, 2, 3]]), reference).sameTopK, false);
  assert.equal(compareDetections(report([[1, 2, 3], [5, 6, 7]], { nCandidates: 3 }), reference).sameCandidateCount, false);
  assert.equal(compareDetections(report([[1, 2, 3], [5, 6, 7]], { countFlag: false }), reference).sameCountFlag, false);
});
