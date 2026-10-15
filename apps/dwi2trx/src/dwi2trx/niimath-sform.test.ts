/**
 * Integration test for the vendored niimath WASM: a qform-only NIfTI
 * (sform_code = 0, common in FSL-preprocessed DWI) must come back with the
 * sform filled in from the qform after a read. Everything niimath emits inherits
 * the repair — the b0 mindgrab masks, and the fit maps NiiVue displays — so
 * without the sync those come back misplaced (see dtifit.ts + vendor/niimath).
 *
 * Run: node --experimental-strip-types src/dwi2trx/niimath-sform.test.ts
 */
import assert from 'node:assert/strict'
import niimathInit from '@niivue/niimath/niimath.js'

const LE = true

/** Build a tiny qform-only NIfTI-1 (.nii): 2³ float32, 2 mm, quat (0,0,1) =
 *  180° about z, qoffsets set, sform_code = 0. */
function qformOnlyNifti(): Uint8Array {
  const dim = 2
  const nvox = dim * dim * dim
  const VOX = 352
  const buf = new ArrayBuffer(VOX + nvox * 4)
  const dv = new DataView(buf)
  dv.setInt32(0, 348, LE) // sizeof_hdr
  dv.setInt16(40, 3, LE) // dim[0] = 3
  dv.setInt16(42, dim, LE)
  dv.setInt16(44, dim, LE)
  dv.setInt16(46, dim, LE)
  for (const o of [48, 50, 52, 54]) dv.setInt16(o, 1, LE) // dim[4..7] = 1
  dv.setInt16(70, 16, LE) // datatype = DT_FLOAT32
  dv.setInt16(72, 32, LE) // bitpix
  dv.setFloat32(76, 1, LE) // pixdim[0] = qfac
  for (const o of [80, 84, 88]) dv.setFloat32(o, 2, LE) // 2 mm voxels
  dv.setFloat32(108, VOX, LE) // vox_offset
  dv.setFloat32(112, 1, LE) // scl_slope
  dv.setUint8(123, 2) // xyzt_units = mm
  dv.setInt16(252, 1, LE) // qform_code = 1
  dv.setInt16(254, 0, LE) // sform_code = 0 (the case under test)
  dv.setFloat32(264, 1, LE) // quatern_d = 1  → 180° about z
  dv.setFloat32(268, 10, LE) // qoffset_x
  dv.setFloat32(272, 20, LE) // qoffset_y
  dv.setFloat32(276, 30, LE) // qoffset_z
  dv.setUint8(344, 0x6e) // "n+1\0"
  dv.setUint8(345, 0x2b)
  dv.setUint8(346, 0x31)
  // leave voxels zero
  return new Uint8Array(buf)
}

const mod = await niimathInit()
mod.FS_createDataFile('.', 'in.nii', qformOnlyNifti(), true, true)
// Any read-through op triggers the header read; -gz 0 keeps the output plain.
const code = mod.callMain(['in.nii', '-add', '0', '-gz', '0', 'out.nii'])
assert.equal(code, 0, `niimath exit ${code}`)

const out = mod.FS_readFile('out.nii')
const dv = new DataView(out.buffer, out.byteOffset, out.byteLength)
assert.equal(dv.getInt16(252, LE), 1, 'qform preserved')
assert.equal(dv.getInt16(254, LE), 1, 'sform filled from qform (was 0)')
// 180° about z, 2 mm → R = diag(-2,-2,2); qoffsets in the 4th column.
const f = (o: number) => dv.getFloat32(o, LE)
const ok = (got: number, want: number, m: string) =>
  assert.ok(Math.abs(got - want) < 1e-3, `${m}: ${got} vs ${want}`)
ok(f(280), -2, 'srow_x[0]')
ok(f(280 + 12), 10, 'srow_x[3]')
ok(f(296 + 4), -2, 'srow_y[1]')
ok(f(296 + 12), 20, 'srow_y[3]')
ok(f(312 + 8), 2, 'srow_z[2]')
ok(f(312 + 12), 30, 'srow_z[3]')

console.log('niimath-sform.test: OK — vendored WASM syncs sform from qform')
