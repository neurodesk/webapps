/**
 * Golden checks for the pure validation logic. No framework — run with:
 *   node --experimental-strip-types src/dwi2trx/validate.test.ts
 * (node 25 strips TS types natively). Asserts and exits non-zero on failure.
 */

import assert from 'node:assert/strict'
import {
  baseName,
  chooseBestSeries,
  flipBvecX,
  isBval,
  isNifti,
} from './validate.ts'

// --- name classifiers + grouping ---
assert.equal(isNifti('dwi.nii.gz'), true)
assert.equal(isNifti('dwi.nii'), true)
assert.equal(isNifti('dwi.bval'), false)
assert.equal(isBval('dwi.bval'), true)
assert.equal(baseName('dwi.nii.gz'), 'dwi')
assert.equal(baseName('sub-01_dwi.bvec'), 'sub-01_dwi')
assert.equal(baseName('series_007.json'), 'series_007')

// --- chooseBestSeries: pick the valid candidate with the most directions ---
// single valid candidate
assert.equal(chooseBestSeries([{ directions: 21, volumes: 21 }]), 0)
// most directions among valid wins
assert.equal(
  chooseBestSeries([
    { directions: 7, volumes: 7 },
    { directions: 33, volumes: 33 },
  ]),
  1,
)
// the largest sidecar count has a broken NIfTI → the valid smaller one is chosen
assert.equal(
  chooseBestSeries([
    { directions: 64, volumes: 1 }, // mismatch (broken NIfTI)
    { directions: 21, volumes: 21 }, // valid
  ]),
  1,
)
// none match → -1
assert.equal(chooseBestSeries([{ directions: 10, volumes: 5 }]), -1)
assert.equal(chooseBestSeries([]), -1)

// flipBvecX negates only the x row and keeps zeros unsigned.
assert.equal(flipBvecX('0 0.5 -1\n0 0.2 0\n1 0.8 0\n'), '0 -0.5 1\n0 0.2 0\n1 0.8 0')

console.log('validate.test.ts: all assertions passed ✓')
