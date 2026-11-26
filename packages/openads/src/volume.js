// Pure NIfTI-1 3D/4D volume I/O, RAS canonical reorientation, DWI/b0 ADC calculation,
// normalization, padding, and binary mask morphology for OpenADS.

const HEADER_SIZE = 348;
const VOX_OFFSET = 352;
const DT_UINT8 = 2;
const DT_INT16 = 4;
const DT_INT32 = 8;
const DT_FLOAT32 = 16;
const DT_FLOAT64 = 64;
const DT_UINT16 = 512;

export const voxelCount = (dims) => dims[0] * dims[1] * dims[2];

export async function gunzipIfNeeded(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.length >= 2 && u8[0] === 0x1f && u8[1] === 0x8b) {
    const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return u8;
}

export async function gzipBytes(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const stream = new Blob([u8]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function readTypedVoxel(view, offset, datatype, littleEndian) {
  switch (datatype) {
    case DT_UINT8:
      return [view.getUint8(offset), 1];
    case DT_INT16:
      return [view.getInt16(offset, littleEndian), 2];
    case DT_INT32:
      return [view.getInt32(offset, littleEndian), 4];
    case DT_FLOAT32:
      return [view.getFloat32(offset, littleEndian), 4];
    case DT_FLOAT64:
      return [view.getFloat64(offset, littleEndian), 8];
    case DT_UINT16:
      return [view.getUint16(offset, littleEndian), 2];
    default:
      throw new Error(`Unsupported NIfTI datatype: ${datatype}`);
  }
}

function readAffine(view, pixdim, littleEndian) {
  const affine = new Float32Array(16);
  affine[15] = 1;
  if (view.getInt16(254, littleEndian) > 0) {
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 4; c++) {
        affine[r * 4 + c] = view.getFloat32(280 + r * 16 + c * 4, littleEndian);
      }
    }
  } else {
    affine[0] = pixdim[0] || 1;
    affine[5] = pixdim[1] || 1;
    affine[10] = pixdim[2] || 1;
  }
  return affine;
}

export function readNifti(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const le = view.getInt32(0, true) === HEADER_SIZE;
  if (!le && view.getInt32(0, false) !== HEADER_SIZE) {
    throw new Error('Not a valid NIfTI-1 volume (invalid header size).');
  }
  const dims = [view.getInt16(42, le), view.getInt16(44, le), view.getInt16(46, le)];
  const pixdim = [view.getFloat32(80, le), view.getFloat32(84, le), view.getFloat32(88, le)];
  const datatype = view.getInt16(70, le);
  const voxOffset = view.getFloat32(108, le) || VOX_OFFSET;
  let slope = view.getFloat32(112, le);
  const inter = view.getFloat32(116, le);
  if (slope === 0 || !Number.isFinite(slope)) slope = 1;

  const n = voxelCount(dims);
  const voxels = new Float32Array(n);
  let cursor = voxOffset;
  for (let i = 0; i < n; i++) {
    const [val, step] = readTypedVoxel(view, cursor, datatype, le);
    cursor += step;
    voxels[i] = val * slope + inter;
  }
  const affine = readAffine(view, pixdim, le);
  return { dims, pixdim, voxels, affine, datatype };
}

export function readNifti4D(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const le = view.getInt32(0, true) === HEADER_SIZE;
  if (!le && view.getInt32(0, false) !== HEADER_SIZE) {
    throw new Error('Not a valid NIfTI-1 volume (invalid header size).');
  }
  const nx = view.getInt16(42, le);
  const ny = view.getInt16(44, le);
  const nz = view.getInt16(46, le);
  const nt = Math.max(1, view.getInt16(48, le));
  const dims = [nx, ny, nz, nt];
  const pixdim = [
    view.getFloat32(80, le),
    view.getFloat32(84, le),
    view.getFloat32(88, le),
    view.getFloat32(92, le),
  ];
  const datatype = view.getInt16(70, le);
  const voxOffset = view.getFloat32(108, le) || VOX_OFFSET;
  let slope = view.getFloat32(112, le);
  const inter = view.getFloat32(116, le);
  if (slope === 0 || !Number.isFinite(slope)) slope = 1;

  const total = nx * ny * nz * nt;
  const voxels = new Float32Array(total);
  let cursor = voxOffset;
  for (let i = 0; i < total; i++) {
    const [val, step] = readTypedVoxel(view, cursor, datatype, le);
    cursor += step;
    voxels[i] = val * slope + inter;
  }
  const affine = readAffine(view, pixdim, le);
  return { dims, pixdim, voxels, affine, datatype };
}

export function writeNiftiFloat32(vol) {
  const [nx, ny, nz] = vol.dims;
  const voxels = vol.voxels instanceof Float32Array ? vol.voxels : Float32Array.from(vol.voxels);
  const buf = new ArrayBuffer(VOX_OFFSET + voxels.byteLength);
  const view = new DataView(buf);
  const le = true;
  view.setInt32(0, HEADER_SIZE, le);
  view.setInt16(40, 3, le);
  view.setInt16(42, nx, le);
  view.setInt16(44, ny, le);
  view.setInt16(46, nz, le);
  for (let k = 4; k <= 7; k++) {
    view.setInt16(40 + k * 2, 1, le);
  }
  view.setInt16(70, DT_FLOAT32, le);
  view.setInt16(72, 32, le);
  view.setFloat32(76, 1, le);
  view.setFloat32(80, vol.pixdim[0], le);
  view.setFloat32(84, vol.pixdim[1], le);
  view.setFloat32(88, vol.pixdim[2], le);
  view.setFloat32(108, VOX_OFFSET, le);
  view.setFloat32(112, 1, le);
  view.setInt8(123, 66);
  view.setInt16(252, 1, le);
  view.setInt16(254, 1, le);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) {
      view.setFloat32(280 + r * 16 + c * 4, vol.affine[r * 4 + c], le);
    }
  }
  new Uint8Array(buf, 344, 4).set([0x6e, 0x2b, 0x31, 0x00]);
  new Uint8Array(buf, VOX_OFFSET).set(new Uint8Array(voxels.buffer, voxels.byteOffset, voxels.byteLength));
  return new Uint8Array(buf);
}

export async function writeNiftiGz(vol) {
  return gzipBytes(writeNiftiFloat32(vol));
}

const OPPOSITE_AXIS = { R: 'L', L: 'R', A: 'P', P: 'A', S: 'I', I: 'S' };
const AXIS_GROUP = { L: 0, R: 0, P: 1, A: 1, I: 2, S: 2 };
const RAS = ['R', 'A', 'S'];

export function affineToAxCodes(affine) {
  const codes = [];
  const used = new Set();
  for (let col = 0; col < 3; col++) {
    let bestRow = 0;
    let bestAbs = -1;
    for (let row = 0; row < 3; row++) {
      const mag = Math.abs(affine[row * 4 + col]);
      if (mag > bestAbs && !used.has(row)) {
        bestAbs = mag;
        bestRow = row;
      }
    }
    used.add(bestRow);
    const positive = affine[bestRow * 4 + col] >= 0;
    const base = RAS[bestRow];
    codes.push(positive ? base : OPPOSITE_AXIS[base]);
  }
  return codes;
}

function axisMapping(fromCodes, toCodes) {
  const srcAxis = [];
  const flip = [];
  for (let i = 0; i < 3; i++) {
    const target = toCodes[i];
    const found = fromCodes.findIndex((c) => AXIS_GROUP[c] === AXIS_GROUP[target]);
    if (found < 0) {
      throw new Error(`Cannot map orientation ${fromCodes.join('')} to ${toCodes.join('')}.`);
    }
    srcAxis.push(found);
    flip.push(fromCodes[found] !== target);
  }
  return { srcAxis, flip };
}

function reorientArray3D(voxels, dims, fromCodes, toCodes) {
  const { srcAxis, flip } = axisMapping(fromCodes, toCodes);
  const outDims = [dims[srcAxis[0]], dims[srcAxis[1]], dims[srcAxis[2]]];
  const out = new Float32Array(voxelCount(outDims));
  const strides = [1, dims[0], dims[0] * dims[1]];
  const srcIdx = [0, 0, 0];
  for (let z = 0; z < outDims[2]; z++) {
    for (let y = 0; y < outDims[1]; y++) {
      for (let x = 0; x < outDims[0]; x++) {
        const dst = [x, y, z];
        let flat = 0;
        for (let a = 0; a < 3; a++) {
          const sa = srcAxis[a];
          srcIdx[sa] = flip[a] ? dims[sa] - 1 - dst[a] : dst[a];
          flat += srcIdx[sa] * strides[sa];
        }
        out[x + y * outDims[0] + z * outDims[0] * outDims[1]] = voxels[flat];
      }
    }
  }
  return { data: out, dims: outDims };
}

function reorientAffine(affine, dims, fromCodes, toCodes) {
  const { srcAxis, flip } = axisMapping(fromCodes, toCodes);
  const out = new Float32Array(16);
  for (let c = 0; c < 3; c++) {
    const sa = srcAxis[c];
    const sign = flip[c] ? -1 : 1;
    for (let r = 0; r < 3; r++) {
      out[r * 4 + c] = affine[r * 4 + sa] * sign;
    }
  }
  const shift = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const sa = srcAxis[c];
    shift[sa] = flip[c] ? dims[sa] - 1 : 0;
  }
  for (let r = 0; r < 3; r++) {
    out[r * 4 + 3] =
      affine[r * 4 + 0] * shift[0] +
      affine[r * 4 + 1] * shift[1] +
      affine[r * 4 + 2] * shift[2] +
      affine[r * 4 + 3];
  }
  out[15] = 1;
  return out;
}

export function reorientVolumeToRAS(vol) {
  const codes = affineToAxCodes(vol.affine);
  if (codes[0] === 'R' && codes[1] === 'A' && codes[2] === 'S') {
    return vol;
  }
  const { srcAxis } = axisMapping(codes, RAS);
  const { data, dims } = reorientArray3D(vol.voxels, vol.dims, codes, RAS);
  const pixdim = [vol.pixdim[srcAxis[0]], vol.pixdim[srcAxis[1]], vol.pixdim[srcAxis[2]]];
  const affine = reorientAffine(vol.affine, vol.dims, codes, RAS);
  return { dims, pixdim, voxels: data, affine, datatype: vol.datatype };
}

export function reorientVolume4DToRAS(vol) {
  const codes = affineToAxCodes(vol.affine);
  const [nx, ny, nz, nt] = vol.dims;
  if (codes[0] === 'R' && codes[1] === 'A' && codes[2] === 'S') {
    return vol;
  }
  const frameLen = nx * ny * nz;
  let outDims3 = [nx, ny, nz];
  let outVoxels = null;
  for (let t = 0; t < nt; t++) {
    const frame = vol.voxels.subarray(t * frameLen, (t + 1) * frameLen);
    const res = reorientArray3D(frame, [nx, ny, nz], codes, RAS);
    if (!outVoxels) {
      outDims3 = res.dims;
      outVoxels = new Float32Array(voxelCount(outDims3) * nt);
    }
    outVoxels.set(res.data, t * res.data.length);
  }
  const { srcAxis } = axisMapping(codes, RAS);
  const pixdim = [vol.pixdim[srcAxis[0]], vol.pixdim[srcAxis[1]], vol.pixdim[srcAxis[2]], vol.pixdim[3]];
  const affine = reorientAffine(vol.affine, [nx, ny, nz], codes, RAS);
  return {
    dims: [outDims3[0], outDims3[1], outDims3[2], nt],
    pixdim,
    voxels: outVoxels,
    affine,
    datatype: vol.datatype,
  };
}

export function extractFrame3D(vol4d, frameIndex) {
  const [nx, ny, nz] = vol4d.dims;
  const frameLen = nx * ny * nz;
  return {
    dims: [nx, ny, nz],
    pixdim: [vol4d.pixdim[0], vol4d.pixdim[1], vol4d.pixdim[2]],
    voxels: vol4d.voxels.slice(frameIndex * frameLen, (frameIndex + 1) * frameLen),
    affine: vol4d.affine.slice(),
    datatype: vol4d.datatype,
  };
}

export async function loadNiftiBytes(bytes) {
  const raw = await gunzipIfNeeded(bytes);
  return reorientVolumeToRAS(readNifti(raw));
}

export async function loadNifti4DBytes(bytes) {
  const raw = await gunzipIfNeeded(bytes);
  return reorientVolume4DToRAS(readNifti4D(raw));
}

export function maskVolume(vol, mask) {
  const voxels = new Float32Array(vol.voxels.length);
  for (let i = 0; i < voxels.length; i++) {
    voxels[i] = mask[i] ? vol.voxels[i] : 0;
  }
  return { ...vol, voxels };
}

export function fToC(data, dims) {
  const [nx, ny, nz] = dims;
  const out = new Float32Array(data.length);
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        out[(x * ny + y) * nz + z] = data[x + y * nx + z * nx * ny];
      }
    }
  }
  return out;
}

export function cToF(data, dims) {
  const [nx, ny, nz] = dims;
  const out = new Float32Array(data.length);
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        out[x + y * nx + z * nx * ny] = data[(x * ny + y) * nz + z];
      }
    }
  }
  return out;
}

export function centerPad(data, dims, target) {
  const out = new Float32Array(voxelCount(target));
  const offsets = [0, 1, 2].map((i) => Math.floor((target[i] - dims[i]) / 2));
  for (let z = 0; z < dims[2]; z++) {
    const tz = z + offsets[2];
    if (tz < 0 || tz >= target[2]) continue;
    for (let y = 0; y < dims[1]; y++) {
      const ty = y + offsets[1];
      if (ty < 0 || ty >= target[1]) continue;
      for (let x = 0; x < dims[0]; x++) {
        const tx = x + offsets[0];
        if (tx < 0 || tx >= target[0]) continue;
        out[tx + ty * target[0] + tz * target[0] * target[1]] =
          data[x + y * dims[0] + z * dims[0] * dims[1]];
      }
    }
  }
  return { data: out, offsets };
}

export function uncenterPad(padded, target, dims, offsets, make = (n) => new Float32Array(n)) {
  const out = make(voxelCount(dims));
  for (let z = 0; z < dims[2]; z++) {
    const sz = z + offsets[2];
    if (sz < 0 || sz >= target[2]) continue;
    for (let y = 0; y < dims[1]; y++) {
      const sy = y + offsets[1];
      if (sy < 0 || sy >= target[1]) continue;
      for (let x = 0; x < dims[0]; x++) {
        const sx = x + offsets[0];
        if (sx < 0 || sx >= target[0]) continue;
        out[x + y * dims[0] + z * dims[0] * dims[1]] =
          padded[sx + sy * target[0] + sz * target[0] * target[1]];
      }
    }
  }
  return out;
}

function percentileOfSorted(sorted, p) {
  const n = sorted.length;
  if (n === 0) return 0;
  if (n === 1) return sorted[0];
  const idx = (p / 100) * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export function percentileClipRescaleInMask(data, mask, pLow = 1, pHigh = 99) {
  let nonNegCount = 0;
  for (let i = 0; i < data.length; i++) {
    if (mask[i] && data[i] >= 0) nonNegCount++;
  }
  const sorted = new Float32Array(nonNegCount);
  let k = 0;
  for (let i = 0; i < data.length; i++) {
    if (mask[i] && data[i] >= 0) sorted[k++] = data[i];
  }
  sorted.sort();
  const lower = percentileOfSorted(sorted, pLow);
  const upper = percentileOfSorted(sorted, pHigh);
  const range = upper - lower;
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) {
    if (!mask[i]) continue;
    let v = data[i];
    if (v < lower) v = lower;
    if (v > upper) v = upper;
    out[i] = range > 0 ? (v - lower) / range : 0;
  }
  return out;
}

export function zscoreInMask(data, mask, eps = 1e-6) {
  let count = 0;
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    if (mask[i]) {
      sum += data[i];
      count++;
    }
  }
  let mean;
  let std;
  if (count >= 10) {
    mean = sum / count;
    let ss = 0;
    for (let i = 0; i < data.length; i++) {
      if (mask[i]) {
        const d = data[i] - mean;
        ss += d * d;
      }
    }
    std = Math.sqrt(ss / count);
  } else {
    let s = 0;
    for (let i = 0; i < data.length; i++) s += data[i];
    mean = data.length ? s / data.length : 0;
    let ss = 0;
    for (let i = 0; i < data.length; i++) {
      const d = data[i] - mean;
      ss += d * d;
    }
    std = data.length ? Math.sqrt(ss / data.length) : 1;
  }
  const denom = std > eps ? std : eps;
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) {
    out[i] = (data[i] - mean) / denom;
  }
  return out;
}

export function removeSmallObjects(mask, dims, minSize) {
  const [nx, ny, nz] = dims;
  const n = nx * ny * nz;
  const label = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  const sizes = [];
  let current = 0;
  for (let s = 0; s < n; s++) {
    if (mask[s] === 0 || label[s] !== -1) continue;
    let top = 0;
    stack[top++] = s;
    label[s] = current;
    let size = 0;
    while (top > 0) {
      const p = stack[--top];
      size++;
      const x = p % nx;
      const y = ((p / nx) | 0) % ny;
      const z = (p / (nx * ny)) | 0;
      if (x > 0 && mask[p - 1] && label[p - 1] === -1) {
        label[p - 1] = current;
        stack[top++] = p - 1;
      }
      if (x < nx - 1 && mask[p + 1] && label[p + 1] === -1) {
        label[p + 1] = current;
        stack[top++] = p + 1;
      }
      if (y > 0 && mask[p - nx] && label[p - nx] === -1) {
        label[p - nx] = current;
        stack[top++] = p - nx;
      }
      if (y < ny - 1 && mask[p + nx] && label[p + nx] === -1) {
        label[p + nx] = current;
        stack[top++] = p + nx;
      }
      if (z > 0 && mask[p - nx * ny] && label[p - nx * ny] === -1) {
        label[p - nx * ny] = current;
        stack[top++] = p - nx * ny;
      }
      if (z < nz - 1 && mask[p + nx * ny] && label[p + nx * ny] === -1) {
        label[p + nx * ny] = current;
        stack[top++] = p + nx * ny;
      }
    }
    sizes[current] = size;
    current++;
  }
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const l = label[i];
    out[i] = l >= 0 && sizes[l] >= minSize ? 1 : 0;
  }
  return out;
}

export function binaryClosing2x2x2(mask, dims) {
  const [nx, ny, nz] = dims;
  const at = (a, x, y, z) =>
    x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz ? 0 : a[x + y * nx + z * nx * ny];
  const dilated = new Uint8Array(nx * ny * nz);
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        let v = 0;
        for (let dz = -1; dz <= 0 && !v; dz++) {
          for (let dy = -1; dy <= 0 && !v; dy++) {
            for (let dx = -1; dx <= 0 && !v; dx++) {
              if (at(mask, x + dx, y + dy, z + dz)) v = 1;
            }
          }
        }
        dilated[x + y * nx + z * nx * ny] = v;
      }
    }
  }
  const out = new Uint8Array(nx * ny * nz);
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        let v = 1;
        for (let dz = 0; dz <= 1 && v; dz++) {
          for (let dy = 0; dy <= 1 && v; dy++) {
            for (let dx = 0; dx <= 1 && v; dx++) {
              if (!at(dilated, x + dx, y + dy, z + dz)) v = 0;
            }
          }
        }
        out[x + y * nx + z * nx * ny] = v;
      }
    }
  }
  return out;
}

export function binaryFillHoles(mask, dims) {
  const [nx, ny, nz] = dims;
  const n = nx * ny * nz;
  const idx = (x, y, z) => x + y * nx + z * nx * ny;
  const outside = new Uint8Array(n);
  const stack = new Int32Array(n);
  let top = 0;
  const push = (p) => {
    if (!mask[p] && !outside[p]) {
      outside[p] = 1;
      stack[top++] = p;
    }
  };
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        if (x === 0 || y === 0 || z === 0 || x === nx - 1 || y === ny - 1 || z === nz - 1) {
          push(idx(x, y, z));
        }
      }
    }
  }
  while (top > 0) {
    const p = stack[--top];
    const x = p % nx;
    const y = ((p / nx) | 0) % ny;
    const z = (p / (nx * ny)) | 0;
    if (x > 0) push(p - 1);
    if (x < nx - 1) push(p + 1);
    if (y > 0) push(p - nx);
    if (y < ny - 1) push(p + nx);
    if (z > 0) push(p - nx * ny);
    if (z < nz - 1) push(p + nx * ny);
  }
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = mask[i] || !outside[i] ? 1 : 0;
  }
  return out;
}

export function dagmnetPostprocess(mask, dims, minSize = 50) {
  const closed = binaryClosing2x2x2(mask, dims);
  const filled = binaryFillHoles(closed, dims);
  return removeSmallObjects(filled, dims, minSize);
}

// Compute ADC from DWI and b0 using OpenADS ADCCalculator formula: -ln((DWI+eps)/(b0+eps))/bvalue.
// Automatically detects if the two volumes were supplied in swapped (b0, DWI) order when combined in 4D.
function medianNonZero(arr) {
  const vals = [];
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] > 0) vals.push(arr[i]);
  }
  if (!vals.length) return 0;
  vals.sort((a, b) => a - b);
  return vals[vals.length >> 1];
}

export function detectSwappedDwiB0(volA, volB) {
  // b0 typically has substantially higher median signal intensity than b=1000 DWI.
  const medA = medianNonZero(volA);
  const medB = medianNonZero(volB);
  return medA > medB * 1.1;
}

export function computeAdcVoxels(dwiVoxels, b0Voxels, bvalue = 1000, eps = 1e-10) {
  const n = dwiVoxels.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const d = dwiVoxels[i];
    const b = b0Voxels[i];
    if (b > 0 && d > 0) {
      out[i] = -Math.log((d + eps) / (b + eps)) / bvalue;
    }
  }
  return out;
}

export function prepareDwiAdc({ dwi, b0 = null, adc = null, bvalue = 1000, checkSwap = false }) {
  if (adc) {
    return { dwi, adc, b0, adcWasComputed: false, orderWasSwapped: false };
  }
  if (!b0) {
    throw new Error('Provide an ADC image or a b0 volume alongside DWI so ADC can be computed.');
  }
  let dwiVol = dwi;
  let b0Vol = b0;
  let orderWasSwapped = false;
  if (checkSwap && detectSwappedDwiB0(dwi.voxels, b0.voxels)) {
    orderWasSwapped = true;
    dwiVol = b0;
    b0Vol = dwi;
  }
  const adcVoxels = computeAdcVoxels(dwiVol.voxels, b0Vol.voxels, bvalue);
  return {
    dwi: dwiVol,
    adc: { ...dwiVol, voxels: adcVoxels },
    b0: b0Vol,
    adcWasComputed: true,
    orderWasSwapped,
  };
}
