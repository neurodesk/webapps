// Minimal NIfTI-1 reader/writer in JS — mirrors crates/mp2rage-cli/src/nifti_io.rs
// so the data layout the WASM worker sees is exactly the validated convention:
// flat, first index fastest (data[i + nx*(j + ny*k)] , 4D stacks t slowest).
//
// gz handled with the streaming (De)CompressionStream API (browsers + Node 18+).

async function gunzipIfNeeded(buf) {
  const u8 = new Uint8Array(buf);
  if (u8.length >= 2 && u8[0] === 0x1f && u8[1] === 0x8b) {
    const ds = new DecompressionStream('gzip');
    const stream = new Blob([u8]).stream().pipeThrough(ds);
    return await new Response(stream).arrayBuffer();
  }
  return buf;
}

export async function gzip(u8) {
  const cs = new CompressionStream('gzip');
  const stream = new Blob([u8]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// qform (quaternion) affine, NIfTI method 2
function qformAffine(dv) {
  const b = dv.getFloat32(256, true), c = dv.getFloat32(260, true), d = dv.getFloat32(264, true);
  const a = Math.sqrt(Math.max(0, 1 - (b * b + c * c + d * d)));
  const qfac = dv.getFloat32(76, true) < 0 ? -1 : 1;
  const dx = dv.getFloat32(80, true), dy = dv.getFloat32(84, true), dz = dv.getFloat32(88, true);
  const R = [
    [a * a + b * b - c * c - d * d, 2 * (b * c - a * d), 2 * (b * d + a * c)],
    [2 * (b * c + a * d), a * a + c * c - b * b - d * d, 2 * (c * d - a * b)],
    [2 * (b * d - a * c), 2 * (c * d + a * b), a * a + d * d - b * b - c * c],
  ];
  const ox = dv.getFloat32(268, true), oy = dv.getFloat32(272, true), oz = dv.getFloat32(276, true);
  return new Float32Array([
    R[0][0] * dx, R[0][1] * dy, R[0][2] * dz * qfac, ox,
    R[1][0] * dx, R[1][1] * dy, R[1][2] * dz * qfac, oy,
    R[2][0] * dx, R[2][1] * dy, R[2][2] * dz * qfac, oz,
    0, 0, 0, 1,
  ]);
}

/** Parse a NIfTI-1 file (ArrayBuffer). Returns {data:Float32Array, dims:[..], affine:Float32Array(16)}. */
export async function readNifti(arrayBuffer) {
  const buf = await gunzipIfNeeded(arrayBuffer);
  const dv = new DataView(buf);
  if (dv.getInt32(0, true) !== 348) throw new Error('unsupported/big-endian NIfTI (sizeof_hdr != 348)');
  const ndim = Math.max(0, dv.getInt16(40, true));
  const dims = [];
  for (let i = 1; i <= Math.min(ndim, 4); i++) dims.push(Math.max(1, dv.getInt16(40 + 2 * i, true)));
  while (dims.length < 3) dims.push(1);
  const datatype = dv.getInt16(70, true);
  const voxOffsetRaw = dv.getFloat32(108, true); // avoid `| 0` (ToInt32 wraps large offsets)
  const voxOffset = Number.isFinite(voxOffsetRaw) && voxOffsetRaw >= 352 ? Math.trunc(voxOffsetRaw) : 352;
  let slope = dv.getFloat32(112, true); const inter0 = dv.getFloat32(116, true);
  if (slope === 0 || Number.isNaN(slope)) slope = 1;
  const inter = Number.isNaN(inter0) ? 0 : inter0;

  const sform = dv.getInt16(254, true);
  let affine;
  if (sform > 0) {
    affine = new Float32Array(16);
    const bases = [280, 296, 312];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) affine[r * 4 + c] = dv.getFloat32(bases[r] + 4 * c, true);
    affine[15] = 1;
  } else {
    affine = qformAffine(dv);
  }

  const n = dims.reduce((a, b) => a * b, 1);
  const off = voxOffset;
  const bpv = { 16: 4, 64: 8, 4: 2, 512: 2, 8: 4, 2: 1, 256: 1 }[datatype];
  if (!bpv) throw new Error('unsupported datatype ' + datatype);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error('invalid NIfTI dimensions');
  // Bound the allocation to the real file size, so a header claiming huge dims
  // cannot trigger a multi-GB allocation / tab OOM before any data is read.
  if (off + n * bpv > buf.byteLength) throw new Error('NIfTI data is truncated or header dimensions are inconsistent with the file size');
  const data = new Float32Array(n);
  const get = {
    16: (i) => dv.getFloat32(off + 4 * i, true),
    64: (i) => dv.getFloat64(off + 8 * i, true),
    4: (i) => dv.getInt16(off + 2 * i, true),
    512: (i) => dv.getUint16(off + 2 * i, true),
    8: (i) => dv.getInt32(off + 4 * i, true),
    2: (i) => dv.getUint8(off + i),
    256: (i) => dv.getInt8(off + i),
  }[datatype];
  for (let i = 0; i < n; i++) data[i] = get(i) * slope + inter;
  return { data, dims, affine };
}

/** Build an uncompressed .nii ArrayBuffer for a float32 volume (i fastest). */
export function writeNiftiF32(data, dims, affine) {
  const [nx, ny, nz] = dims;
  const n = nx * ny * nz;
  const buf = new ArrayBuffer(352 + n * 4);
  const dv = new DataView(buf);
  dv.setInt32(0, 348, true);
  dv.setInt16(40, 3, true);
  dv.setInt16(42, nx, true); dv.setInt16(44, ny, true); dv.setInt16(46, nz, true);
  dv.setInt16(48, 1, true); dv.setInt16(50, 1, true); dv.setInt16(52, 1, true); dv.setInt16(54, 1, true);
  dv.setInt16(70, 16, true); // float32
  dv.setInt16(72, 32, true);
  const vsize = (c) => Math.hypot(affine[c], affine[4 + c], affine[8 + c]);
  dv.setFloat32(76, 1, true);
  dv.setFloat32(80, vsize(0), true); dv.setFloat32(84, vsize(1), true); dv.setFloat32(88, vsize(2), true);
  dv.setFloat32(108, 352, true);
  dv.setFloat32(112, 1, true); dv.setFloat32(116, 0, true);
  dv.setInt16(252, 0, true); dv.setInt16(254, 2, true); // qform 0, sform aligned
  const bases = [280, 296, 312];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) dv.setFloat32(bases[r] + 4 * c, affine[r * 4 + c], true);
  // magic "n+1\0"
  dv.setUint8(344, 0x6e); dv.setUint8(345, 0x2b); dv.setUint8(346, 0x31); dv.setUint8(347, 0);
  const out = new Float32Array(buf, 352, n);
  out.set(data);
  return buf;
}

/** Convenience: gzipped .nii bytes for download. */
export async function writeNiftiGz(data, dims, affine) {
  return gzip(new Uint8Array(writeNiftiF32(data, dims, affine)));
}
