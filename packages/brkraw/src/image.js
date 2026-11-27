// Exact port of BrkRaw v0.5.7 datatype, shape, frame-group, and 2dseq loader
// (src/brkraw/resolver/{datatype,shape,image}.py, GPL-3.0-only).
import { stripJcampString } from './jcamp.js';

/** Safety cap on uncompressed 2dseq / decoded volume size in browser memory (1 GiB). */
export const MAX_CONVERT_BYTES = 1024 * 1024 * 1024;

const HOST_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

export const WORDTYPE_MAP = Object.freeze({
  _32BIT_SGN_INT: Object.freeze({ kind: 'int32', bytes: 4, niftiCode: 8, bitpix: 32 }),
  _16BIT_SGN_INT: Object.freeze({ kind: 'int16', bytes: 2, niftiCode: 4, bitpix: 16 }),
  _8BIT_UNSGN_INT: Object.freeze({ kind: 'uint8', bytes: 1, niftiCode: 2, bitpix: 8 }),
  _32BIT_FLOAT: Object.freeze({ kind: 'float32', bytes: 4, niftiCode: 16, bitpix: 32 }),
});

const Z_AXIS_DESCRIPTORS = new Set(['spatial', 'slice', 'without_slice']);

function toNumberArray(val, fallback) {
  if (val === null || val === undefined) return [fallback];
  if (typeof val === 'number') return [val];
  if (Array.isArray(val)) {
    const out = [];
    const walk = (x) => {
      if (Array.isArray(x)) x.forEach(walk);
      else out.push(Number(x));
    };
    walk(val);
    return out.length ? out : [fallback];
  }
  return [Number(val)];
}

function isUniform(arr) {
  if (arr.length <= 1) return true;
  const first = arr[0];
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] !== first) return false;
  }
  return true;
}

/** Resolve 2dseq binary datatype, endianness, and VisuCoreDataSlope/Offs arrays. */
export function resolveDatatype(visuPars) {
  const byteOrder = visuPars.get('VisuCoreByteOrder');
  const wordType = visuPars.get('VisuCoreWordType');
  if (byteOrder !== 'littleEndian' && byteOrder !== 'bigEndian') {
    throw new Error(`Unsupported VisuCoreByteOrder: ${byteOrder}`);
  }
  const typeInfo = WORDTYPE_MAP[wordType];
  if (!typeInfo) {
    throw new Error(`Unsupported VisuCoreWordType: ${wordType}`);
  }
  const slope = toNumberArray(visuPars.get('VisuCoreDataSlope'), 1.0);
  const offset = toNumberArray(visuPars.get('VisuCoreDataOffs'), 0.0);
  return {
    byteOrder,
    littleEndian: byteOrder === 'littleEndian',
    wordType,
    ...typeInfo,
    slope,
    offset,
  };
}

/** Parse VisuFGOrderDesc frame groups from `visu_pars`. */
export function resolveFrameGroup(visuPars) {
  if (!visuPars.get('VisuFGOrderDescDim')) return null;
  const raw = visuPars.get('VisuFGOrderDesc');
  if (!raw || !Array.isArray(raw)) return null;

  const entries = Array.isArray(raw[0]) ? raw : [raw];
  const ids = entries.map((e) => String(e[1]));
  const shape = entries.map((e) => Math.trunc(Number(e[0])));
  const comments = entries.map((e) => stripJcampString(e[2]) || null);
  const size = shape.reduce((a, b) => a * b, 1);

  return {
    type: visuPars.get('VisuCoreFrameType') ?? null,
    id: ids,
    shape,
    comments,
    size,
  };
}

/** Resolve full 2dseq shape, descriptors, cycle timing, and slice order scheme. */
export function resolveShape(method, visuPars) {
  const dim = Number(visuPars.get('VisuCoreDim'));
  const rawDimDesc = visuPars.get('VisuCoreDimDesc');
  const dimDesc = Array.isArray(rawDimDesc) ? rawDimDesc.map(String) : rawDimDesc ? [String(rawDimDesc)] : [];
  const fov = toNumberArray(visuPars.get('VisuCoreExtent'), 0);
  const coreShape = toNumberArray(visuPars.get('VisuCoreSize'), 0).map((n) => Math.trunc(n));
  const resol = coreShape.map((n, i) => (n ? fov[i] / n : 0));

  const fgInfo = resolveFrameGroup(visuPars);
  const scanTime = Number(visuPars.get('VisuAcqScanTime') || 0);
  let numCycles = 1;
  let timePerCycle = null;
  if (fgInfo) {
    const cycleSizes = fgInfo.id
      .map((id, idx) => (/cycle/i.test(id) ? fgInfo.shape[idx] : null))
      .filter((v) => v !== null);
    numCycles = cycleSizes.length ? cycleSizes[cycleSizes.length - 1] : 1;
    timePerCycle = numCycles ? scanTime / numCycles : 0;
  }

  const shape = [...coreShape];
  const shapeDesc = [...dimDesc];
  const fgDesc = fgInfo
    ? fgInfo.id.map((id) => stripJcampString(id).replace(/^FG_/i, '').trim().toLowerCase())
    : [];

  if (dim === 2 && (!fgInfo || !fgDesc.includes('slice'))) {
    shape.push(1);
    shapeDesc.push('without_slice');
  }
  if (fgInfo && fgInfo.type !== null && fgInfo.type !== undefined) {
    shape.push(...fgInfo.shape);
    shapeDesc.push(...fgDesc);
  }

  return {
    dim,
    coreShape,
    fov,
    resol,
    shape,
    shapeDesc,
    numCycles,
    timePerCycle,
    sliceorderScheme: method.get('PVM_ObjOrderScheme') || null,
    fgInfo,
  };
}

/**
 * Estimate peak decoded payload byte size before decompressing `2dseq`.
 * Accounts for float32 promotion when per-frame slopes/offsets vary.
 */
export function estimateDecodedBytes(shapeInfo, dtypeInfo) {
  if (!shapeInfo || !dtypeInfo) return 0;
  const totalVoxels = shapeInfo.shape.reduce((a, b) => a * b, 1);
  if (!Number.isFinite(totalVoxels) || totalVoxels <= 0) return 0;
  const uniformScaling = isUniform(dtypeInfo.slope) && isUniform(dtypeInfo.offset);
  const bytesPerVoxel = uniformScaling ? dtypeInfo.bytes : Math.max(dtypeInfo.bytes, 4);
  return totalVoxels * bytesPerVoxel;
}

function makeTypedArray(kind, length) {
  if (kind === 'int16') return new Int16Array(length);
  if (kind === 'int32') return new Int32Array(length);
  if (kind === 'uint8') return new Uint8Array(length);
  if (kind === 'float32') return new Float32Array(length);
  throw new Error(`Unsupported typed array kind: ${kind}`);
}

function readTypedBuffer(rawBytes, dtypeInfo, count) {
  const expectedBytes = count * dtypeInfo.bytes;
  if (rawBytes.byteLength !== expectedBytes) {
    throw new Error(`2dseq size mismatch: expected ${expectedBytes} bytes for ${count} voxels, got ${rawBytes.byteLength}.`);
  }

  // Zero-copy fast path for uint8 and aligned native-endian buffers.
  if (dtypeInfo.kind === 'uint8') {
    return rawBytes;
  }
  if (
    dtypeInfo.littleEndian === HOST_LITTLE_ENDIAN
    && rawBytes.byteOffset % dtypeInfo.bytes === 0
  ) {
    if (dtypeInfo.kind === 'int16') return new Int16Array(rawBytes.buffer, rawBytes.byteOffset, count);
    if (dtypeInfo.kind === 'int32') return new Int32Array(rawBytes.buffer, rawBytes.byteOffset, count);
    if (dtypeInfo.kind === 'float32') return new Float32Array(rawBytes.buffer, rawBytes.byteOffset, count);
  }

  const out = makeTypedArray(dtypeInfo.kind, count);
  const dv = new DataView(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength);
  const le = dtypeInfo.littleEndian;

  if (dtypeInfo.kind === 'int16') {
    for (let i = 0; i < count; i++) out[i] = dv.getInt16(i * 2, le);
  } else if (dtypeInfo.kind === 'int32') {
    for (let i = 0; i < count; i++) out[i] = dv.getInt32(i * 4, le);
  } else if (dtypeInfo.kind === 'float32') {
    for (let i = 0; i < count; i++) out[i] = dv.getFloat32(i * 4, le);
  }
  return out;
}

/** Compute Fortran-order strides `[1, s0, s0*s1, ...]`. */
function fortranStrides(shape) {
  const strides = new Array(shape.length);
  let acc = 1;
  for (let i = 0; i < shape.length; i++) {
    strides[i] = acc;
    acc *= shape[i];
  }
  return strides;
}

/** Swap axes `a` and `b` in a Fortran-ordered N-D typed array. */
function swapAxesFortran(src, shape, a, b) {
  const newShape = [...shape];
  [newShape[a], newShape[b]] = [newShape[b], newShape[a]];
  const srcStrides = fortranStrides(shape);
  const dstStrides = fortranStrides(newShape);
  const out = new src.constructor(src.length);
  const ndim = shape.length;
  const coords = new Int32Array(ndim);

  for (let dstIdx = 0; dstIdx < out.length; dstIdx++) {
    let srcIdx = 0;
    for (let d = 0; d < ndim; d++) {
      const sd = d === a ? b : d === b ? a : d;
      srcIdx += coords[d] * srcStrides[sd];
    }
    out[dstIdx] = src[srcIdx];
    for (let d = 0; d < ndim; d++) {
      coords[d]++;
      if (coords[d] < newShape[d]) break;
      coords[d] = 0;
    }
  }
  return { data: out, shape: newShape, strides: dstStrides };
}

/** Extract slice range `[sliceStart, sliceStart + sliceCount)` along axis 2 in Fortran order. */
function sliceAxis2Fortran(src, shape, sliceStart, sliceCount) {
  const nx = shape[0];
  const ny = shape[1];
  const nz = shape[2];
  const planeSize = nx * ny;
  const outerCount = shape.slice(3).reduce((a, b) => a * b, 1);
  const outShape = [nx, ny, sliceCount, ...shape.slice(3)];
  if (sliceStart === 0 && sliceCount === nz) {
    return { data: src, shape: outShape };
  }
  const out = new src.constructor(planeSize * sliceCount * outerCount);
  const dstVolStride = planeSize * sliceCount;
  const srcVolStride = planeSize * nz;
  for (let outer = 0; outer < outerCount; outer++) {
    const srcBase = outer * srcVolStride + sliceStart * planeSize;
    const dstBase = outer * dstVolStride;
    out.set(src.subarray(srcBase, srcBase + dstVolStride), dstBase);
  }
  return { data: out, shape: outShape };
}

/**
 * Decode a Bruker `2dseq` buffer into per-slice-pack Fortran-ordered volume arrays
 * with resolved NIfTI scaling (`sclSlope`, `sclInter`, `perFrameScalingApplied`).
 */
export function decode2dseq(rawBytes, {
  dtypeInfo,
  shapeInfo,
  numSlices,
  maxBytes = MAX_CONVERT_BYTES,
}) {
  const totalVoxels = shapeInfo.shape.reduce((a, b) => a * b, 1);
  if (totalVoxels <= 0) {
    throw new Error(`Invalid 2dseq shape: [${shapeInfo.shape.join(', ')}]`);
  }
  const estimatedBytes = estimateDecodedBytes(shapeInfo, dtypeInfo);
  if (estimatedBytes > maxBytes) {
    throw new Error(
      `Volume [${shapeInfo.shape.join(' × ')}] requires ${(estimatedBytes / (1024 * 1024)).toFixed(0)} MiB, exceeding the ${(maxBytes / (1024 * 1024)).toFixed(0)} MiB browser limit. Use the Standalone BrkRaw container.`,
    );
  }

  let data = readTypedBuffer(rawBytes, dtypeInfo, totalVoxels);
  let shape = [...shapeInfo.shape];
  let shapeDesc = [...shapeInfo.shapeDesc];

  // Apply per-frame slope/offset before axis swapping if scaling varies across frames.
  // For VisuCoreDim=2 each frame is a 2D slice; for VisuCoreDim=3 each frame is a full 3D volume.
  const uniformScaling = isUniform(dtypeInfo.slope) && isUniform(dtypeInfo.offset);
  let kind = dtypeInfo.kind;
  let sclSlope = dtypeInfo.slope[0] ?? 1.0;
  let sclInter = dtypeInfo.offset[0] ?? 0.0;
  let perFrameScalingApplied = false;

  if (!uniformScaling) {
    const coreDims = shapeInfo.coreShape?.length
      ? shapeInfo.coreShape
      : shape.slice(0, Math.max(1, shapeInfo.dim || 2));
    const frameSize = coreDims.reduce((a, b) => a * b, 1);
    if (frameSize <= 0 || totalVoxels % frameSize !== 0) {
      throw new Error(
        `Per-frame scaling error: frame size ${frameSize} does not divide total voxel count ${totalVoxels}.`,
      );
    }
    const numFrames = totalVoxels / frameSize;
    const validSlope = dtypeInfo.slope.length === 1 || dtypeInfo.slope.length === numFrames;
    const validOffset = dtypeInfo.offset.length === 1 || dtypeInfo.offset.length === numFrames;
    if (!validSlope || !validOffset) {
      throw new Error(
        `Per-frame scaling mismatch: expected 1 or ${numFrames} VisuCoreDataSlope/Offs entries, got ${dtypeInfo.slope.length} slopes and ${dtypeInfo.offset.length} offsets.`,
      );
    }

    const scaled = new Float32Array(totalVoxels);
    for (let f = 0; f < numFrames; f++) {
      const s = dtypeInfo.slope.length === numFrames ? dtypeInfo.slope[f] : dtypeInfo.slope[0];
      const o = dtypeInfo.offset.length === numFrames ? dtypeInfo.offset[f] : dtypeInfo.offset[0];
      const base = f * frameSize;
      for (let i = 0; i < frameSize; i++) {
        scaled[base + i] = data[base + i] * s + o;
      }
    }
    data = scaled;
    kind = 'float32';
    sclSlope = 1.0;
    sclInter = 0.0;
    perFrameScalingApplied = true;
  }

  // Normalize spatial z-axis to index 2 (exact port of ensure_3d_spatial_data)
  if (shape.length >= 3 && shapeDesc.length >= 3) {
    if (!Z_AXIS_DESCRIPTORS.has(shapeDesc[2])) {
      let zIdx = -1;
      for (let i = 2; i < shapeDesc.length; i++) {
        if (Z_AXIS_DESCRIPTORS.has(shapeDesc[i])) {
          zIdx = i;
          break;
        }
      }
      if (zIdx === -1) {
        throw new Error(`Spatial z-axis descriptor not found in shape_desc: [${shapeDesc.join(', ')}]`);
      }
      const swapped = swapAxesFortran(data, shape, 2, zIdx);
      data = swapped.data;
      shape = swapped.shape;
      [shapeDesc[2], shapeDesc[zIdx]] = [shapeDesc[zIdx], shapeDesc[2]];
    }
    if (shapeDesc[2] === 'without_slice') {
      shapeDesc[2] = 'slice';
    }
  }

  // Split along axis 2 by slice pack
  const packs = [];
  let offset = 0;
  for (const count of numSlices) {
    const sliced = sliceAxis2Fortran(data, shape, offset, count);
    packs.push({
      data: sliced.data,
      shape: sliced.shape,
      kind,
      sclSlope,
      sclInter,
      perFrameScalingApplied,
    });
    offset += count;
  }

  return {
    packs,
    shapeDesc,
    perFrameScalingApplied,
  };
}
