/**
 * The 3D preview keeps to its point budget.
 * Run: node --experimental-strip-types src/dwi2trx/preview.test.ts
 */

import assert from 'node:assert/strict'
import { PREVIEW_POINT_BUDGET, previewStride } from './preview.ts'

// A tractogram within the budget is shown whole.
assert.equal(previewStride(0), 1)
assert.equal(previewStride(PREVIEW_POINT_BUDGET), 1)

// One point over the budget halves the preview.
assert.equal(previewStride(PREVIEW_POINT_BUDGET + 1), 2)

// Issue #790: 310,677 streamlines and 32,944,453 points at default settings.
const stride = previewStride(32_944_453)
assert.equal(stride, 33)
assert.ok(32_944_453 / stride <= PREVIEW_POINT_BUDGET)

console.log('preview.test.ts passed')
