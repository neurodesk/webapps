/**
 * End-to-end check of the shared dtifit pipeline through the app's niimath runner
 * against the bundled sample. Runs the real WASM (unmasked dtifit), so it needs the
 * vendored niimath.
 * Run: node --experimental-strip-types src/dwi2trx/dtifit.test.ts  (Node 22+).
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { fitTensor } from '@neurodesk/dwi2trx'
import { runNiimath } from './dtifit.ts'

const fixtureDir = process.env.DWI2TRX_FIXTURE_DIR || 'public'
const fixture = join(fixtureDir, 'dwi.nii.gz')
if (!existsSync(fixture)) {
  console.log('dtifit.test.ts: skipped (optional DWI fixture is hosted with release data)')
  process.exit(0)
}

const maps = await fitTensor(runNiimath, {
  dwi: readFileSync(fixture),
  bval: readFileSync(join(fixtureDir, 'dwi.bval')),
  bvec: readFileSync(join(fixtureDir, 'dwi.bvec')),
})
const fa = new Blob([maps.FA])
const v1 = new Blob([maps.V1])

// FA: 3D float32 in [0, 1] with white-matter structure over the brain.
const faBytes = gunzipSync(Buffer.from(await fa.arrayBuffer()))
const fdv = new DataView(faBytes.buffer, faBytes.byteOffset, faBytes.byteLength)
assert.equal(fdv.getInt16(40, true), 3, 'FA should be 3D')
assert.equal(fdv.getInt16(70, true), 16, 'FA should be float32 (datatype 16)')
const fvals = new Float32Array(
  faBytes.buffer,
  faBytes.byteOffset + 352,
  (faBytes.length - 352) / 4,
)
let min = Infinity
let max = -Infinity
let nonzero = 0
for (const v of fvals) {
  if (!Number.isFinite(v)) continue
  if (v < min) min = v
  if (v > max) max = v
  if (v > 0) nonzero++
}
assert.ok(min >= 0 && max <= 1, `FA must be in [0,1], got [${min}, ${max}]`)
assert.ok(
  max > 0.4,
  `FA should reach white-matter values, max ${max.toFixed(3)}`,
)
assert.ok(nonzero > 10000, `FA should cover the brain, got ${nonzero} nonzero`)

// V1: 4D with 3 vector components (directionally-encoded color).
const v1Bytes = gunzipSync(Buffer.from(await v1.arrayBuffer()))
const vdv = new DataView(v1Bytes.buffer, v1Bytes.byteOffset, v1Bytes.byteLength)
assert.equal(vdv.getInt16(40, true), 4, 'V1 should be 4D')
assert.equal(vdv.getInt16(48, true), 3, 'V1 should have 3 components')

console.log(
  `dtifit.test.ts: FA in [${min.toFixed(2)}, ${max.toFixed(2)}], ${nonzero} brain voxels, V1 3-vector ✓`,
)
