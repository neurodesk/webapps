// Bounded 3D binary NIfTI mask I/O, spatial-affine validation, typed-array
// 6-connected interior hole filling, and sparse 26-connected component filtering.
import {
  parseNiftiVolumeHeader,
} from '@neurodesk/webapp-components/file-io/nifti-volume';

function isGzipBytes(bytes) {
  return bytes.byteLength >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

export const MAX_VOXELS = 64 * 1024 * 1024; // 2^26 voxels (512 x 512 x 256)
export const MAX_DECOMPRESSED_BYTES = 512 * 1024 * 1024;
const MAX_AFFINE_SHEAR_COS = 0.05;

function toUint8(bufferLike) {
  if (bufferLike instanceof Uint8Array) {
    return bufferLike;
  }
  if (ArrayBuffer.isView(bufferLike)) {
    return new Uint8Array(bufferLike.buffer, bufferLike.byteOffset, bufferLike.byteLength);
  }
  if (bufferLike instanceof ArrayBuffer) {
    return new Uint8Array(bufferLike);
  }
  throw new TypeError('Expected an ArrayBuffer or TypedArray for NIfTI input.');
}

/**
 * Decompresses gzipped bytes with an explicit upper bound on decoded byte length.
 * Works identically in modern browsers and Node >= 22 via DecompressionStream.
 */
export async function gunzipBytes(bytes, maxOutputBytes = MAX_DECOMPRESSED_BYTES) {
  const input = toUint8(bytes);
  if (!isGzipBytes(input)) {
    return input;
  }
  const stream = new Blob([input]).stream().pipeThrough(new DecompressionStream('gzip'));
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxOutputBytes) {
        await reader.cancel();
        throw new Error(`Decompressed NIfTI exceeds the ${Math.round(maxOutputBytes / (1024 * 1024))} MiB limit.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Compresses bytes to gzip using CompressionStream (browser and Node >= 22).
 */
export async function gzipBytes(bytes) {
  const input = toUint8(bytes);
  const stream = new Blob([input]).stream().pipeThrough(new CompressionStream('gzip'));
  const response = new Response(stream);
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Returns the spatial scale factor to convert NIfTI header coordinates to mm.
 */
export function spatialUnitsToMm(xyztUnits) {
  const code = (xyztUnits ?? 0) & 0x07;
  if (code === 1) {
    return { scale: 1000, unitName: 'm', assumedMm: false };
  }
  if (code === 2) {
    return { scale: 1, unitName: 'mm', assumedMm: false };
  }
  if (code === 3) {
    return { scale: 0.001, unitName: 'um', assumedMm: false };
  }
  return { scale: 1, unitName: 'unknown', assumedMm: true };
}

/**
 * Validates the 4x4 affine matrix and derives physical voxel spacings in mm,
 * orthogonality checks, and voxel volume in mm^3.
 *
 * When `alreadyInMm` is true (as returned by `parseNiftiVolumeHeader`, which
 * already multiplies the header affine by the spatial xyzt_units factor),
 * `affine` is kept in mm without double-scaling and `rawAffine` recovers the
 * native header-unit affine.
 */
export function inspectAffine(affine, xyztUnits, { alreadyInMm = false } = {}) {
  const { scale, unitName, assumedMm } = spatialUnitsToMm(xyztUnits);
  const scaledAffine = alreadyInMm
    ? affine.map((row) => [...row])
    : affine.map((row, r) => (r < 3 ? row.map((v) => v * scale) : [...row]));
  const rawAffine = alreadyInMm
    ? affine.map((row, r) => (r < 3 ? row.map((v) => v / scale) : [...row]))
    : affine.map((row) => [...row]);
  const cols = [0, 1, 2].map((c) => [
    scaledAffine[0][c],
    scaledAffine[1][c],
    scaledAffine[2][c],
  ]);
  const spacing = cols.map((col) => Math.hypot(col[0], col[1], col[2]));
  for (let axis = 0; axis < 3; axis += 1) {
    if (!Number.isFinite(spacing[axis]) || spacing[axis] <= 0) {
      throw new Error(`Invalid NIfTI voxel spacing on axis ${axis}: ${spacing[axis]}.`);
    }
  }
  const det =
    cols[0][0] * (cols[1][1] * cols[2][2] - cols[1][2] * cols[2][1]) -
    cols[1][0] * (cols[0][1] * cols[2][2] - cols[0][2] * cols[2][1]) +
    cols[2][0] * (cols[0][1] * cols[1][2] - cols[0][2] * cols[1][1]);
  if (!Number.isFinite(det) || Math.abs(det) <= 1e-12) {
    throw new Error('NIfTI affine matrix is singular; physical vessel measurements require a valid 3D transform.');
  }
  for (let a = 0; a < 3; a += 1) {
    for (let b = a + 1; b < 3; b += 1) {
      const dot = cols[a][0] * cols[b][0] + cols[a][1] * cols[b][1] + cols[a][2] * cols[b][2];
      const cos = Math.abs(dot) / (spacing[a] * spacing[b]);
      if (cos > MAX_AFFINE_SHEAR_COS) {
        throw new Error(
          `NIfTI affine has material shear (cos=${cos.toFixed(3)} between axes ${a} and ${b}); resample onto an orthogonal grid first.`,
        );
      }
    }
  }
  const minSpacing = Math.min(spacing[0], spacing[1], spacing[2]);
  const maxSpacing = Math.max(spacing[0], spacing[1], spacing[2]);
  return {
    affine: scaledAffine,
    rawAffine,
    spacing,
    voxelVolumeMm3: Math.abs(det),
    anisotropyRatio: maxSpacing / minSpacing,
    unitName,
    unitScaleToMm: scale,
    assumedMm,
  };
}

export function voxelToWorld(affine, x, y, z) {
  return [
    affine[0][0] * x + affine[0][1] * y + affine[0][2] * z + affine[0][3],
    affine[1][0] * x + affine[1][1] * y + affine[1][2] * z + affine[1][3],
    affine[2][0] * x + affine[2][1] * y + affine[2][2] * z + affine[2][3],
  ];
}

function decodeMaskVoxels(bytes, header, threshold) {
  const [nx, ny, nz] = [header.dims[1], header.dims[2], header.dims[3]];
  const total = nx * ny * nz;
  const bytesPerVoxel = header.bitpix / 8;
  const offset = Math.trunc(header.voxOffset);
  if (!Number.isInteger(bytesPerVoxel) || bytesPerVoxel <= 0) {
    throw new Error(`Unsupported NIfTI bitpix=${header.bitpix}.`);
  }
  if (offset < 0 || offset + total * bytesPerVoxel > bytes.byteLength) {
    throw new Error('NIfTI file is truncated before the end of the 3D voxel payload.');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, total * bytesPerVoxel);
  const le = header.littleEndian;
  const slope = Number.isFinite(header.sclSlope) && header.sclSlope !== 0 ? header.sclSlope : 1;
  const inter = Number.isFinite(header.sclSlope) && header.sclSlope !== 0 && Number.isFinite(header.sclInter)
    ? header.sclInter
    : 0;
  const mask = new Uint8Array(total);
  let foregroundCount = 0;

  if (header.datatype === 2 && slope === 1 && inter === 0) {
    const raw = bytes.subarray(offset, offset + total);
    for (let i = 0; i < total; i += 1) {
      if (raw[i] > threshold) {
        mask[i] = 1;
        foregroundCount += 1;
      }
    }
    return { mask, foregroundCount };
  }

  let readValue;
  switch (header.datatype) {
    case 2:
      readValue = (i) => view.getUint8(i);
      break;
    case 4:
      readValue = (i) => view.getInt16(i * 2, le);
      break;
    case 8:
      readValue = (i) => view.getInt32(i * 4, le);
      break;
    case 16:
      readValue = (i) => view.getFloat32(i * 4, le);
      break;
    case 64:
      readValue = (i) => view.getFloat64(i * 8, le);
      break;
    case 256:
      readValue = (i) => view.getInt8(i);
      break;
    case 512:
      readValue = (i) => view.getUint16(i * 2, le);
      break;
    case 768:
      readValue = (i) => view.getUint32(i * 4, le);
      break;
    default:
      throw new Error(`Unsupported NIfTI datatype=${header.datatype} for binary mask input.`);
  }

  const checkFinite = header.datatype === 16 || header.datatype === 64;
  for (let i = 0; i < total; i += 1) {
    const rawVal = readValue(i);
    if (checkFinite && !Number.isFinite(rawVal)) {
      throw new Error('Input NIfTI mask contains NaN or Infinity values.');
    }
    const scaled = rawVal * slope + inter;
    if (scaled > threshold) {
      mask[i] = 1;
      foregroundCount += 1;
    }
  }
  return { mask, foregroundCount };
}

/**
 * Reads a 3D (or singleton 4D) NIfTI-1/2 binary mask directly into a Uint8Array
 * without allocating an intermediate Float32Array.
 */
export async function readBinaryMaskNifti(
  bufferLike,
  {
    threshold = 0,
    maxVoxels = MAX_VOXELS,
    maxDecompressedBytes = MAX_DECOMPRESSED_BYTES,
  } = {},
) {
  const bytes = await gunzipBytes(bufferLike, maxDecompressedBytes);
  const header = parseNiftiVolumeHeader(bytes);
  const ndim = header.dims[0];
  if (!Number.isInteger(ndim) || ndim < 3 || ndim > 7) {
    throw new Error(`Unsupported NIfTI dimensionality dim[0]=${ndim}; expected a 3D volume.`);
  }
  if (header.dims.slice(4, ndim + 1).some((d) => d > 1)) {
    throw new Error('VesselCharter expects a single 3D mask volume, not a multi-frame 4D series.');
  }
  const dims = [header.dims[1], header.dims[2], header.dims[3]];
  if (dims.some((d) => !Number.isInteger(d) || d <= 0)) {
    throw new Error(`Invalid NIfTI dimensions: ${dims.join('x')}.`);
  }
  const totalVoxels = dims[0] * dims[1] * dims[2];
  if (totalVoxels > maxVoxels) {
    throw new Error(
      `Volume has ${totalVoxels.toLocaleString()} voxels, exceeding the ${maxVoxels.toLocaleString()}-voxel limit.`,
    );
  }
  // parseNiftiVolumeHeader has already scaled header.affine to mm using xyztUnits.
  const spatial = inspectAffine(header.affine, header.xyztUnits, { alreadyInMm: true });
  const { mask, foregroundCount } = decodeMaskVoxels(bytes, header, threshold);
  return {
    mask,
    dims,
    foregroundCount,
    header,
    spatial,
  };
}

/**
 * Verifies that an optional ROI / brain mask matches the vessel mask grid and affine.
 */
export function assertMatchingGrid(vesselVol, roiVol, label = 'Brain/ROI mask') {
  for (let i = 0; i < 3; i += 1) {
    if (vesselVol.dims[i] !== roiVol.dims[i]) {
      throw new Error(
        `${label} dimensions (${roiVol.dims.join('x')}) do not match vessel mask (${vesselVol.dims.join('x')}).`,
      );
    }
  }
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 4; c += 1) {
      const diff = Math.abs(vesselVol.spatial.affine[r][c] - roiVol.spatial.affine[r][c]);
      if (diff > 1e-2) {
        throw new Error(`${label} affine does not match the vessel mask spatial grid (max diff ${diff.toFixed(4)} mm).`);
      }
    }
  }
}

/**
 * Computes the tight foreground bounding box and counts voxels touching FOV faces.
 */
export function computeForegroundBBox(mask, dims) {
  const [nx, ny, nz] = dims;
  const slice = nx * ny;
  let minX = nx;
  let minY = ny;
  let minZ = nz;
  let maxX = -1;
  let maxY = -1;
  let maxZ = -1;
  let count = 0;
  let touchesFovCount = 0;

  for (let z = 0; z < nz; z += 1) {
    const zBase = z * slice;
    const zEdge = z === 0 || z === nz - 1;
    for (let y = 0; y < ny; y += 1) {
      const yBase = zBase + y * nx;
      const yzEdge = zEdge || y === 0 || y === ny - 1;
      for (let x = 0; x < nx; x += 1) {
        if (!mask[yBase + x]) {
          continue;
        }
        count += 1;
        if (yzEdge || x === 0 || x === nx - 1) {
          touchesFovCount += 1;
        }
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
    }
  }

  if (count === 0) {
    return null;
  }
  return {
    minX,
    minY,
    minZ,
    maxX,
    maxY,
    maxZ,
    count,
    touchesFovCount,
  };
}

/**
 * Extracts the foreground bounding box with a zero-padded border of `pad` voxels.
 */
export function cropMaskWithPad(mask, dims, bbox, pad = 1) {
  const [nx, ny] = dims;
  const slice = nx * ny;
  const cx = bbox.maxX - bbox.minX + 1 + 2 * pad;
  const cy = bbox.maxY - bbox.minY + 1 + 2 * pad;
  const cz = bbox.maxZ - bbox.minZ + 1 + 2 * pad;
  const cSlice = cx * cy;
  const cropped = new Uint8Array(cx * cy * cz);
  const ox = bbox.minX - pad;
  const oy = bbox.minY - pad;
  const oz = bbox.minZ - pad;

  for (let z = bbox.minZ; z <= bbox.maxZ; z += 1) {
    const srcZ = z * slice;
    const dstZ = (z - oz) * cSlice;
    for (let y = bbox.minY; y <= bbox.maxY; y += 1) {
      const srcRow = srcZ + y * nx + bbox.minX;
      const dstRow = dstZ + (y - oy) * cx + pad;
      const width = bbox.maxX - bbox.minX + 1;
      cropped.set(mask.subarray(srcRow, srcRow + width), dstRow);
    }
  }

  return {
    mask: cropped,
    dims: [cx, cy, cz],
    offset: [ox, oy, oz],
  };
}

/**
 * Fills 6-connected interior background cavities using a typed-array BFS queue.
 * Expects a zero-padded border (or floods from all 6 outer faces).
 */
export function fillInteriorHoles3D(mask, dims) {
  const [nx, ny, nz] = dims;
  const slice = nx * ny;
  const total = slice * nz;
  const outside = new Uint8Array(total);
  const queue = new Int32Array(total);
  let tail = 0;

  const enqueue = (idx) => {
    if (!mask[idx] && !outside[idx]) {
      outside[idx] = 1;
      queue[tail] = idx;
      tail += 1;
    }
  };

  for (let z = 0; z < nz; z += 1) {
    const zBase = z * slice;
    for (let y = 0; y < ny; y += 1) {
      enqueue(zBase + y * nx);
      enqueue(zBase + y * nx + (nx - 1));
    }
    for (let x = 0; x < nx; x += 1) {
      enqueue(zBase + x);
      enqueue(zBase + (ny - 1) * nx + x);
    }
  }
  for (let y = 0; y < ny; y += 1) {
    const row = y * nx;
    for (let x = 0; x < nx; x += 1) {
      enqueue(row + x);
      enqueue((nz - 1) * slice + row + x);
    }
  }

  let head = 0;
  while (head < tail) {
    const idx = queue[head];
    head += 1;
    const z = Math.floor(idx / slice);
    const rem = idx - z * slice;
    const y = Math.floor(rem / nx);
    const x = rem - y * nx;
    if (x > 0) enqueue(idx - 1);
    if (x < nx - 1) enqueue(idx + 1);
    if (y > 0) enqueue(idx - nx);
    if (y < ny - 1) enqueue(idx + nx);
    if (z > 0) enqueue(idx - slice);
    if (z < nz - 1) enqueue(idx + slice);
  }

  const out = new Uint8Array(total);
  let filledVoxels = 0;
  for (let i = 0; i < total; i += 1) {
    if (mask[i]) {
      out[i] = 1;
    } else if (!outside[i]) {
      out[i] = 1;
      filledVoxels += 1;
    }
  }
  return { mask: out, filledVoxels };
}

/**
 * 26-connected sparse foreground component labelling and optional minimum-size filter.
 */
export function filterConnectedComponents26(mask, dims, minComponentVoxels = 0) {
  const [nx, ny, nz] = dims;
  const slice = nx * ny;
  const total = slice * nz;
  const visited = new Uint8Array(total);

  let fgCount = 0;
  for (let i = 0; i < total; i += 1) {
    if (mask[i]) {
      fgCount += 1;
    }
  }

  const queue = new Int32Array(fgCount);
  const kept = new Uint8Array(total);
  let inputComponentCount = 0;
  let retainedComponentCount = 0;
  let droppedComponentCount = 0;
  let droppedVoxels = 0;
  let retainedVoxels = 0;

  for (let start = 0; start < total; start += 1) {
    if (!mask[start] || visited[start]) {
      continue;
    }
    inputComponentCount += 1;
    visited[start] = 1;
    let head = 0;
    let tail = 0;
    queue[tail] = start;
    tail += 1;

    while (head < tail) {
      const idx = queue[head];
      head += 1;
      const z = Math.floor(idx / slice);
      const rem = idx - z * slice;
      const y = Math.floor(rem / nx);
      const x = rem - y * nx;

      const z0 = z > 0 ? z - 1 : 0;
      const z1 = z < nz - 1 ? z + 1 : nz - 1;
      const y0 = y > 0 ? y - 1 : 0;
      const y1 = y < ny - 1 ? y + 1 : ny - 1;
      const x0 = x > 0 ? x - 1 : 0;
      const x1 = x < nx - 1 ? x + 1 : nx - 1;

      for (let nz2 = z0; nz2 <= z1; nz2 += 1) {
        const zOff = nz2 * slice;
        for (let ny2 = y0; ny2 <= y1; ny2 += 1) {
          const yOff = zOff + ny2 * nx;
          for (let nx2 = x0; nx2 <= x1; nx2 += 1) {
            const nIdx = yOff + nx2;
            if (mask[nIdx] && !visited[nIdx]) {
              visited[nIdx] = 1;
              queue[tail] = nIdx;
              tail += 1;
            }
          }
        }
      }
    }

    if (tail >= minComponentVoxels) {
      retainedComponentCount += 1;
      retainedVoxels += tail;
      for (let k = 0; k < tail; k += 1) {
        kept[queue[k]] = 1;
      }
    } else {
      droppedComponentCount += 1;
      droppedVoxels += tail;
    }
  }

  return {
    mask: kept,
    inputComponentCount,
    retainedComponentCount,
    droppedComponentCount,
    droppedVoxels,
    retainedVoxels,
  };
}
