// A small synthetic subject for the SyN-SDC pipeline tests: a 2 mm RAS "T1w" (an ellipsoid head
// with brighter white matter, int16) and a 8-volume 3 mm LAS DWI series of the same head, its
// b0 volumes stretched along j as a susceptibility field would, with brain masks on both grids.
import { gzipSync } from 'node:zlib';

function nifti({ dims, frames = 1, affine, datatype, values }) {
  const bytesPer = { 2: 1, 4: 2, 16: 4 }[datatype];
  const voxels = dims[0] * dims[1] * dims[2] * frames;
  const bytes = new Uint8Array(352 + voxels * bytesPer);
  const view = new DataView(bytes.buffer);
  view.setInt32(0, 348, true);
  view.setInt16(40, frames > 1 ? 4 : 3, true);
  [...dims, frames].forEach((n, i) => view.setInt16(42 + 2 * i, n, true));
  view.setInt16(70, datatype, true);
  view.setInt16(72, bytesPer * 8, true);
  view.setFloat32(76, 1, true);
  for (let i = 0; i < 3; i++) view.setFloat32(80 + 4 * i, Math.abs(affine[i][i]), true);
  view.setFloat32(108, 352, true);
  view.setFloat32(112, 1, true);
  view.setUint8(123, 10);
  // sform only (qform_code 0), as sdcflows writes its own images.
  view.setInt16(254, 1, true);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 4; j++) view.setFloat32(280 + 16 * i + 4 * j, affine[i][j], true);
  bytes.set([0x6e, 0x2b, 0x31, 0], 344);
  for (let i = 0; i < voxels; i++) {
    if (datatype === 2) view.setUint8(352 + i, values[i]);
    else if (datatype === 4) view.setInt16(352 + 2 * i, values[i], true);
    else view.setFloat32(352 + 4 * i, values[i], true);
  }
  return bytes;
}

/** Intensity of the head at world point (x, y, z) mm: 0 outside, brain 600-1000, "skull" 300. */
function head(x, y, z) {
  const r = Math.hypot(x / 34, (y - 4) / 40, (z - 6) / 30);
  if (r > 1) return 0;
  if (r > 0.86) return 300;
  const inner = Math.hypot(x / 14, (y - 4) / 18, (z - 6) / 12);
  return inner < 1 ? 1000 : 600 + 80 * Math.sin(x / 6) * Math.cos(y / 7);
}
const brain = (x, y, z) => Math.hypot(x / 34, (y - 4) / 40, (z - 6) / 30) <= 0.86;

export function synthetic() {
  const t1Dims = [40, 48, 40];
  const t1Affine = [[2, 0, 0, -39], [0, 2, 0, -43], [0, 0, 2, -33], [0, 0, 0, 1]];
  const t1 = new Int16Array(t1Dims[0] * t1Dims[1] * t1Dims[2]);
  const t1Mask = new Uint8Array(t1.length);
  for (let k = 0; k < t1Dims[2]; k++) for (let j = 0; j < t1Dims[1]; j++) for (let i = 0; i < t1Dims[0]; i++) {
    const [x, y, z] = [2 * i - 39, 2 * j - 43, 2 * k - 33];
    const index = i + t1Dims[0] * (j + t1Dims[1] * k);
    t1[index] = Math.round(head(x, y, z));
    t1Mask[index] = brain(x, y, z) ? 1 : 0;
  }
  const dims = [26, 30, 22];
  const affine = [[-3, 0, 0, 39], [0, 3, 0, -43], [0, 0, 3, -30], [0, 0, 0, 1]];
  const bvals = [0, 1000, 1000, 1000, 0, 1000, 1000, 1000];
  const frames = bvals.length;
  const voxels = dims[0] * dims[1] * dims[2];
  const dwi = new Int16Array(voxels * frames);
  const mask = new Uint8Array(voxels);
  for (let k = 0; k < dims[2]; k++) for (let j = 0; j < dims[1]; j++) for (let i = 0; i < dims[0]; i++) {
    const [x, y, z] = [39 - 3 * i, 3 * j - 43, 3 * k - 30];
    const index = i + dims[0] * (j + dims[1] * k);
    // A smooth shift along y (the PE axis), largest at the front of the head.
    const shift = 4 * Math.exp(-((y - 25) ** 2 + z ** 2) / 400);
    const value = head(x, y - shift, z);
    mask[index] = brain(x, y, z) ? 1 : 0;
    for (let t = 0; t < frames; t++) dwi[t * voxels + index] = Math.round(bvals[t] ? value * 0.3 + 20 * Math.cos(t + x / 9) : (1800 - value) * (value > 0 ? 1 : 0));
  }
  return {
    dwi: gzipSync(nifti({ dims, frames, affine, datatype: 4, values: dwi })),
    bval: `${bvals.join(' ')}\n`,
    bvec: '0 1 0 0 0 0.7071 0.7071 0\n0 0 1 0 0 0.7071 0 0.7071\n0 0 0 1 0 0 0.7071 0.7071\n',
    sidecar: { PhaseEncodingDirection: 'j-', TotalReadoutTime: 0.03 },
    epiMask: gzipSync(nifti({ dims, affine, datatype: 2, values: mask })),
    t1w: gzipSync(nifti({ dims: t1Dims, affine: t1Affine, datatype: 4, values: t1 })),
    t1wMask: gzipSync(nifti({ dims: t1Dims, affine: t1Affine, datatype: 2, values: t1Mask })),
    dims,
    frames,
  };
}
