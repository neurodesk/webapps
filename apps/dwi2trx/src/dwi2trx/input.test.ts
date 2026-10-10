import assert from 'node:assert/strict'
import {
  assertInputSize,
  formatBytes,
  InputTooLargeError,
  MAX_INPUT_BYTES,
} from './input-limits.ts'
import { resolveInput } from './input.ts'

const sizedFile = (size: number): File => ({ size }) as File

assert.doesNotThrow(() => assertInputSize([sizedFile(MAX_INPUT_BYTES)]))
assert.throws(
  () => assertInputSize([sizedFile(1_500_000_000), sizedFile(500_000_001)]),
  (error) =>
    error instanceof InputTooLargeError &&
    error.actualBytes === 2_000_000_001 &&
    error.limitBytes === MAX_INPUT_BYTES,
)
assert.equal(formatBytes(30_000_000_000), '30.0 GB')
assert.equal(formatBytes(MAX_INPUT_BYTES), '2.00 GB')

const nifti = new Uint8Array(352)
const header = new DataView(nifti.buffer)
header.setInt32(0, 348, true)
header.setInt16(40, 4, true)
header.setInt16(42, 1, true)
header.setInt16(44, 1, true)
header.setInt16(46, 1, true)
header.setInt16(48, 21, true)
header.setInt16(72, 32, true)
nifti.set([0x6e, 0x2b, 0x31], 344) // NIfTI-1 single-file magic: n+1
const sample = [
  new File([nifti], 'dwi.nii'),
  new File([`0 ${Array(20).fill(1000).join(' ')}`], 'dwi.bval'),
  new File([`${Array(21).fill(0).join(' ')}\n${Array(21).fill(0).join(' ')}\n${Array(21).fill(0).join(' ')}`], 'dwi.bvec'),
]
const resolved = await resolveInput(sample)
assert.equal(resolved.directions, 21)
assert.equal(resolved.source, 'nifti')

console.log('input.test.ts: size guard and NIfTI sample validation OK')

const { resolveExplicitInput } = await import('./input.ts')
const explicit = await resolveExplicitInput({
  nifti: new File([nifti], 'image-from-agent.nii'),
  bval: new File([await sample[1].text()], 'unrelated-values.bval'),
  bvec: new File([await sample[2].text()], 'unrelated-directions.bvec'),
})
assert.equal(explicit.directions, 21)
assert.equal(explicit.bvec.name, 'unrelated-directions.bvec')
await assert.rejects(resolveExplicitInput({ ...explicit, bval: new File(['0'], 'bad.bval') }), /bval|mismatch|bvec/i)
