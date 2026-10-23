// Minimal FreeSurfer MGH/MGZ reader.
//
// MGH is big-endian: a fixed 284-byte header then voxel data (x fastest), with
// an optional RAS footer. .mgz is gzip of .mgh. Produces a canonical Volume in
// [width, height, depth] layout with the affine reconstructed as nibabel does.

import { makeVolume } from '../volume.js';
import { maybeGunzip } from './gzip.js';

export class MgzError extends Error {}

const MRI_UCHAR = 0, MRI_INT = 1, MRI_FLOAT = 3, MRI_SHORT = 4;
const HEADER_BYTES = 284;

export async function readMgz(arrayBuffer, name = 'volume.mgz') {
  const buf = await maybeGunzip(arrayBuffer);
  const view = new DataView(buf);
  if (buf.byteLength < HEADER_BYTES) throw new MgzError('File too small to be an MGH/MGZ image');

  const version = view.getInt32(0, false);
  if (version !== 1) throw new MgzError(`Unsupported MGH version ${version}`);
  const width = view.getInt32(4, false);
  const height = view.getInt32(8, false);
  const depth = view.getInt32(12, false);
  const nframes = view.getInt32(16, false);
  const type = view.getInt32(20, false);
  if (nframes > 1) throw new MgzError('Multi-frame MGH is not supported yet; provide a single-frame volume');

  const nVox = width * height * depth;
  const bytesPer = { [MRI_UCHAR]: 1, [MRI_SHORT]: 2, [MRI_INT]: 4, [MRI_FLOAT]: 4 }[type];
  if (!bytesPer) throw new MgzError(`Unsupported MGH data type ${type}`);
  if (HEADER_BYTES + nVox * bytesPer > buf.byteLength) throw new MgzError('MGH data shorter than declared dims');

  // Affine from the RAS footer if present, else default.
  const affine = readMghAffine(view, width, height, depth);

  const readVoxel = (off) => {
    switch (type) {
      case MRI_UCHAR: return view.getUint8(off);
      case MRI_SHORT: return view.getInt16(off, false);
      case MRI_INT: return view.getInt32(off, false);
      case MRI_FLOAT: return view.getFloat32(off, false);
      default: return 0;
    }
  };

  const data = new Float32Array(nVox);
  // On-disk order is x fastest: index = (z*height + y)*width + x. Store at the
  // canonical [x,y,z] C-order index ((x*height + y)*depth + z).
  let disk = HEADER_BYTES;
  for (let z = 0; z < depth; z++) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        data[(x * height + y) * depth + z] = readVoxel(disk);
        disk += bytesPer;
      }
    }
  }

  return makeVolume({
    dims: [width, height, depth],
    channels: 1,
    data,
    affine,
    photometric: 'MONOCHROME2',
    meta: { source: 'mgz', name },
  });
}

function readMghAffine(view, width, height, depth) {
  // Header is seven int32 (offsets 0..27), then goodRASFlag (int16 at 28). If it
  // is positive the RAS block follows at offset 30: delta[3], Mdc[9], Pxyz_c[3].
  const goodRAS = view.getInt16(28, false);
  if (goodRAS <= 0) {
    return Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  }
  let off = 30;
  const f = () => { const v = view.getFloat32(off, false); off += 4; return v; };
  const sx = f(), sy = f(), sz = f();
  // Mdc columns are x_ras, y_ras, z_ras (each r,a,s).
  const xr = f(), xa = f(), xs = f();
  const yr = f(), ya = f(), ys = f();
  const zr = f(), za = f(), zs = f();
  const cr = f(), ca = f(), cs = f();

  // M columns scaled by voxel size.
  const m = [
    xr * sx, yr * sy, zr * sz,
    xa * sx, ya * sy, za * sz,
    xs * sx, ys * sy, zs * sz,
  ];
  const pc = [width / 2, height / 2, depth / 2];
  const tx = cr - (m[0] * pc[0] + m[1] * pc[1] + m[2] * pc[2]);
  const ty = ca - (m[3] * pc[0] + m[4] * pc[1] + m[5] * pc[2]);
  const tz = cs - (m[6] * pc[0] + m[7] * pc[1] + m[8] * pc[2]);
  return Float64Array.from([
    m[0], m[1], m[2], tx,
    m[3], m[4], m[5], ty,
    m[6], m[7], m[8], tz,
    0, 0, 0, 1,
  ]);
}
