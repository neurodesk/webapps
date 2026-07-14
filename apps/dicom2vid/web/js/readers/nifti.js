// Minimal NIfTI-1 reader (single-file 'n+1'), grayscale and RGB24.
//
// Produces a canonical Volume in [i, j, k] layout (the pipeline treats these as
// array axes, like the DICOM path). The affine is the sform when present, else
// the qform, else a pixdim scaling, mirroring nibabel's get_best_affine.

import { makeVolume } from '../volume.js';
import { maybeGunzip } from './gzip.js';

export class NiftiError extends Error {}

const DT_UINT8 = 2, DT_INT16 = 4, DT_INT32 = 8, DT_FLOAT32 = 16,
  DT_FLOAT64 = 64, DT_INT8 = 256, DT_UINT16 = 512, DT_UINT32 = 768,
  DT_RGB24 = 128;

// Bytes per voxel by datatype, used to size and bound allocations from the
// actual file length rather than trusting header dims.
const DT_BYTES = {
  [DT_UINT8]: 1, [DT_INT8]: 1, [DT_INT16]: 2, [DT_UINT16]: 2,
  [DT_INT32]: 4, [DT_UINT32]: 4, [DT_FLOAT32]: 4, [DT_FLOAT64]: 8, [DT_RGB24]: 3,
};

function readTyped(view, off, count, datatype, littleEndian) {
  const out = new Float32Array(count);
  switch (datatype) {
    case DT_UINT8: for (let i = 0; i < count; i++) out[i] = view.getUint8(off + i); break;
    case DT_INT8: for (let i = 0; i < count; i++) out[i] = view.getInt8(off + i); break;
    case DT_INT16: for (let i = 0; i < count; i++) out[i] = view.getInt16(off + i * 2, littleEndian); break;
    case DT_UINT16: for (let i = 0; i < count; i++) out[i] = view.getUint16(off + i * 2, littleEndian); break;
    case DT_INT32: for (let i = 0; i < count; i++) out[i] = view.getInt32(off + i * 4, littleEndian); break;
    case DT_UINT32: for (let i = 0; i < count; i++) out[i] = view.getUint32(off + i * 4, littleEndian); break;
    case DT_FLOAT32: for (let i = 0; i < count; i++) out[i] = view.getFloat32(off + i * 4, littleEndian); break;
    case DT_FLOAT64: for (let i = 0; i < count; i++) out[i] = view.getFloat64(off + i * 8, littleEndian); break;
    default: throw new NiftiError(`Unsupported NIfTI datatype ${datatype}`);
  }
  return out;
}

export async function readNifti(arrayBuffer, name = 'image.nii') {
  const buf = await maybeGunzip(arrayBuffer);
  const view = new DataView(buf);
  if (buf.byteLength < 352) throw new NiftiError('File too small to be a NIfTI-1 image');

  // Endianness from sizeof_hdr (must be 348).
  let littleEndian = true;
  let sizeof = view.getInt32(0, true);
  if (sizeof !== 348) {
    sizeof = view.getInt32(0, false);
    if (sizeof !== 348) throw new NiftiError('Not a NIfTI-1 image (sizeof_hdr != 348)');
    littleEndian = false;
  }

  const dim = [];
  for (let i = 0; i < 8; i++) dim.push(view.getInt16(40 + i * 2, littleEndian));
  const ndim = dim[0];
  const nx = dim[1] || 1, ny = dim[2] || 1, nz = dim[3] || 1, nt = dim[4] || 1;
  if (ndim < 3) throw new NiftiError('NIfTI must have at least 3 dimensions');
  // 4D (e.g. BOLD/DWI series): use the first volume. The 4th axis is the slowest,
  // so the first volume is the leading nx*ny*nz voxels.
  const is4D = nt > 1;

  const datatype = view.getInt16(70, littleEndian);
  const voxOffset = view.getFloat32(108, littleEndian);
  let sclSlope = view.getFloat32(112, littleEndian);
  const sclInter = view.getFloat32(116, littleEndian);
  const sformCode = view.getInt16(254, littleEndian);
  const qformCode = view.getInt16(252, littleEndian);

  // Data offset: never trust header dims for allocation; bound by actual length.
  const dataStart = voxOffset >= 352 ? Math.floor(voxOffset) : 352;
  const nVox = nx * ny * nz;
  const bytesPer = DT_BYTES[datatype];
  if (!bytesPer) throw new NiftiError(`Unsupported NIfTI datatype ${datatype}`);
  if (!Number.isFinite(nVox) || nVox <= 0) throw new NiftiError('Invalid NIfTI dimensions');
  if (dataStart + nVox * bytesPer > buf.byteLength) {
    throw new NiftiError('NIfTI data is shorter than its declared dimensions');
  }

  const affine = readAffine(view, littleEndian, sformCode, qformCode, dim);

  if (datatype === DT_RGB24) {
    if (dataStart + nVox * 3 > buf.byteLength) throw new NiftiError('NIfTI RGB data shorter than declared dims');
    // On-disk order is i-fastest; transpose to [i,j,k] C-order (k fastest).
    const data = new Uint8Array(nVox * 3);
    let disk = dataStart;
    for (let k = 0; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const dst = ((i * ny + j) * nz + k) * 3;
          data[dst] = view.getUint8(disk++);
          data[dst + 1] = view.getUint8(disk++);
          data[dst + 2] = view.getUint8(disk++);
        }
      }
    }
    return makeVolume({ dims: [nx, ny, nz], channels: 3, data, affine, photometric: 'RGB', meta: { source: 'nifti', name } });
  }

  const raw = readTyped(view, dataStart, nVox, datatype, littleEndian);
  if (!Number.isFinite(sclSlope) || sclSlope === 0) sclSlope = 1;
  const useScale = !(sclSlope === 1 && sclInter === 0);

  const data = new Float32Array(nVox);
  // raw is in i-fastest disk order; transpose to [i,j,k] C-order.
  let disk = 0;
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const v = raw[disk++];
        data[(i * ny + j) * nz + k] = useScale ? v * sclSlope + sclInter : v;
      }
    }
  }
  return makeVolume({
    dims: [nx, ny, nz], channels: 1, data, affine, photometric: 'MONOCHROME2',
    meta: { source: 'nifti', name, note: is4D ? `4D series (${nt} volumes); using the first volume` : null },
  });
}

function readAffine(view, le, sformCode, qformCode, dim) {
  if (sformCode > 0) {
    const A = new Float64Array(16);
    for (let c = 0; c < 4; c++) A[0 * 4 + c] = view.getFloat32(280 + c * 4, le);
    for (let c = 0; c < 4; c++) A[1 * 4 + c] = view.getFloat32(296 + c * 4, le);
    for (let c = 0; c < 4; c++) A[2 * 4 + c] = view.getFloat32(312 + c * 4, le);
    A[15] = 1;
    return A;
  }
  if (qformCode > 0) {
    return qformAffine(view, le, dim);
  }
  // Fallback: pixdim scaling.
  const pixdim = [];
  for (let i = 0; i < 8; i++) pixdim.push(view.getFloat32(76 + i * 4, le));
  return Float64Array.from([
    pixdim[1] || 1, 0, 0, 0,
    0, pixdim[2] || 1, 0, 0,
    0, 0, pixdim[3] || 1, 0,
    0, 0, 0, 1,
  ]);
}

function qformAffine(view, le, dim) {
  const b = view.getFloat32(256, le);
  const c = view.getFloat32(260, le);
  const d = view.getFloat32(264, le);
  const qx = view.getFloat32(268, le);
  const qy = view.getFloat32(272, le);
  const qz = view.getFloat32(276, le);
  const pixdim = [];
  for (let i = 0; i < 8; i++) pixdim.push(view.getFloat32(76 + i * 4, le));
  const qfac = pixdim[0] < 0 ? -1 : 1;
  let a = 1 - (b * b + c * c + d * d);
  a = a < 1e-7 ? 0 : Math.sqrt(a);
  const R = [
    a * a + b * b - c * c - d * d, 2 * (b * c - a * d), 2 * (b * d + a * c),
    2 * (b * c + a * d), a * a + c * c - b * b - d * d, 2 * (c * d - a * b),
    2 * (b * d - a * c), 2 * (c * d + a * b), a * a + d * d - c * c - b * b,
  ];
  const sx = pixdim[1], sy = pixdim[2], sz = pixdim[3] * qfac;
  return Float64Array.from([
    R[0] * sx, R[1] * sy, R[2] * sz, qx,
    R[3] * sx, R[4] * sy, R[5] * sz, qy,
    R[6] * sx, R[7] * sy, R[8] * sz, qz,
    0, 0, 0, 1,
  ]);
}
