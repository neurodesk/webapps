/**
 * Minimal NIfTI-1 writer.
 *
 * **Temporary shim.** Core niivue already implements `nii2volume` (build an
 * NVImage from a header + voxels) and `writeVolume` (serialize an NVImage to
 * NIfTI bytes). In published rc.9 they ship inside the build
 * (`dist/volume/writers/`, `dist/volume/NVVolume.d.ts`) but are NOT re-exported
 * from the public entry (`index.d.ts`), so we can't import them cleanly yet.
 * Until they're publicly re-exported, serialize volumes here and load them
 * through the public `nv.addVolume({ url: File })` path.
 *
 * Once a niivue release re-exports those primitives at the top level, delete
 * this file: build overlays with `nii2volume`, serialize with `writeVolume`.
 *
 * Geometry is written as an sform from the source affine so a derived volume
 * lands exactly on the grid it was derived from.
 */

import type { NIFTI1, NIFTI2 } from '@niivue/niivue'

const HEADER_BYTES = 348
const VOX_OFFSET = 352 // 348-byte header + 4-byte extension flag

/** Map a typed-array view to its NIfTI datatype code + bits-per-voxel. The
 *  header must describe the bytes actually written, not the source volume's
 *  on-disk datatype, or a reader (niimath) will misinterpret them. */
function niftiTypeOf(data: ArrayBufferView): { code: number; bitpix: number } {
  if (data instanceof Uint8Array || data instanceof Uint8ClampedArray)
    return { code: 2, bitpix: 8 } // DT_UINT8
  if (data instanceof Int16Array) return { code: 4, bitpix: 16 } // DT_INT16
  if (data instanceof Int32Array) return { code: 8, bitpix: 32 } // DT_INT32
  if (data instanceof Float32Array) return { code: 16, bitpix: 32 } // DT_FLOAT32
  if (data instanceof Float64Array) return { code: 64, bitpix: 64 } // DT_FLOAT64
  if (data instanceof Int8Array) return { code: 256, bitpix: 8 } // DT_INT8
  if (data instanceof Uint16Array) return { code: 512, bitpix: 16 } // DT_UINT16
  if (data instanceof Uint32Array) return { code: 768, bitpix: 32 } // DT_UINT32
  throw new Error(`writeNifti: unsupported voxel type ${data.constructor.name}`)
}

/** Serialize raw voxel bytes + a source header into an uncompressed NIfTI-1
 *  `.nii` buffer. Geometry (dims, pixdim, sform affine) comes from `hdr`; the
 *  datatype is inferred from `data`'s typed-array kind (it must describe the
 *  bytes actually written) and scaling is identity. `intentCode` defaults to
 *  the source header's intent. */
export function writeNifti(
  hdr: NIFTI1 | NIFTI2,
  data: ArrayBufferView,
  intentCode: number = hdr.intent_code ?? 0,
): ArrayBuffer {
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  const buf = new ArrayBuffer(VOX_OFFSET + bytes.length)
  const dv = new DataView(buf)
  const LE = true

  dv.setInt32(0, HEADER_BYTES, LE) // sizeof_hdr

  // dim[0..7] (int16) at offset 40 — force a 3D single-frame volume.
  // 3D-only: a 4D source would get a 3D header over 4D bytes (corrupt). dwi2trx
  // never routes a 4D DWI through here (dtifit stages raw Files into the niimath
  // FS), but guard rather than silently corrupt if someone passes one.
  const dims = hdr.dims
  if (dims[0] > 3) {
    throw new Error(
      `writeNifti: 4D input (dim[0]=${dims[0]}) is not supported — this serializer writes a 3D header. Extract a single volume first.`,
    )
  }
  dv.setInt16(40, 3, LE)
  dv.setInt16(42, dims[1], LE)
  dv.setInt16(44, dims[2], LE)
  dv.setInt16(46, dims[3], LE)
  dv.setInt16(48, 1, LE)
  dv.setInt16(50, 1, LE)
  dv.setInt16(52, 1, LE)
  dv.setInt16(54, 1, LE)

  const inferred = niftiTypeOf(data)
  dv.setInt16(68, intentCode, LE) // intent_code
  dv.setInt16(70, inferred.code, LE) // datatype
  dv.setInt16(72, inferred.bitpix, LE) // bitpix

  // pixdim[0..7] (float32) at offset 76. pixdim[0] is qfac (sform is used).
  const px = hdr.pixDims
  dv.setFloat32(76, px?.[0] ?? 1, LE)
  dv.setFloat32(80, px?.[1] ?? 1, LE)
  dv.setFloat32(84, px?.[2] ?? 1, LE)
  dv.setFloat32(88, px?.[3] ?? 1, LE)

  dv.setFloat32(108, VOX_OFFSET, LE) // vox_offset
  // Identity scaling: `data` already holds real-world values, so re-stamping
  // the source hdr's slope/inter would double-apply when a reader scales again.
  dv.setFloat32(112, 1, LE) // scl_slope
  dv.setFloat32(116, 0, LE) // scl_inter
  dv.setUint8(123, hdr.xyzt_units ?? 2) // xyzt_units (default mm)

  // Geometry via the sform affine so the volume aligns with its source. With no
  // usable affine, leave sform_code = 0 (zero srow rows would be a degenerate
  // transform); readers then fall back to pixdim-based spacing.
  const a = hdr.affine
  dv.setInt16(252, 0, LE) // qform_code disabled
  if (a && a.length >= 3) {
    dv.setInt16(254, 1, LE) // sform_code = NIFTI_XFORM_SCANNER_ANAT
    for (let c = 0; c < 4; c++) dv.setFloat32(280 + c * 4, a[0][c], LE) // srow_x
    for (let c = 0; c < 4; c++) dv.setFloat32(296 + c * 4, a[1][c], LE) // srow_y
    for (let c = 0; c < 4; c++) dv.setFloat32(312 + c * 4, a[2][c], LE) // srow_z
  } else {
    dv.setInt16(254, 0, LE) // sform_code = NIFTI_XFORM_UNKNOWN
  }

  // magic "n+1\0" at offset 344
  dv.setUint8(344, 0x6e)
  dv.setUint8(345, 0x2b)
  dv.setUint8(346, 0x31)
  dv.setUint8(347, 0x00)

  new Uint8Array(buf, VOX_OFFSET).set(bytes)
  return buf
}

/** Serialize a Uint8 label/mask volume sharing `srcHdr`'s 3D geometry, stamped
 *  as a `NIFTI_INTENT_LABEL` (1002) DT_UINT8 volume. Used for the mindgrab
 *  brain mask (0/1 labels) in conformed space before reslicing to native. */
export function writeUint8LabelNifti(
  srcHdr: NIFTI1 | NIFTI2,
  data: Uint8Array,
): ArrayBuffer {
  return writeNifti(srcHdr, data, 1002) // NIFTI_INTENT_LABEL
}
