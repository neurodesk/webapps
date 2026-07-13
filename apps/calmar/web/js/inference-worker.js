/**
 * LNM Inference Worker (module worker).
 *
 * Runs ONNX model inference for the CALMaR pipeline:
 *   1. Load            — NIfTI parse + orient to RAS
 *   2. SynthStrip      — brain extraction (Phase 2a.1; ported from
 *                        neurodesk/vesselboost-webapp). Single-pass full-volume
 *                        inference; WASM execution provider only.
 *   3. (Phase 2a.2)    — lesion segmentation via patch-based sliding-window
 *                        inference (reuses inference-pipeline.js).
 *
 * Model bytes are cached in the Cache Storage API under MODEL_CACHE_NAME so
 * subsequent runs avoid the network round-trip.
 */

import * as ort from '../wasm/ort.webgpu.bundle.min.mjs';
import * as InferencePipeline from './inference-pipeline.js';
import { runSynthStrip } from './modules/brain-extraction.js';
import {
  integrateSvf,
  upsampleDisplacementField,
  displacementMagnitudeField,
  warpVolume,
  inverseWarpVolume
} from './modules/registration.js';
import { resampleAffine } from './modules/resample.js';

// nifti-reader-js is a UMD bundle that installs `self.nifti` as a side-
// effect. We do NOT await its import at module top level: Chromium drops
// any message posted while a module worker is suspended on top-level
// await, instead of queueing it (the spec-mandated behaviour). Loading
// nifti-js lazily and setting up onmessage immediately keeps the queue
// working.
const niftiReady = import('../nifti-js/index.js').then(() => {
  if (!globalThis.nifti) {
    throw new Error('nifti-reader-js failed to install globalThis.nifti at worker boot');
  }
  return globalThis.nifti;
});
let nifti = null;
niftiReady.then(n => { nifti = n; });

const MODEL_CACHE_NAME = 'lnm-models-v1';
const MAX_PROCESSING_VOXELS = 100 * 1024 * 1024;

// ==================== Shared Worker State ====================

let workerState = {
  headerBytes: null,
  origHeaderBytes: null,
  origDims: null,
  affine: null,
  perm: null,
  flip: null,
  isIdentity: null,
  rasData: null,
  rasDims: null,
  rasSpacing: null,
  // Unmasked segmentation labels in RAS space (before brain mask / CC cleanup)
  segLabelsRAS: null,
  segMinComponentSize: 10,
  // Phase 3 SynthMorph: integrated full-resolution displacement field stored
  // in workerState so a follow-up 'warp-mask' op can apply it to a mask
  // without re-running the registration. Float32Array, length 160*160*192*3,
  // NDHWC channel-last layout (matches the SynthMorph ONNX output).
  displacementField: null,
  displacementDims: null,
  referenceHeaderBytes: null,
  referenceDims: null,
};

function resetState() {
  workerState = {
    headerBytes: null,
    origHeaderBytes: null,
    origDims: null,
    affine: null,
    perm: null,
    flip: null,
    isIdentity: null,
    rasData: null,
    rasDims: null,
    rasSpacing: null,
    segLabelsRAS: null,
    segMinComponentSize: 10,
    displacementField: null,
    displacementDims: null,
    referenceHeaderBytes: null,
    referenceDims: null,
  };
}

// ==================== Message Helpers ====================

function postProgress(value, text) {
  self.postMessage({ type: 'progress', value, text });
}

function postLog(message) {
  self.postMessage({ type: 'log', message });
}

function postError(message) {
  self.postMessage({ type: 'error', message });
}

function postComplete() {
  self.postMessage({ type: 'complete' });
}

function postStageData(stage, niftiData, description) {
  self.postMessage(
    { type: 'stageData', stage, niftiData, description, taskId: self._currentTaskId || null },
    [niftiData]
  );
}

function postStepComplete(step) {
  self.postMessage({ type: 'step-complete', step });
}

function postVolumeInfo(info) {
  self.postMessage({ type: 'volume-info', ...info });
}

function collectTransferables(value, transferables, seen = new Set()) {
  if (!value || typeof value !== 'object') return;

  if (value instanceof ArrayBuffer) {
    if (!seen.has(value)) {
      seen.add(value);
      transferables.push(value);
    }
    return;
  }

  if (ArrayBuffer.isView(value)) {
    collectTransferables(value.buffer, transferables, seen);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectTransferables(item, transferables, seen);
    return;
  }

  for (const nestedValue of Object.values(value)) {
    collectTransferables(nestedValue, transferables, seen);
  }
}

function postStateArtifact(artifact, payload) {
  const transferables = [];
  collectTransferables(payload, transferables);
  self.postMessage({ type: 'state-artifact', artifact, payload }, transferables);
}

function emitSegmentationStateArtifact() {
  const segLabelsRAS = workerState.segLabelsRAS ? new Uint8Array(workerState.segLabelsRAS).buffer : null;
  postStateArtifact('segmentationState', {
    segLabelsRAS,
    segMinComponentSize: workerState.segMinComponentSize ?? 10
  });
}

// ==================== NIfTI Parsing ====================

function decompressIfNeeded(data) {
  const bytes = new Uint8Array(data);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    if (typeof nifti !== 'undefined' && nifti.isCompressed) {
      if (nifti.isCompressed(bytes.buffer)) {
        return new Uint8Array(nifti.decompress(bytes.buffer));
      }
    }
    throw new Error('Gzipped NIfTI detected but decompression not available');
  }
  return bytes;
}

function parseNiftiInput(arrayBuffer) {
  const data = decompressIfNeeded(arrayBuffer);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  const dims = [];
  for (let i = 0; i < 8; i++) dims.push(view.getInt16(40 + i * 2, true));
  const nx = dims[1], ny = dims[2], nz = dims[3];
  const dimCount = dims[0];
  const nt = dims[4] || 1;
  if (dimCount > 4 || (dimCount === 4 && nt !== 1)) {
    throw new Error(`Unsupported NIfTI shape ${dims.slice(1, dimCount + 1).join('x')}; only 3D or singleton 4D volumes are supported.`);
  }

  const pixDims = [];
  for (let i = 0; i < 8; i++) pixDims.push(view.getFloat32(76 + i * 4, true));

  const datatype = view.getInt16(70, true);
  const voxOffset = view.getFloat32(108, true);
  const sclSlope = view.getFloat32(112, true) || 1;
  const sclInter = view.getFloat32(116, true) || 0;
  const dataStart = Math.ceil(voxOffset);
  const nTotal = nx * ny * nz;

  const imageData = new Float32Array(nTotal);
  switch (datatype) {
    case 2:
      for (let i = 0; i < nTotal; i++) imageData[i] = data[dataStart + i] * sclSlope + sclInter;
      break;
    case 4:
      for (let i = 0; i < nTotal; i++) imageData[i] = view.getInt16(dataStart + i * 2, true) * sclSlope + sclInter;
      break;
    case 8:
      for (let i = 0; i < nTotal; i++) imageData[i] = view.getInt32(dataStart + i * 4, true) * sclSlope + sclInter;
      break;
    case 16:
      for (let i = 0; i < nTotal; i++) imageData[i] = view.getFloat32(dataStart + i * 4, true) * sclSlope + sclInter;
      break;
    case 64:
      for (let i = 0; i < nTotal; i++) imageData[i] = view.getFloat64(dataStart + i * 8, true) * sclSlope + sclInter;
      break;
    case 512:
      for (let i = 0; i < nTotal; i++) imageData[i] = view.getUint16(dataStart + i * 2, true) * sclSlope + sclInter;
      break;
    default:
      throw new Error(`Unsupported NIfTI datatype: ${datatype}`);
  }

  const affine = extractAffine(view);

  const headerSize = dataStart;
  const headerBytes = new ArrayBuffer(headerSize);
  new Uint8Array(headerBytes).set(data.slice(0, headerSize));

  return {
    imageData,
    dims: [nx, ny, nz],
    voxelSize: [Math.abs(pixDims[1]) || 1, Math.abs(pixDims[2]) || 1, Math.abs(pixDims[3]) || 1],
    headerBytes,
    affine
  };
}

function copyNiftiHeaderBytes(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const voxOffset = view.getFloat32(108, true);
  const headerSize = Math.ceil(voxOffset);
  const out = new ArrayBuffer(headerSize);
  new Uint8Array(out).set(bytes.slice(0, headerSize));
  return out;
}

function extractAffine(view) {
  const sformCode = view.getInt16(254, true);
  const qformCode = view.getInt16(252, true);

  if (sformCode > 0) {
    const affine = [new Float64Array(4), new Float64Array(4), new Float64Array(4), new Float64Array([0, 0, 0, 1])];
    for (let i = 0; i < 4; i++) {
      affine[0][i] = view.getFloat32(280 + i * 4, true);
      affine[1][i] = view.getFloat32(296 + i * 4, true);
      affine[2][i] = view.getFloat32(312 + i * 4, true);
    }
    return affine;
  }

  if (qformCode > 0) {
    const pixDims = [];
    for (let i = 0; i < 4; i++) pixDims.push(view.getFloat32(76 + i * 4, true));
    const qb = view.getFloat32(256, true);
    const qc = view.getFloat32(260, true);
    const qd = view.getFloat32(264, true);
    const qx = view.getFloat32(268, true);
    const qy = view.getFloat32(272, true);
    const qz = view.getFloat32(276, true);
    const sqr = qb * qb + qc * qc + qd * qd;
    const qa = sqr > 1.0 ? 0.0 : Math.sqrt(1.0 - sqr);
    const R = [
      [qa*qa+qb*qb-qc*qc-qd*qd, 2*(qb*qc-qa*qd), 2*(qb*qd+qa*qc)],
      [2*(qb*qc+qa*qd), qa*qa+qc*qc-qb*qb-qd*qd, 2*(qc*qd-qa*qb)],
      [2*(qb*qd-qa*qc), 2*(qc*qd+qa*qb), qa*qa+qd*qd-qb*qb-qc*qc]
    ];
    const qfac = pixDims[0] < 0 ? -1 : 1;
    return [
      new Float64Array([R[0][0]*pixDims[1], R[0][1]*pixDims[2], R[0][2]*pixDims[3]*qfac, qx]),
      new Float64Array([R[1][0]*pixDims[1], R[1][1]*pixDims[2], R[1][2]*pixDims[3]*qfac, qy]),
      new Float64Array([R[2][0]*pixDims[1], R[2][1]*pixDims[2], R[2][2]*pixDims[3]*qfac, qz]),
      new Float64Array([0, 0, 0, 1])
    ];
  }

  const pixDims = [];
  for (let i = 0; i < 4; i++) pixDims.push(view.getFloat32(76 + i * 4, true));
  return [
    new Float64Array([pixDims[1] || 1, 0, 0, 0]),
    new Float64Array([0, pixDims[2] || 1, 0, 0]),
    new Float64Array([0, 0, pixDims[3] || 1, 0]),
    new Float64Array([0, 0, 0, 1])
  ];
}

// ==================== NIfTI Output ====================

function createOutputNifti(labelData, sourceHeader, dims) {
  const srcView = new DataView(sourceHeader);
  const voxOffset = srcView.getFloat32(108, true);
  const headerSize = Math.ceil(voxOffset);
  const payload = new Uint8Array(
    labelData.buffer,
    labelData.byteOffset || 0,
    labelData.byteLength
  );

  const buffer = new ArrayBuffer(headerSize + payload.byteLength);
  const destBytes = new Uint8Array(buffer);
  const destView = new DataView(buffer);

  destBytes.set(new Uint8Array(sourceHeader).slice(0, headerSize));

  if (labelData instanceof Uint16Array) {
    destView.setInt16(70, 512, true);
    destView.setInt16(72, 16, true);
  } else {
    destView.setInt16(70, 2, true);
    destView.setInt16(72, 8, true);
  }

  // Update dims if provided
  if (dims) {
    destView.setInt16(40, 3, true);
    destView.setInt16(42, dims[0], true);
    destView.setInt16(44, dims[1], true);
    destView.setInt16(46, dims[2], true);
    destView.setInt16(48, 1, true);
  }

  destView.setFloat32(112, 1, true);  // scl_slope
  destView.setFloat32(116, 0, true);  // scl_inter

  let maxVal = 0;
  for (let i = 0; i < labelData.length; i++) {
    if (labelData[i] > maxVal) maxVal = labelData[i];
  }
  destView.setFloat32(124, Math.max(1, maxVal), true);  // cal_max
  destView.setFloat32(128, 0, true);                    // cal_min

  new Uint8Array(buffer, headerSize).set(payload);
  return buffer;
}

function createFloat32Nifti(float32Data, sourceHeader, dims, spacing) {
  const srcView = new DataView(sourceHeader);
  const voxOffset = srcView.getFloat32(108, true);
  const headerSize = Math.ceil(voxOffset);

  const dataBytes = float32Data.length * 4;
  const buffer = new ArrayBuffer(headerSize + dataBytes);
  const destBytes = new Uint8Array(buffer);
  const destView = new DataView(buffer);

  destBytes.set(new Uint8Array(sourceHeader).slice(0, headerSize));

  // Set datatype to FLOAT32
  destView.setInt16(70, 16, true);
  destView.setInt16(72, 32, true);

  if (dims) {
    destView.setInt16(40, 3, true);
    destView.setInt16(42, dims[0], true);
    destView.setInt16(44, dims[1], true);
    destView.setInt16(46, dims[2], true);
    destView.setInt16(48, 1, true);
  }

  if (spacing) {
    destView.setFloat32(80, spacing[0], true);  // pixdim[1]
    destView.setFloat32(84, spacing[1], true);  // pixdim[2]
    destView.setFloat32(88, spacing[2], true);  // pixdim[3]
  }

  destView.setFloat32(112, 1, true);  // scl_slope
  destView.setFloat32(116, 0, true);  // scl_inter

  // cal_min/cal_max: auto range
  let minVal = Infinity, maxVal = -Infinity;
  for (let i = 0; i < float32Data.length; i++) {
    if (float32Data[i] < minVal) minVal = float32Data[i];
    if (float32Data[i] > maxVal) maxVal = float32Data[i];
  }
  destView.setFloat32(124, maxVal, true);  // cal_max
  destView.setFloat32(128, minVal, true);  // cal_min

  new Uint8Array(buffer, headerSize).set(new Uint8Array(float32Data.buffer, float32Data.byteOffset, dataBytes));
  return buffer;
}

// ==================== Preprocessing ====================

function getOrientationTransform(affine) {
  const mat = [
    [affine[0][0], affine[0][1], affine[0][2]],
    [affine[1][0], affine[1][1], affine[1][2]],
    [affine[2][0], affine[2][1], affine[2][2]]
  ];

  const perm = [0, 0, 0];
  const flip = [false, false, false];
  const used = [false, false, false];

  for (let outAxis = 0; outAxis < 3; outAxis++) {
    let bestAxis = -1;
    let bestVal = -1;
    for (let inAxis = 0; inAxis < 3; inAxis++) {
      if (used[inAxis]) continue;
      const val = Math.abs(mat[outAxis][inAxis]);
      if (val > bestVal) {
        bestVal = val;
        bestAxis = inAxis;
      }
    }
    perm[outAxis] = bestAxis;
    flip[outAxis] = mat[outAxis][bestAxis] < 0;
    used[bestAxis] = true;
  }

  return { perm, flip };
}

function orientToRAS(data, dims, perm, flip) {
  const [nx, ny, nz] = dims;
  const srcDims = [nx, ny, nz];
  const dstDims = [srcDims[perm[0]], srcDims[perm[1]], srcDims[perm[2]]];
  const [dx, dy, dz] = dstDims;
  const result = new Float32Array(dx * dy * dz);

  for (let oz = 0; oz < dz; oz++) {
    for (let oy = 0; oy < dy; oy++) {
      for (let ox = 0; ox < dx; ox++) {
        const coords = [ox, oy, oz];
        const src = [0, 0, 0];
        for (let i = 0; i < 3; i++) {
          src[perm[i]] = flip[i] ? (dstDims[i] - 1 - coords[i]) : coords[i];
        }
        const srcIdx = src[0] + src[1] * nx + src[2] * nx * ny;
        const dstIdx = ox + oy * dx + oz * dx * dy;
        result[dstIdx] = data[srcIdx];
      }
    }
  }

  return { data: result, dims: dstDims };
}

function computeResampledDims(dims, srcSpacing, tgtSpacing) {
  return [
    Math.max(1, Math.round(dims[0] * srcSpacing[0] / tgtSpacing[0])),
    Math.max(1, Math.round(dims[1] * srcSpacing[1] / tgtSpacing[1])),
    Math.max(1, Math.round(dims[2] * srcSpacing[2] / tgtSpacing[2]))
  ];
}

function resampleVolume(data, dims, srcSpacing, tgtSpacing) {
  const [nx, ny, nz] = dims;
  const newDims = computeResampledDims(dims, srcSpacing, tgtSpacing);
  const [nnx, nny, nnz] = newDims;
  const result = new Float32Array(nnx * nny * nnz);

  const scaleX = (nx - 1) / Math.max(nnx - 1, 1);
  const scaleY = (ny - 1) / Math.max(nny - 1, 1);
  const scaleZ = (nz - 1) / Math.max(nnz - 1, 1);

  for (let z = 0; z < nnz; z++) {
    const sz = z * scaleZ;
    const z0 = Math.floor(sz);
    const z1 = Math.min(z0 + 1, nz - 1);
    const wz = sz - z0;
    for (let y = 0; y < nny; y++) {
      const sy = y * scaleY;
      const y0 = Math.floor(sy);
      const y1 = Math.min(y0 + 1, ny - 1);
      const wy = sy - y0;
      for (let x = 0; x < nnx; x++) {
        const sx = x * scaleX;
        const x0 = Math.floor(sx);
        const x1 = Math.min(x0 + 1, nx - 1);
        const wx = sx - x0;

        const c000 = data[x0 + y0*nx + z0*nx*ny];
        const c100 = data[x1 + y0*nx + z0*nx*ny];
        const c010 = data[x0 + y1*nx + z0*nx*ny];
        const c110 = data[x1 + y1*nx + z0*nx*ny];
        const c001 = data[x0 + y0*nx + z1*nx*ny];
        const c101 = data[x1 + y0*nx + z1*nx*ny];
        const c011 = data[x0 + y1*nx + z1*nx*ny];
        const c111 = data[x1 + y1*nx + z1*nx*ny];

        const c00 = c000*(1-wx) + c100*wx;
        const c01 = c001*(1-wx) + c101*wx;
        const c10 = c010*(1-wx) + c110*wx;
        const c11 = c011*(1-wx) + c111*wx;
        const c0 = c00*(1-wy) + c10*wy;
        const c1 = c01*(1-wy) + c11*wy;

        result[x + y*nnx + z*nnx*nny] = c0*(1-wz) + c1*wz;
      }
    }
  }

  return { data: result, dims: newDims, spacing: tgtSpacing };
}

function extractSliceRange(data, dims, startZ, endZ, outputCtor = Float32Array) {
  const [nx, ny, nz] = dims;
  const clampedStart = Math.max(0, Math.min(nz, Math.floor(startZ)));
  const clampedEnd = Math.max(clampedStart, Math.min(nz, Math.floor(endZ)));
  const subsetNz = clampedEnd - clampedStart;
  const sliceSize = nx * ny;
  const result = new outputCtor(sliceSize * subsetNz);
  for (let z = 0; z < subsetNz; z++) {
    const srcOff = (clampedStart + z) * sliceSize;
    const dstOff = z * sliceSize;
    result.set(data.subarray(srcOff, srcOff + sliceSize), dstOff);
  }
  return { data: result, dims: [nx, ny, subsetNz] };
}

function embedSliceSubsection(data, subsectionDims, fullDims, startZ) {
  const [nx, ny, nz] = subsectionDims;
  const [fnx, fny, fnz] = fullDims;
  if (nx !== fnx || ny !== fny) {
    throw new Error('Subsection and full dimensions are incompatible for embedding');
  }
  if (startZ < 0 || startZ + nz > fnz) {
    throw new Error('Invalid subsection Z-range for embedding');
  }

  const result = new Uint8Array(fnx * fny * fnz);
  const sliceSize = nx * ny;
  for (let z = 0; z < nz; z++) {
    const srcOff = z * sliceSize;
    const dstOff = (startZ + z) * sliceSize;
    result.set(data.subarray(srcOff, srcOff + sliceSize), dstOff);
  }
  return result;
}

function computeForegroundBBox(data, dims, margin) {
  const [nx, ny, nz] = dims;
  let minX = nx, maxX = 0, minY = ny, maxY = 0, minZ = nz, maxZ = 0;

  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        if (data[x + y*nx + z*nx*ny] !== 0) {
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
          if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
        }
      }
    }
  }

  if (maxX < minX) return null;

  return {
    origin: [
      Math.max(0, minX - margin),
      Math.max(0, minY - margin),
      Math.max(0, minZ - margin)
    ],
    end: [
      Math.min(nx, maxX + margin + 1),
      Math.min(ny, maxY + margin + 1),
      Math.min(nz, maxZ + margin + 1)
    ]
  };
}

function cropVolume(data, dims, bbox) {
  const [nx, ny] = dims;
  const [ox, oy, oz] = bbox.origin;
  const [ex, ey, ez] = bbox.end;
  const cnx = ex - ox, cny = ey - oy, cnz = ez - oz;

  const result = new Float32Array(cnx * cny * cnz);
  for (let z = 0; z < cnz; z++) {
    for (let y = 0; y < cny; y++) {
      const srcOff = (z+oz)*nx*ny + (y+oy)*nx + ox;
      const dstOff = z*cnx*cny + y*cnx;
      result.set(data.subarray(srcOff, srcOff + cnx), dstOff);
    }
  }

  return { data: result, dims: [cnx, cny, cnz], origin: [ox, oy, oz] };
}

// ==================== 3D Sliding Window ====================

/** Direct-write patch into output (no weighting). For non-overlapping tiling. */
function writePatch3D(dest, volumeDims, position, output, patchDims) {
  const [v0, v1, v2] = volumeDims;
  const [p0, p1, p2] = patchDims;
  const [o0, o1, o2] = position;

  for (let i0 = 0; i0 < p0; i0++) {
    const g0 = o0 + i0;
    if (g0 < 0 || g0 >= v0) continue;
    for (let i1 = 0; i1 < p1; i1++) {
      const g1 = o1 + i1;
      if (g1 < 0 || g1 >= v1) continue;
      for (let i2 = 0; i2 < p2; i2++) {
        const g2 = o2 + i2;
        if (g2 < 0 || g2 >= v2) continue;

        dest[g0 + g1 * v0 + g2 * v0 * v1] = output[i0 * p1 * p2 + i1 * p2 + i2];
      }
    }
  }
}

// ==================== Postprocessing ====================

function connectedComponents3D(binaryMask, dims) {
  const [nx, ny, nz] = dims;
  const n = nx * ny * nz;
  const labels = new Int32Array(n);
  let nextLabel = 1;
  const parent = [0];
  const rank = [0];

  function find(x) {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  }

  function union(a, b) {
    a = find(a); b = find(b);
    if (a === b) return;
    if (rank[a] < rank[b]) { const t = a; a = b; b = t; }
    parent[b] = a;
    if (rank[a] === rank[b]) rank[a]++;
  }

  const neighborOffsets = [];
  for (let dz = -1; dz <= 0; dz++)
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (dz === 0 && dy === 0 && dx >= 0) continue;
        neighborOffsets.push([dx, dy, dz]);
      }

  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++) {
        const idx = z*ny*nx + y*nx + x;
        if (!binaryMask[idx]) continue;
        const neighborLabels = [];
        for (let i = 0; i < neighborOffsets.length; i++) {
          const nx2 = x+neighborOffsets[i][0], ny2 = y+neighborOffsets[i][1], nz2 = z+neighborOffsets[i][2];
          if (nx2<0||nx2>=nx||ny2<0||ny2>=ny||nz2<0||nz2>=nz) continue;
          const nIdx = nz2*ny*nx + ny2*nx + nx2;
          if (labels[nIdx] > 0) neighborLabels.push(labels[nIdx]);
        }
        if (neighborLabels.length === 0) {
          labels[idx] = nextLabel;
          parent.push(nextLabel);
          rank.push(0);
          nextLabel++;
        } else {
          let minLabel = find(neighborLabels[0]);
          for (let i = 1; i < neighborLabels.length; i++) {
            const c = find(neighborLabels[i]);
            if (c < minLabel) minLabel = c;
          }
          labels[idx] = minLabel;
          for (let i = 0; i < neighborLabels.length; i++) union(minLabel, neighborLabels[i]);
        }
      }

  const canonicalMap = new Map();
  let finalLabel = 0;
  for (let i = 0; i < n; i++) {
    if (labels[i] === 0) continue;
    const root = find(labels[i]);
    if (!canonicalMap.has(root)) canonicalMap.set(root, ++finalLabel);
    labels[i] = canonicalMap.get(root);
  }
  return { labels, numComponents: finalLabel };
}

/**
 * Keep only the largest connected component and fill interior holes.
 * Connected-component cleanup with hole filling.
 */
function keepLargestComponentAndFill(binaryMask, dims) {
  const n = dims[0] * dims[1] * dims[2];
  const { labels, numComponents } = connectedComponents3D(binaryMask, dims);

  if (numComponents <= 1) return binaryMask;

  // Find largest component
  const sizes = new Int32Array(numComponents + 1);
  for (let i = 0; i < n; i++) {
    if (labels[i] > 0) sizes[labels[i]]++;
  }
  let largestLabel = 1;
  for (let l = 2; l <= numComponents; l++) {
    if (sizes[l] > sizes[largestLabel]) largestLabel = l;
  }

  // Keep only largest
  const result = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (labels[i] === largestLabel) result[i] = 1;
  }

  // Fill interior holes: find background CC touching the volume border,
  // then mark all other background voxels as brain (they are holes)
  const inverted = new Uint8Array(n);
  for (let i = 0; i < n; i++) inverted[i] = result[i] ? 0 : 1;
  const bgCC = connectedComponents3D(inverted, dims);

  // Find which background labels touch the border
  const [nx, ny, nz] = dims;
  const borderLabels = new Set();
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        if (x === 0 || x === nx-1 || y === 0 || y === ny-1 || z === 0 || z === nz-1) {
          const idx = z*ny*nx + y*nx + x;
          if (bgCC.labels[idx] > 0) borderLabels.add(bgCC.labels[idx]);
        }
      }
    }
  }

  // Fill interior holes (background components not touching border)
  for (let i = 0; i < n; i++) {
    if (bgCC.labels[i] > 0 && !borderLabels.has(bgCC.labels[i])) {
      result[i] = 1;
    }
  }

  return result;
}

// ==================== Inverse Transform ====================

function uncrop(croppedData, croppedDims, fullDims, origin) {
  const [nx, ny, nz] = fullDims;
  const [cnx, cny, cnz] = croppedDims;
  const [ox, oy, oz] = origin;
  const result = new Uint8Array(nx * ny * nz);
  for (let z = 0; z < cnz; z++) {
    for (let y = 0; y < cny; y++) {
      const srcOff = z*cnx*cny + y*cnx;
      const dstOff = (z+oz)*nx*ny + (y+oy)*nx + ox;
      result.set(croppedData.subarray(srcOff, srcOff + cnx), dstOff);
    }
  }
  return result;
}

function resampleLabelsNearest(data, dims, tgtDims) {
  const [nx, ny, nz] = dims;
  const [tnx, tny, tnz] = tgtDims;
  const result = new Uint8Array(tnx * tny * tnz);
  // Match scipy.ndimage.zoom(order=0): source = floor((output + 0.5) * srcSize / dstSize)
  for (let z = 0; z < tnz; z++) {
    const sz = Math.min(Math.max(0, Math.floor((z + 0.5) * nz / tnz)), nz - 1);
    for (let y = 0; y < tny; y++) {
      const sy = Math.min(Math.max(0, Math.floor((y + 0.5) * ny / tny)), ny - 1);
      for (let x = 0; x < tnx; x++) {
        const sx = Math.min(Math.max(0, Math.floor((x + 0.5) * nx / tnx)), nx - 1);
        result[x + y*tnx + z*tnx*tny] = data[sx + sy*nx + sz*nx*ny];
      }
    }
  }
  return result;
}

function transposeXYZToZYX(data, dims, OutputCtor) {
  const [nx, ny, nz] = dims;
  const result = new (OutputCtor || Float32Array)(data.length);
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        result[z + y*nz + x*nz*ny] = data[x + y*nx + z*nx*ny];
      }
    }
  }
  return { data: result, dims: [nz, ny, nx] };
}

function transposeZYXToXYZ(data, dims, OutputCtor) {
  const [nz, ny, nx] = dims;
  const result = new (OutputCtor || Uint8Array)(data.length);
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        result[x + y*nx + z*nx*ny] = data[z + y*nz + x*nz*ny];
      }
    }
  }
  return { data: result, dims: [nx, ny, nz] };
}

function inverseOrient(data, dims, perm, flip, origDims) {
  const [dx, dy, dz] = dims;
  const [nx, ny, nz] = origDims;
  const result = new Uint8Array(nx * ny * nz);
  for (let oz = 0; oz < dz; oz++) {
    for (let oy = 0; oy < dy; oy++) {
      for (let ox = 0; ox < dx; ox++) {
        const coords = [ox, oy, oz];
        const src = [0, 0, 0];
        for (let i = 0; i < 3; i++) {
          src[perm[i]] = flip[i] ? (dims[i] - 1 - coords[i]) : coords[i];
        }
        const srcIdx = ox + oy*dx + oz*dx*dy;
        const dstIdx = src[0] + src[1]*nx + src[2]*nx*ny;
        result[dstIdx] = data[srcIdx];
      }
    }
  }
  return result;
}

function inverseOrientFloat32(data, dims, perm, flip, origDims) {
  const [dx, dy, dz] = dims;
  const [nx, ny, nz] = origDims;
  const result = new Float32Array(nx * ny * nz);
  for (let oz = 0; oz < dz; oz++) {
    for (let oy = 0; oy < dy; oy++) {
      for (let ox = 0; ox < dx; ox++) {
        const coords = [ox, oy, oz];
        const src = [0, 0, 0];
        for (let i = 0; i < 3; i++) {
          src[perm[i]] = flip[i] ? (dims[i] - 1 - coords[i]) : coords[i];
        }
        const srcIdx = ox + oy*dx + oz*dx*dy;
        const dstIdx = src[0] + src[1]*nx + src[2]*nx*ny;
        result[dstIdx] = data[srcIdx];
      }
    }
  }
  return result;
}

function shouldUseZYXModelAxisOrder(preprocessing, dims, patchSize) {
  const modelAxisOrder = preprocessing?.modelAxisOrder;
  if (modelAxisOrder === 'zyx') return true;
  if (modelAxisOrder !== 'zyx-if-x-short-z-long') return false;

  const [nx, , nz] = dims;
  const [px] = Array.isArray(patchSize) ? patchSize : [];
  return Number.isFinite(px) && nx < px && nz >= px;
}

// ==================== Model Loading ====================

// Model byte cache backed by the Cache Storage API.
// Stored as Response objects keyed by the manifest entry's cacheKey (or by
// URL when no key is configured). Retrieving avoids re-downloading and is
// shared with web/js/modules/atlas-loader.js so the same cache works for
// atlases and connectomes too (different cache name there).
async function _openModelCache() {
  if (typeof caches === 'undefined') return null;
  return caches.open(MODEL_CACHE_NAME);
}

async function fetchModel(url, modelName, progressBase, progressSpan, localFallbackUrl = null) {
  const displayName = modelName || url.split('/').pop();
  const cacheKey = self._modelCacheKey || `${url}?v=${self._appVersion || ''}`;

  const cache = await _openModelCache();
  if (cache) {
    try {
      const cached = await cache.match(cacheKey);
      if (cached) {
        const buf = await cached.arrayBuffer();
        if (buf.byteLength > 100000) {
          postLog(`Model loaded from cache: ${displayName}`);
          postProgress(progressBase + progressSpan, `Cached: ${displayName}`);
          return buf;
        }
        await cache.delete(cacheKey);
      }
    } catch (e) { /* cache miss; fall through to network */ }
  }

  let lastError = null;
  let response = null;
  const candidates = localFallbackUrl ? [
    { url: localFallbackUrl, attempts: 1, label: 'local dev cache' },
    { url, attempts: 2, label: 'remote' }
  ] : [
    { url, attempts: 2, label: 'remote' }
  ];

  for (const candidate of candidates) {
    for (let attempt = 1; attempt <= candidate.attempts; attempt++) {
      try {
        const retry = attempt > 1 ? ' (retry)' : '';
        postLog(`Downloading: ${displayName} from ${candidate.label}${retry}...`);
        response = await fetch(candidate.url, { cache: attempt > 1 ? 'reload' : 'default' });
        if (response.ok) break;
        lastError = new Error(`Failed to fetch model: ${response.status} ${response.statusText}`);
      } catch (error) {
        lastError = error;
      }
    }
    if (response && response.ok) break;
  }
  if (!response || !response.ok) {
    throw lastError || new Error(`Failed to fetch model: ${displayName}`);
  }

  // Tee the response so we can stream-read for progress AND cache the
  // original Response object (Cache Storage requires a fresh Response).
  const [progressStream, cacheStream] = response.body.tee();

  const contentLength = parseInt(response.headers.get('content-length'), 10);
  const reader = progressStream.getReader();
  const chunks = [];
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (contentLength) {
      const dlProgress = received / contentLength;
      const mb = (received / 1048576).toFixed(1);
      const totalMb = (contentLength / 1048576).toFixed(0);
      postProgress(progressBase + dlProgress * progressSpan, `Downloading ${displayName} (${mb}/${totalMb} MB)`);
    }
  }

  const data = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
  if (data.byteLength <= 100000) {
    throw new Error(`Downloaded model asset is unexpectedly small: ${displayName}`);
  }

  if (cache) {
    try {
      const cachedResponse = new Response(cacheStream, {
        headers: response.headers,
        status: response.status,
        statusText: response.statusText
      });
      await cache.put(cacheKey, cachedResponse);
    } catch (e) {
      postLog(`Warning: could not cache model: ${e.message}`);
    }
  }

  postLog(`Downloaded: ${displayName} (${(received / 1048576).toFixed(1)} MB)`);
  return data.buffer;
}

// ==================== Utility ====================

function getOptimalWasmThreads() {
  return (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
}

// ==================== Step Functions ====================

function loadStateFromInput(inputData, { emitUpdates = false } = {}) {
  if (emitUpdates) {
    postLog('Parsing input volume...');
    postProgress(0.02, 'Reading NIfTI...');
  }

  const { imageData, dims, voxelSize, headerBytes, affine } = parseNiftiInput(inputData);
  const [nx, ny, nz] = dims;
  if (emitUpdates) {
    postLog(`Volume: ${nx}x${ny}x${nz}, spacing: ${voxelSize.map(v => v.toFixed(3)).join('x')}mm`);
  }

  workerState.origDims = [...dims];
  workerState.affine = affine;
  workerState.headerBytes = headerBytes;

  // Orient to RAS
  if (emitUpdates) {
    postProgress(0.04, 'Orienting to RAS...');
    postLog('Orienting to RAS...');
  }
  const { perm, flip } = getOrientationTransform(affine);
  const isIdentity = perm[0] === 0 && perm[1] === 1 && perm[2] === 2 && !flip[0] && !flip[1] && !flip[2];

  workerState.perm = perm;
  workerState.flip = flip;
  workerState.isIdentity = isIdentity;

  if (isIdentity) {
    workerState.origHeaderBytes = headerBytes.slice(0);
    workerState.rasData = imageData;
    workerState.rasDims = [...dims];
    workerState.rasSpacing = [...voxelSize];
  } else {
    workerState.origHeaderBytes = headerBytes.slice(0);

    const oriented = orientToRAS(imageData, dims, perm, flip);
    workerState.rasData = oriented.data;
    workerState.rasDims = oriented.dims;
    workerState.rasSpacing = [voxelSize[perm[0]], voxelSize[perm[1]], voxelSize[perm[2]]];

    // Rewrite headerBytes sform to match the RAS-reoriented data
    const srcVoxel = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      srcVoxel[perm[i]] = flip[i] ? (workerState.rasDims[i] - 1) : 0;
    }
    const origin = [0, 0, 0];
    for (let r = 0; r < 3; r++) {
      origin[r] = affine[r][0] * srcVoxel[0]
                + affine[r][1] * srcVoxel[1]
                + affine[r][2] * srcVoxel[2]
                + affine[r][3];
    }

    const hdrView = new DataView(headerBytes);
    hdrView.setInt16(254, 1, true);
    hdrView.setFloat32(280, workerState.rasSpacing[0], true);
    hdrView.setFloat32(284, 0, true);
    hdrView.setFloat32(288, 0, true);
    hdrView.setFloat32(292, origin[0], true);
    hdrView.setFloat32(296, 0, true);
    hdrView.setFloat32(300, workerState.rasSpacing[1], true);
    hdrView.setFloat32(304, 0, true);
    hdrView.setFloat32(308, origin[1], true);
    hdrView.setFloat32(312, 0, true);
    hdrView.setFloat32(316, 0, true);
    hdrView.setFloat32(320, workerState.rasSpacing[2], true);
    hdrView.setFloat32(324, origin[2], true);
    hdrView.setInt16(252, 0, true);
  }
  if (emitUpdates) {
    postLog(`RAS dims: ${workerState.rasDims.join('x')}`);
  }

  // Clear downstream state
  workerState.segLabelsRAS = null;
  workerState.segMinComponentSize = 10;

  if (emitUpdates) {
    postVolumeInfo({
      rasDims: [...workerState.rasDims],
      rasSpacing: [...workerState.rasSpacing],
      totalSlices: workerState.rasDims[2]
    });
  }
  return {
    origDims: [...workerState.origDims],
    headerBytes: workerState.headerBytes.slice(0),
    origHeaderBytes: workerState.origHeaderBytes.slice(0),
    affine: workerState.affine.map(row => Array.from(row)),
    perm: [...workerState.perm],
    flip: [...workerState.flip],
    isIdentity: workerState.isIdentity,
    rasData: new Float32Array(workerState.rasData),
    rasDims: [...workerState.rasDims],
    rasSpacing: [...workerState.rasSpacing]
  };
}

function stepLoad(inputData) {
  loadStateFromInput(inputData, { emitUpdates: true });

  postProgress(1.0, 'Volume loaded');
  postStepComplete('load');
}

function binaryMaskFromBuffer(maskBuffer, maskDims, expectedDims, label) {
  if (!maskBuffer) return null;
  if (!Array.isArray(maskDims) || maskDims.length !== 3) {
    throw new Error(`${label} dims must be [X,Y,Z]`);
  }
  const dims = maskDims.map(v => Number(v));
  if (dims.some(v => !Number.isInteger(v) || v <= 0)) {
    throw new Error(`${label} dims are invalid: ${maskDims}`);
  }
  if (!dims.every((v, i) => v === expectedDims[i])) {
    throw new Error(
      `${label} dims ${dims.join('x')} must match registration grid ${expectedDims.join('x')}`
    );
  }
  const src = new Uint8Array(maskBuffer);
  const expectedLength = expectedDims[0] * expectedDims[1] * expectedDims[2];
  if (src.length !== expectedLength) {
    throw new Error(`${label} length ${src.length} != ${expectedLength}`);
  }
  const out = new Uint8Array(expectedLength);
  let count = 0;
  for (let i = 0; i < src.length; i++) {
    if (src[i] > 0) {
      out[i] = 1;
      count++;
    }
  }
  if (count === 0) throw new Error(`${label} is empty`);
  return { mask: out, count };
}

function foregroundMaskFromScalar(data, fractionOfMax = 0.05) {
  let max = -Infinity;
  for (let i = 0; i < data.length; i++) {
    const v = Number(data[i]);
    if (v > max) max = v;
  }
  const threshold = (Number.isFinite(max) ? max : 0) * fractionOfMax;
  const mask = new Uint8Array(data.length);
  let count = 0;
  for (let i = 0; i < data.length; i++) {
    if (Number(data[i]) > threshold) {
      mask[i] = 1;
      count++;
    }
  }
  if (count === 0) throw new Error('registration foreground mask is empty');
  return { mask, count };
}

function robustNormalizeMasked(data, mask = null, options = {}) {
  const {
    lowerQuantile = 0.01,
    upperQuantile = 0.99,
    zeroOutside = false,
    maxSamples = 200000
  } = options;
  let selected = 0;
  if (mask) {
    for (let i = 0; i < mask.length; i++) if (mask[i]) selected++;
  } else {
    selected = data.length;
  }
  if (selected === 0) throw new Error('robustNormalizeMasked: empty normalization mask');
  const sampleStep = Math.max(1, Math.floor(selected / maxSamples));
  const samples = [];
  let seen = 0;
  for (let i = 0; i < data.length; i++) {
    if (mask && !mask[i]) continue;
    if ((seen % sampleStep) === 0) samples.push(Number(data[i]) || 0);
    seen++;
  }
  samples.sort((a, b) => a - b);
  const valueAt = (q) => {
    const idx = Math.max(0, Math.min(samples.length - 1, Math.floor(q * (samples.length - 1))));
    return samples[idx];
  };
  const lo = valueAt(lowerQuantile);
  const hi = valueAt(upperQuantile);
  const range = (hi - lo) || 1;
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) {
    if (zeroOutside && mask && !mask[i]) {
      out[i] = 0;
      continue;
    }
    const v = (Number(data[i]) - lo) / range;
    out[i] = v < 0 ? 0 : (v > 1 ? 1 : v);
  }
  return { data: out, lo, hi, selected, sampleCount: samples.length };
}

async function restoreWorkerState(data) {
  resetState();
  loadStateFromInput(data.inputData, { emitUpdates: false });

  const hiddenArtifacts = data.hiddenArtifacts || {};
  workerState.segLabelsRAS = hiddenArtifacts.segmentationState?.segLabelsRAS
    ? new Uint8Array(hiddenArtifacts.segmentationState.segLabelsRAS)
    : null;
  workerState.segMinComponentSize = hiddenArtifacts.segmentationState?.segMinComponentSize ?? 10;

  postLog('Worker state restored');
  self.postMessage({ type: 'state-restored' });
}

async function stepInference(params) {
  if (!workerState.rasData) {
    throw new Error('No volume loaded. Run Load first.');
  }

  const {
    overlap = 0,
    threshold = 0.1,
    minComponentSize = 10,
    taskId,
    modelAssetId,
    modelName,
    patchSize = [64, 64, 64],
    modelBaseUrl,
    supportStatus = 'unvalidated',
    testTimeAugmentation = false,
    cacheKey,
    provenance = {},
    preprocessing = {}
  } = params;

  if (!taskId || !modelAssetId || !modelName) {
    throw new Error('run-inference requires taskId, modelAssetId, and modelName.');
  }
  if (supportStatus !== 'supported') {
    throw new Error(`Task "${taskId}" is ${supportStatus}. Convert and validate model asset "${modelAssetId}" before running inference.`);
  }
  self._currentTaskId = taskId;

  // Download + create ONNX session.
  self._modelCacheKey = cacheKey || `${taskId}:${modelAssetId}:${self._appVersion || ''}`;
  const modelUrl = `${modelBaseUrl}/${modelName}`;
  const modelData = await fetchModel(modelUrl, modelName, 0.05, 0.15);
  self._modelCacheKey = null;

  postProgress(0.22, 'Loading ONNX model...');
  postLog('Creating ONNX InferenceSession (wasm - 3D ops require WASM backend)...');
  const session = await ort.InferenceSession.create(modelData, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all'
  });
  postLog(`Session created. Input: ${session.inputNames}, Output: ${session.outputNames}`);

  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];

  const inferenceStartTime = performance.now();
  let modelInputData = new Float32Array(workerState.rasData);
  let modelInputDims = [...workerState.rasDims];
  let modelOutputToRas = (labels, dims, OutputCtor) => ({ data: labels, dims, ctor: OutputCtor || Uint8Array });

  const targetSpacing = Array.isArray(preprocessing.targetSpacing)
    ? preprocessing.targetSpacing.map((value, index) => value == null ? workerState.rasSpacing[index] : Number(value))
    : null;
  if (targetSpacing) {
    const resampled = resampleVolume(modelInputData, modelInputDims, workerState.rasSpacing, targetSpacing);
    postLog(`Resampled for ${taskId}: ${modelInputDims.join('x')} -> ${resampled.dims.join('x')} at ${targetSpacing.map(v => v.toFixed(3)).join('x')}mm`);
    modelInputData = resampled.data;
    modelInputDims = resampled.dims;
    const previousOutputToRas = modelOutputToRas;
    modelOutputToRas = (labels, dims, OutputCtor) => {
      const restored = previousOutputToRas(labels, dims, OutputCtor);
      return {
        data: resampleLabelsNearest(restored.data, restored.dims, workerState.rasDims),
        dims: [...workerState.rasDims],
        ctor: OutputCtor || Uint8Array
      };
    };
  }

  if (shouldUseZYXModelAxisOrder(preprocessing, modelInputDims, patchSize)) {
    const transposed = transposeXYZToZYX(modelInputData, modelInputDims, Float32Array);
    postLog(`Reordered for ${taskId}: ${modelInputDims.join('x')} xyz -> ${transposed.dims.join('x')} zyx`);
    modelInputData = transposed.data;
    modelInputDims = transposed.dims;
    const previousOutputToRas = modelOutputToRas;
    modelOutputToRas = (labels, dims, OutputCtor) => {
      const restoredAxes = transposeZYXToXYZ(labels, dims, OutputCtor || Uint8Array);
      return previousOutputToRas(restoredAxes.data, restoredAxes.dims, OutputCtor || Uint8Array);
    };
  }

  // Delegate the per-patch inference + sliding-window orchestration to the
  // shared pipeline module, injecting an ORT-backed runPatch callback.
  const result = await InferencePipeline.runInferencePipeline(
    {
      data: modelInputData,
      dims: modelInputDims,
      patchSize
    },
    async (patch, patchDims) => {
      const [p0, p1, p2] = patchDims;
      const voxels = p0 * p1 * p2;
      const inputTensor = new ort.Tensor('float32', patch, [1, 1, p0, p1, p2]);
      const out = await session.run({ [inputName]: inputTensor });
      const raw = out[outputName].data;
      inputTensor.dispose();
      // Collapse 2-channel softmax logits ([bg, stroke], NCHW) to single-
      // channel raw log-odds: `logit_stroke - logit_bg`. The pipeline
      // sigmoids this and thresholds; under the softmax model that yields
      // P(stroke). 1-channel models pass through unchanged.
      if (raw.length === voxels) return raw;
      if (raw.length === 2 * voxels) {
        const collapsed = new Float32Array(voxels);
        for (let i = 0; i < voxels; i++) collapsed[i] = raw[voxels + i] - raw[i];
        return collapsed;
      }
      throw new Error(
        `Unexpected ${outputName} length ${raw.length}; expected ${voxels} (1-channel) or ${2 * voxels} (binary softmax)`
      );
    },
    {
      overlap, threshold, minComponentSize, testTimeAugmentation,
      onLog: (msg) => postLog(msg),
      onProgress: (stepsDone, totalSteps, label) => {
        const elapsed = (performance.now() - inferenceStartTime) / 1000;
        const eta = stepsDone > 0 ? (elapsed / stepsDone) * (totalSteps - stepsDone) : 0;
        const frac = totalSteps > 0 ? stepsDone / totalSteps : 0;
        postProgress(0.25 + 0.55 * frac, `${label} (ETA: ${eta.toFixed(0)}s)`);
      },
      onPatchStats: (pi, s) => {
        postLog(`Patch ${pi} pos=[${s.pos}]: in=[${s.inMin.toFixed(3)},${s.inMax.toFixed(3)}] mean=${s.inMean.toFixed(3)}, logit=[${s.oMin.toFixed(3)},${s.oMax.toFixed(3)}], prob=[${s.pMin.toFixed(4)},${s.pMax.toFixed(4)}] mean=${s.pMean.toFixed(4)}, n>thr=${s.pAbove}`);
      }
    }
  );
  await session.release();
  postLog(`Inference complete in ${((performance.now() - inferenceStartTime) / 1000).toFixed(1)}s`);

  // Stash the unmasked (pre-CC) labels for downstream browser processing.
  postProgress(0.86, 'Inverse transform...');
  const preCleanupRAS = modelOutputToRas(result.preCleanupLabels, result.dims, Uint8Array);
  workerState.segLabelsRAS = new Uint8Array(preCleanupRAS.data);
  workerState.segMinComponentSize = minComponentSize;
  emitSegmentationStateArtifact();

  let outputLabels = modelOutputToRas(result.labels, result.dims, Uint8Array).data;

  // Inverse orient
  if (!workerState.isIdentity) {
    outputLabels = inverseOrient(outputLabels, workerState.rasDims, workerState.perm, workerState.flip, workerState.origDims);
  }

  // Create output NIfTI
  const outputNifti = createOutputNifti(outputLabels, workerState.origHeaderBytes, workerState.origDims);
  postStageData('segmentation', outputNifti, 'Lesion segmentation');

  let finalVoxels = 0;
  for (let i = 0; i < outputLabels.length; i++) {
    if (outputLabels[i] > 0) finalVoxels++;
  }
  postLog(`Output: ${finalVoxels} foreground voxels`);
  if (finalVoxels === 0) {
    postLog(`WARNING: Segmentation is empty. Probability map max=${result.probStats.max.toFixed(4)} (threshold=${threshold}). Try lowering the probability threshold or check input contrast/orientation.`);
  }

  postProgress(1.0, 'Complete');
  postStepComplete('inference');
  postComplete();
}

async function stepDeepIslesInference(params) {
  const {
    overlap = 0.625,
    threshold = 0.5,
    minComponentSize = 30,
    taskId,
    modelAssetId,
    modelName,
    patchSize = [192, 192, 128],
    modelBaseUrl,
    supportStatus = 'unvalidated',
    cacheKey,
    channelOrder = ['ADC', 'TRACE'],
    dwiBuffer,
    adcBuffer
  } = params;

  if (!taskId || !modelAssetId || !modelName) {
    throw new Error('run-deepisles-inference requires taskId, modelAssetId, and modelName.');
  }
  if (!dwiBuffer || !adcBuffer) {
    throw new Error('DeepISLES requires DWI/TRACE and ADC input buffers.');
  }
  if (supportStatus !== 'supported') {
    throw new Error(
      `Task "${taskId}" is ${supportStatus}. DeepISLES browser seed remains benchmark-only until a validated ONNX asset is selected.`
    );
  }
  if (!Array.isArray(channelOrder) || channelOrder.join(',') !== 'ADC,TRACE') {
    throw new Error('DeepISLES channelOrder must be [ADC, TRACE].');
  }
  self._currentTaskId = taskId;

  postProgress(0.02, 'Reading DeepISLES inputs...');
  postLog('Loading DWI/TRACE input for DeepISLES...');
  const dwiState = loadStateFromInput(dwiBuffer, { emitUpdates: true });
  const dwiRasAffine = affineFromHeaderBytes(dwiState.headerBytes);
  postLog('Loading ADC input for DeepISLES...');
  const adcState = loadStateFromInput(adcBuffer, { emitUpdates: false });
  const adcRasAffine = affineFromHeaderBytes(adcState.headerBytes);

  let adcOnDwi = adcState.rasData;
  if (!dimsEqual(adcState.rasDims, dwiState.rasDims) || !affinesClose(adcRasAffine, dwiRasAffine, 1e-3)) {
    postLog('Resampling ADC onto DWI/TRACE grid for DeepISLES.');
    adcOnDwi = resampleAffine(
      adcState.rasData,
      adcState.rasDims,
      adcRasAffine,
      dwiState.rasDims,
      dwiRasAffine,
      'trilinear'
    );
  }

  // Keep the worker state anchored to the DWI/TRACE source so the output
  // NIfTI is written on that grid after inference.
  workerState.origDims = [...dwiState.origDims];
  workerState.affine = dwiState.affine;
  workerState.headerBytes = dwiState.headerBytes.slice(0);
  workerState.origHeaderBytes = dwiState.origHeaderBytes.slice(0);
  workerState.perm = [...dwiState.perm];
  workerState.flip = [...dwiState.flip];
  workerState.isIdentity = dwiState.isIdentity;
  workerState.rasData = new Float32Array(dwiState.rasData);
  workerState.rasDims = [...dwiState.rasDims];
  workerState.rasSpacing = [...dwiState.rasSpacing];

  self._modelCacheKey = cacheKey || `${taskId}:${modelAssetId}:${self._appVersion || ''}`;
  const modelUrl = `${modelBaseUrl}/${modelName}`;
  const modelData = await fetchModel(modelUrl, modelName, 0.05, 0.15);
  self._modelCacheKey = null;

  postProgress(0.20, 'Loading DeepISLES ONNX model...');
  const session = await ort.InferenceSession.create(modelData, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all'
  });
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];

  const inferenceStartTime = performance.now();
  const result = await runDeepIslesMultiChannelPipeline(
    {
      channels: [adcOnDwi, dwiState.rasData],
      dims: dwiState.rasDims,
      patchSize,
      channelOrder
    },
    async (patch, patchDims) => {
      const [p0, p1, p2] = patchDims;
      const voxels = p0 * p1 * p2;
      const inputTensor = new ort.Tensor('float32', patch, [1, 2, p0, p1, p2]);
      const out = await session.run({ [inputName]: inputTensor });
      const raw = out[outputName].data;
      inputTensor.dispose();
      return softmaxStrokeChannel(raw, voxels, 2, 1);
    },
    {
      overlap,
      threshold,
      minComponentSize,
      onLog: (msg) => postLog(msg),
      onProgress: (stepsDone, totalSteps, label) => {
        const elapsed = (performance.now() - inferenceStartTime) / 1000;
        const eta = stepsDone > 0 ? (elapsed / stepsDone) * (totalSteps - stepsDone) : 0;
        const frac = totalSteps > 0 ? stepsDone / totalSteps : 0;
        postProgress(0.25 + 0.55 * frac, `${label} (ETA: ${eta.toFixed(0)}s)`);
      }
    }
  );
  await session.release();
  postLog(`DeepISLES inference complete in ${((performance.now() - inferenceStartTime) / 1000).toFixed(1)}s`);

  let outputLabels = result.labels;
  if (!workerState.isIdentity) {
    outputLabels = inverseOrient(outputLabels, workerState.rasDims, workerState.perm, workerState.flip, workerState.origDims);
  }
  const outputNifti = createOutputNifti(outputLabels, workerState.origHeaderBytes, workerState.origDims);
  postStageData('segmentation', outputNifti, 'DeepISLES lesion seed');

  let finalVoxels = 0;
  for (let i = 0; i < outputLabels.length; i++) {
    if (outputLabels[i] > 0) finalVoxels++;
  }
  postLog(`DeepISLES output: ${finalVoxels} foreground voxels`);
  if (finalVoxels === 0) {
    postLog(`WARNING: DeepISLES seed is empty. Probability map max=${result.probStats.max.toFixed(4)} (threshold=${threshold}).`);
  }
  postProgress(1.0, 'Complete');
  postStepComplete('inference');
  postComplete();
}

// Phase 2a.1 brain extraction. The orchestration lives in
// web/js/modules/brain-extraction.js (a 1:1 port of vesselboost-webapp's
// stepSynthStrip); this adapter wires it into the worker protocol: pulls
// the RAS volume off workerState, fetches the SynthStrip model bytes via
// the shared Cache-Storage-backed fetchModel, runs the pipeline, and
// emits a `brainmask` stageData NIfTI to the orchestrator.
async function stepSynthStrip(params = {}) {
  if (!workerState.rasData) {
    throw new Error('No volume loaded. Run Load first.');
  }

  const {
    modelAssetId = 'lnm-synthstrip',
    modelName = 'synthstrip.onnx',
    modelBaseUrl,
    cacheKey,
    fast = false,
    dilate = false
  } = params;

  if (!modelBaseUrl) {
    throw new Error('run-synthstrip requires modelBaseUrl.');
  }

  self._currentTaskId = modelAssetId;
  self._modelCacheKey = cacheKey || `${modelAssetId}:${self._appVersion || ''}`;
  const modelUrl = `${modelBaseUrl}/${modelName}`;
  const modelArrayBuffer = await fetchModel(modelUrl, modelName, 0.02, 0.10);

  const { mask, voxelCount, coveragePct } = await runSynthStrip({
    rasData: workerState.rasData,
    rasDims: workerState.rasDims,
    rasSpacing: workerState.rasSpacing,
    modelArrayBuffer,
    ort,
    fast,
    dilate,
    onProgress: (frac, label) => postProgress(0.12 + 0.85 * frac, label),
    onLog: (msg) => postLog(msg)
  });

  // The mask comes back in RAS at workerState.rasDims; apply the inverse
  // RAS->native orientation so the saved NIfTI is in the input image's
  // original orientation (matches the segmentation stage).
  let outputMask = mask;
  if (!workerState.isIdentity) {
    outputMask = inverseOrient(
      outputMask,
      workerState.rasDims,
      workerState.perm,
      workerState.flip,
      workerState.origDims
    );
  }
  const outputNifti = createOutputNifti(
    outputMask,
    workerState.origHeaderBytes,
    workerState.origDims
  );
  postStageData('brainmask', outputNifti, 'SynthStrip brain mask');

  postLog(`SynthStrip brain mask: ${voxelCount} voxels (${coveragePct.toFixed(1)}% coverage)`);
  postProgress(1.0, 'Brain extraction complete');
  postStepComplete('brainmask');
}

// Phase 3.4 SynthMorph registration. Takes the patient T1 (already on
// workerState.rasData; *must* be at 160x160x192 1mm — the model's training
// resolution and the LNM webapp's MNI reference grid) and warps it into
// alignment with the lnm-mni160 reference. The integrated displacement
// field is stashed on workerState so a follow-up 'warp-mask' op can apply
// it to lesion / structural masks without re-running the network.
//
// The orchestrator is responsible for resampling / padding the source T1
// to 160x160x192 1mm BEFORE 'load' (e.g. via FSL FLIRT to MNI152 + crop).
// Documented in the lnm-yeo-auto pipeline preconditions; the worker
// surfaces a clear error if the source dims don't match.
async function stepRegister(params = {}) {
  if (!workerState.rasData) {
    throw new Error('No volume loaded. Run Load first.');
  }
  const expected = [160, 160, 192];
  const got = workerState.rasDims;
  if (got[0] !== expected[0] || got[1] !== expected[1] || got[2] !== expected[2]) {
    throw new Error(
      `SynthMorph registration requires source at 160x160x192; got ${got.join('x')}. ` +
      `Pre-process the T1 to this grid (e.g. FSL FLIRT to MNI152 + center-crop) before running.`
    );
  }

  const {
    modelAssetId = 'lnm-synthmorph-mni',
    modelName = 'lnm-synthmorph-mni.onnx',
    modelBaseUrl,
    modelCacheKey,
    referenceAssetId = 'lnm-mni160',
    referenceUrl,
    referenceCacheKey,
    modelLocalUrl,
    modelInputDims = [160, 160, 192],
    svfDims = null,
    executionProviders = ['wasm'],
    brainMaskBuffer = null,
    brainMaskDims = null,
    nbSteps = 7
  } = params;
  if (!modelBaseUrl) throw new Error('run-register requires modelBaseUrl');
  if (!referenceUrl) throw new Error('run-register requires referenceUrl');

  const src = workerState.rasData;

  // Fetch + decode the MNI reference target (cached).
  postProgress(0.10, 'Fetching MNI reference...');
  self._modelCacheKey = referenceCacheKey || `${referenceAssetId}:${self._appVersion || ''}`;
  const refBytes = await fetchModel(referenceUrl, 'lnm-mni160.nii.gz', 0.10, 0.10);
  const refUint8 = new Uint8Array(refBytes);
  let refBuf = refBytes;
  if (refUint8[0] === 0x1f && refUint8[1] === 0x8b) {
    refBuf = nifti.decompress(refBytes);
  }
  if (!nifti.isNIFTI(refBuf)) {
    throw new Error('MNI reference is not a valid NIfTI');
  }
  const refHeader = nifti.readHeader(refBuf);
  workerState.referenceHeaderBytes = copyNiftiHeaderBytes(refBuf);
  workerState.referenceDims = [
    Number(refHeader.dims[1]),
    Number(refHeader.dims[2]),
    Number(refHeader.dims[3])
  ];
  const refImage = nifti.readImage(refHeader, refBuf);
  // Reference was saved as float32 by the build pipeline.
  let targetData = new Float32Array(refImage);
  if (targetData.length !== 160 * 160 * 192) {
    throw new Error(`MNI reference has ${targetData.length} voxels; expected ${160 * 160 * 192}`);
  }

  postProgress(0.15, 'Normalising registration inputs...');
  let sourceNormalized;
  const sourceMask = binaryMaskFromBuffer(
    brainMaskBuffer,
    brainMaskDims,
    expected,
    'registration brain mask'
  );
  if (sourceMask) {
    const targetMask = foregroundMaskFromScalar(targetData, 0.05);
    const sourceNorm = robustNormalizeMasked(src, sourceMask.mask, { zeroOutside: true });
    const targetNorm = robustNormalizeMasked(targetData, targetMask.mask, { zeroOutside: true });
    sourceNormalized = sourceNorm.data;
    targetData = targetNorm.data;
    postLog(
      `SynthMorph masked normalization: source=${sourceMask.count.toLocaleString()} voxels ` +
      `(p01=${sourceNorm.lo.toFixed(3)}, p99=${sourceNorm.hi.toFixed(3)}), ` +
      `target=${targetMask.count.toLocaleString()} voxels ` +
      `(p01=${targetNorm.lo.toFixed(3)}, p99=${targetNorm.hi.toFixed(3)})`
    );
  } else {
    // Keep the no-mask path bit-compatible with existing self-pair smoke
    // coverage: source is min-max scaled and the MNI reference is already
    // stored in the expected [0, 1] range.
    let srcMin = Infinity, srcMax = -Infinity;
    for (let i = 0; i < src.length; i++) {
      const v = src[i];
      if (v < srcMin) srcMin = v;
      if (v > srcMax) srcMax = v;
    }
    const range = (srcMax - srcMin) || 1;
    sourceNormalized = new Float32Array(src.length);
    for (let i = 0; i < src.length; i++) sourceNormalized[i] = (src[i] - srcMin) / range;
  }

  // Fetch the SynthMorph SVF ONNX.
  postProgress(0.20, 'Fetching SynthMorph model...');
  self._modelCacheKey = modelCacheKey || `${modelAssetId}:${self._appVersion || ''}`;
  const modelArrayBuffer = await fetchModel(
    `${modelBaseUrl}/${modelName}`, modelName, 0.20, 0.30, modelLocalUrl
  );

  function normaliseSynthMorphExecutionProviders(value) {
    const requested = Array.isArray(value) ? value : [];
    const names = requested
      .map(ep => typeof ep === 'string' ? ep : ep?.name)
      .filter(ep => typeof ep === 'string' && ep.length > 0);
    const order = [];
    for (const ep of names.length ? names : ['wasm']) {
      if (!order.includes(ep)) order.push(ep);
    }
    if (!order.includes('wasm')) order.push('wasm');
    return order;
  }
  const providerOrder = normaliseSynthMorphExecutionProviders(executionProviders);

  // The model expects channel-last NDHWC: (1, 160, 160, 192, 1) per input.
  // Our F-order data needs a one-pass repack into row-major NDHWC.
  // F-order index: i_F = x + y*X + z*X*Y
  // Row-major NDHWC (C=1): i_R = (x*Y + y)*Z + z
  const X = 160, Y = 160, Z = 192;
  const modelDims = Array.isArray(modelInputDims) && modelInputDims.length === 3
    ? modelInputDims.map(v => Number(v))
    : [X, Y, Z];
  if (modelDims.some(v => !Number.isInteger(v) || v <= 0)) {
    throw new Error(`Invalid SynthMorph modelInputDims: ${modelInputDims}`);
  }

  function maybeResampleToModelGrid(fdata, label) {
    if (modelDims[0] === X && modelDims[1] === Y && modelDims[2] === Z) {
      return fdata;
    }
    const spacing = [X / modelDims[0], Y / modelDims[1], Z / modelDims[2]];
    const resampled = resampleVolume(fdata, [X, Y, Z], [1, 1, 1], spacing);
    if (resampled.dims[0] !== modelDims[0] ||
        resampled.dims[1] !== modelDims[1] ||
        resampled.dims[2] !== modelDims[2]) {
      throw new Error(
        `SynthMorph ${label} downsample produced ${resampled.dims.join('x')}; ` +
        `expected ${modelDims.join('x')}`
      );
    }
    return resampled.data;
  }

  function fOrderToNDHWC(fdata, dims) {
    const [mX, mY, mZ] = dims;
    const out = new Float32Array(mX * mY * mZ);
    for (let z = 0; z < mZ; z++) {
      for (let y = 0; y < mY; y++) {
        for (let x = 0; x < mX; x++) {
          out[(x * mY + y) * mZ + z] = fdata[x + y * mX + z * mX * mY];
        }
      }
    }
  return out;
}

function affineFromHeaderBytes(headerBytes) {
  return extractAffine(new DataView(headerBytes)).map(row => Array.from(row));
}

function dimsEqual(a, b) {
  return Array.isArray(a) && Array.isArray(b) &&
    a.length === b.length &&
    a.every((value, index) => Number(value) === Number(b[index]));
}

function affinesClose(a, b, tolerance = 1e-3) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) {
      if (Math.abs(Number(a[r]?.[c]) - Number(b[r]?.[c])) > tolerance) return false;
    }
  }
  return true;
}

function nonzeroZScore(data) {
  let count = 0;
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    const value = data[i];
    if (value !== 0 && Number.isFinite(value)) {
      count++;
      sum += value;
    }
  }
  const mean = count > 0 ? sum / count : 0;
  let sumSq = 0;
  for (let i = 0; i < data.length; i++) {
    const value = data[i];
    if (value !== 0 && Number.isFinite(value)) {
      const d = value - mean;
      sumSq += d * d;
    }
  }
  const std = count > 0 ? Math.sqrt(sumSq / count) || 1 : 1;
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const value = data[i];
    out[i] = Number.isFinite(value) ? (value - mean) / std : 0;
  }
  return out;
}

function zeroPadChannelsToPatchMultiple(channels, dims, patchSize) {
  const [nx, ny, nz] = dims;
  const [px, py, pz] = patchSize;
  const pad = (d, p) => d > p && d % p !== 0 ? Math.ceil(d / p) * p : d < p ? p : d;
  const outDims = [pad(nx, px), pad(ny, py), pad(nz, pz)];
  if (outDims[0] === nx && outDims[1] === ny && outDims[2] === nz) {
    return { channels, dims: outDims };
  }
  const outChannels = channels.map(() => new Float32Array(outDims[0] * outDims[1] * outDims[2]));
  for (let c = 0; c < channels.length; c++) {
    const src = channels[c];
    const dst = outChannels[c];
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          dst[x + y * outDims[0] + z * outDims[0] * outDims[1]] = src[x + y * nx + z * nx * ny];
        }
      }
    }
  }
  return { channels: outChannels, dims: outDims };
}

function extractMultiChannelPatch(channels, volumeDims, position, patchDims) {
  const [vx, vy, vz] = volumeDims;
  const [px, py, pz] = patchDims;
  const [ox, oy, oz] = position;
  const patchVoxels = px * py * pz;
  const patch = new Float32Array(channels.length * patchVoxels);
  for (let c = 0; c < channels.length; c++) {
    const src = channels[c];
    const channelOffset = c * patchVoxels;
    for (let z = 0; z < pz; z++) {
      const gz = oz + z;
      if (gz < 0 || gz >= vz) continue;
      for (let y = 0; y < py; y++) {
        const gy = oy + y;
        if (gy < 0 || gy >= vy) continue;
        for (let x = 0; x < px; x++) {
          const gx = ox + x;
          if (gx < 0 || gx >= vx) continue;
          patch[channelOffset + x * py * pz + y * pz + z] = src[gx + gy * vx + gz * vx * vy];
        }
      }
    }
  }
  return patch;
}

function softmaxStrokeChannel(raw, voxels, channels = 2, strokeChannel = 1) {
  if (raw.length === voxels) {
    const out = new Float32Array(voxels);
    for (let i = 0; i < voxels; i++) out[i] = 1 / (1 + Math.exp(-raw[i]));
    return out;
  }
  if (raw.length !== channels * voxels) {
    throw new Error(`Unexpected DeepISLES output length ${raw.length}; expected ${voxels} or ${channels * voxels}`);
  }
  const out = new Float32Array(voxels);
  for (let i = 0; i < voxels; i++) {
    let maxLogit = -Infinity;
    for (let c = 0; c < channels; c++) {
      const value = raw[c * voxels + i];
      if (value > maxLogit) maxLogit = value;
    }
    let denom = 0;
    for (let c = 0; c < channels; c++) denom += Math.exp(raw[c * voxels + i] - maxLogit);
    out[i] = Math.exp(raw[strokeChannel * voxels + i] - maxLogit) / Math.max(denom, 1e-12);
  }
  return out;
}

async function runDeepIslesMultiChannelPipeline(input, runPatch, options = {}) {
  const overlap = options.overlap ?? 0.625;
  const threshold = options.threshold ?? 0.5;
  const minComponentSize = options.minComponentSize ?? 30;
  const onLog = options.onLog || (() => {});
  const onProgress = options.onProgress || (() => {});
  let channels = input.channels.map(channel => nonzeroZScore(channel));
  let dims = [...input.dims];
  const patchSize = input.patchSize;
  const prePadDims = [...dims];
  const padded = zeroPadChannelsToPatchMultiple(channels, dims, patchSize);
  channels = padded.channels;
  dims = padded.dims;
  if (!dimsEqual(prePadDims, dims)) {
    onLog(`Padded DeepISLES inputs: ${prePadDims.join('x')} -> ${dims.join('x')}`);
  }

  const positions = InferencePipeline.computePatchPositions3D(dims, patchSize, overlap);
  const weights = InferencePipeline.computeGaussianWeightMap3D(patchSize[0], patchSize[1], patchSize[2], 8);
  const totalVoxels = dims[0] * dims[1] * dims[2];
  const patchVoxels = patchSize[0] * patchSize[1] * patchSize[2];
  const probAccum = new Float32Array(totalVoxels);
  const weightAccum = new Float32Array(totalVoxels);
  onLog(`Starting DeepISLES inference: ${positions.length} patches (${patchSize.join('x')}), overlap=${overlap}, channelOrder=${input.channelOrder.join(',')}`);
  for (let pi = 0; pi < positions.length; pi++) {
    const patch = extractMultiChannelPatch(channels, dims, positions[pi], patchSize);
    const probabilities = await runPatch(patch, patchSize);
    InferencePipeline.accumulatePatch3D(probAccum, weightAccum, dims, positions[pi], probabilities, weights, patchSize);
    onProgress(pi + 1, positions.length, `DeepISLES patch ${pi + 1}/${positions.length}`);
    if (pi < 5) {
      let pMax = -Infinity;
      let pAbove = 0;
      for (let i = 0; i < patchVoxels; i++) {
        if (probabilities[i] > pMax) pMax = probabilities[i];
        if (probabilities[i] >= threshold) pAbove++;
      }
      onLog(`DeepISLES patch ${pi} pos=[${positions[pi]}]: prob max=${pMax.toFixed(4)}, n>thr=${pAbove}`);
    }
  }

  const binary = new Uint8Array(totalVoxels);
  let pMax = -Infinity;
  for (let i = 0; i < totalVoxels; i++) {
    const p = weightAccum[i] > 0 ? probAccum[i] / weightAccum[i] : 0;
    if (p > pMax) pMax = p;
    if (p >= threshold) binary[i] = 1;
  }
  let labels = binary;
  if (!dimsEqual(prePadDims, dims)) {
    labels = InferencePipeline.unpadVolume(labels, dims, prePadDims, Uint8Array);
  }
  if (minComponentSize > 1) {
    labels = InferencePipeline.removeSmallComponents(labels, prePadDims, minComponentSize);
  }
  return { labels, dims: prePadDims, probStats: { max: pMax } };
}

  const sourceModel = maybeResampleToModelGrid(sourceNormalized, 'source');
  const targetModel = maybeResampleToModelGrid(targetData, 'target');
  if (modelDims[0] !== X || modelDims[1] !== Y || modelDims[2] !== Z) {
    postLog(`SynthMorph browser grid: ${X}x${Y}x${Z} -> ${modelDims.join('x')}`);
  }
  const sourceNHWC = fOrderToNDHWC(sourceModel, modelDims);
  const targetNHWC = fOrderToNDHWC(targetModel, modelDims);

  postProgress(0.55, 'Building SynthMorph session...');
  postLog(`SynthMorph EP candidates=${providerOrder.join(',')}`);
  let svfFlat;
  let outputDims = svfDims;
  let chosenEp = null;
  let forwardSeconds = 0;
  let lastError = null;
  for (let i = 0; i < providerOrder.length && !svfFlat; i++) {
    const ep = providerOrder[i];
    let session;
    let sourceTensor;
    let targetTensor;
    try {
      session = await ort.InferenceSession.create(modelArrayBuffer, {
        executionProviders: [ep],
        graphOptimizationLevel: 'all'
      });
      const inputNames = session.inputNames;
      const outputName = session.outputNames[0];
      postLog(`SynthMorph EP candidate=${ep}`);
      postLog(`SynthMorph session ready (inputs=${inputNames.join(',')}, output=${outputName})`);

      postProgress(0.60, 'Running SynthMorph (single-pass, ~30 s)...');
      sourceTensor = new ort.Tensor('float32', sourceNHWC, [1, ...modelDims, 1]);
      targetTensor = new ort.Tensor('float32', targetNHWC, [1, ...modelDims, 1]);
      const t0 = performance.now();
      const out = await session.run({
        [inputNames[0]]: sourceTensor,
        [inputNames[1]]: targetTensor
      });
      forwardSeconds = (performance.now() - t0) / 1000;
      const outputTensor = out[outputName];
      svfFlat = outputTensor.data;
      chosenEp = ep;
      postLog(`SynthMorph EP=${ep}`);
      if (Array.isArray(outputTensor.dims) && outputTensor.dims.length === 5) {
        outputDims = outputTensor.dims.slice(1, 4);
      }
    } catch (err) {
      lastError = err;
      const nextEp = providerOrder[i + 1];
      if (nextEp) {
        postLog(`SynthMorph EP ${ep} failed (${err?.message || err}); trying ${nextEp}.`);
      }
    } finally {
      sourceTensor?.dispose?.();
      targetTensor?.dispose?.();
      session?.release?.();
    }
  }
  if (!svfFlat) {
    throw lastError || new Error('SynthMorph failed for all execution providers.');
  }
  if (!Array.isArray(outputDims) || outputDims.length !== 3) {
    outputDims = modelDims.map(v => v / 2);
  }
  const halfDims = outputDims.map(v => Number(v));
  postLog(
    `SynthMorph forward in ${forwardSeconds.toFixed(1)}s (${chosenEp}); ` +
    `SVF shape=${halfDims.join('x')}x3`
  );

  // Integrate SVF (scaling-and-squaring) and upsample to full-res. Both
  // run in pure JS — see web/js/modules/registration.js. svfFlat is
  // already in row-major NDHWC, which is what registration.js expects.
  postProgress(0.85, 'Integrating SVF (scaling-and-squaring)...');
  const halfDisp = integrateSvf(svfFlat, halfDims, nbSteps);

  postProgress(0.95, 'Upsampling displacement to full resolution...');
  const fullDims = [X, Y, Z];
  const fullDisp = upsampleDisplacementField(halfDisp, halfDims, fullDims);

  workerState.displacementField = fullDisp;
  workerState.displacementDims = fullDims;
  postLog(`Displacement field: ${fullDisp.length.toLocaleString()} floats stored on worker state`);

  postProgress(0.98, 'Preparing registration QC outputs...');
  const registeredT1 = warpVolume(sourceNormalized, fullDims, fullDisp, fullDims);
  const registeredNifti = createFloat32Nifti(
    registeredT1,
    workerState.referenceHeaderBytes,
    workerState.referenceDims || fullDims,
    [1, 1, 1]
  );
  postStageData(
    'registered-t1-mni160',
    registeredNifti,
    'Moving T1 warped to the fixed MNI160 grid'
  );

  const displacementMagnitude = displacementMagnitudeField(fullDisp, fullDims);
  const displacementNifti = createFloat32Nifti(
    displacementMagnitude,
    workerState.referenceHeaderBytes,
    workerState.referenceDims || fullDims,
    [1, 1, 1]
  );
  postStageData(
    'registration-displacement-mag',
    displacementNifti,
    'SynthMorph displacement magnitude on the fixed MNI160 grid'
  );
  postProgress(1.0, 'Registration complete');
  postStepComplete('register');
}

// Phase 3.5 helper: apply the integrated displacement field (left on
// workerState by stepRegister) to a binary mask and emit the warped result.
// The mask is passed in as F-order voxel bytes via the message data; the
// orchestrator decodes a NIfTI before posting.
async function stepWarpMask(params = {}) {
  if (!workerState.displacementField) {
    throw new Error('No displacement available. Run Register first.');
  }
  const {
    maskBuffer,        // Uint8Array of F-order voxels, length = 160*160*192
    maskDims = [160, 160, 192]
  } = params;
  if (!maskBuffer) throw new Error('warp-mask requires maskBuffer');

  postProgress(0.10, 'Warping mask...');
  // warpVolume expects Float32Array; coerce.
  const mask = new Uint8Array(maskBuffer);
  const maskF32 = new Float32Array(mask.length);
  for (let i = 0; i < mask.length; i++) maskF32[i] = mask[i];
  const warped = warpVolume(maskF32, maskDims, workerState.displacementField, workerState.displacementDims);
  const warpedBin = new Uint8Array(warped.length);
  for (let i = 0; i < warped.length; i++) warpedBin[i] = warped[i] > 0.5 ? 1 : 0;

  // Wrap as NIfTI sharing the fixed MNI160 target header. The warped voxels
  // are on the SynthMorph reference grid, not the source/prealign affine.
  postProgress(0.85, 'Wrapping warped mask as NIfTI...');
  const outNifti = createOutputNifti(
    warpedBin,
    workerState.referenceHeaderBytes || workerState.origHeaderBytes,
    workerState.referenceDims || workerState.origDims
  );
  postStageData('mni-lesion', outNifti, 'Lesion mask warped to MNI 1mm');

  postProgress(1.0, 'Mask warp complete');
  postStepComplete('warp-mask');
}

async function stepInverseWarpMask(params = {}) {
  if (!workerState.displacementField) {
    throw new Error('No displacement available. Run Register first.');
  }
  const {
    maskBuffer,
    maskDims = [160, 160, 192],
    stage = 'threshold-patient',
    description = 'Threshold map projected to patient T1 space',
    labelMap = false,
    labelDataType = 'uint8',
    iterations = 8
  } = params;
  if (!maskBuffer) throw new Error('inverse-warp-mask requires maskBuffer');

  postProgress(0.10, 'Projecting threshold map to patient space...');
  const mask = labelMap && labelDataType === 'uint16'
    ? new Uint16Array(maskBuffer)
    : new Uint8Array(maskBuffer);
  const maskF32 = new Float32Array(mask.length);
  for (let i = 0; i < mask.length; i++) maskF32[i] = mask[i];
  const projected = inverseWarpVolume(
    maskF32,
    maskDims,
    workerState.displacementField,
    workerState.displacementDims,
    { mode: 'nearest', iterations }
  );
  const projectedOut = labelMap && labelDataType === 'uint16'
    ? new Uint16Array(projected.length)
    : new Uint8Array(projected.length);
  for (let i = 0; i < projected.length; i++) {
    if (labelMap) {
      const label = Math.round(projected[i]);
      projectedOut[i] = label > 0 ? label : 0;
    } else {
      projectedOut[i] = projected[i] > 0.5 ? 1 : 0;
    }
  }

  postProgress(0.85, labelMap
    ? 'Wrapping patient-space atlas as NIfTI...'
    : 'Wrapping patient-space threshold map as NIfTI...');
  const outNifti = createOutputNifti(projectedOut, workerState.origHeaderBytes, workerState.origDims);
  postStageData(stage, outNifti, description);

  postProgress(1.0, labelMap ? 'Atlas projection complete' : 'Threshold projection complete');
  postStepComplete('inverse-warp-mask');
}

// ==================== Message Handler ====================

self.onmessage = async (e) => {
  const { type, data } = e.data;
  // nifti-reader-js is loaded lazily (see top-of-file comment) so the
  // module-worker's first messages don't get dropped during a top-level
  // await. Wait once per message so handlers can safely read `nifti`.
  try {
    await niftiReady;
  } catch (err) {
    postError(`Worker boot failed: ${err.message}`);
    return;
  }

  switch (type) {
    case 'init':
      try {
        self._appVersion = e.data.version || '';
        ort.env.wasm.numThreads = getOptimalWasmThreads();
        ort.env.wasm.wasmPaths = '../wasm/';
        postLog(`ORT WASM backend ready (${ort.env.wasm.numThreads} threads)`);
        self.postMessage({ type: 'initialized' });
      } catch (error) {
        postError(`Initialization failed: ${error.message}`);
      }
      break;

    case 'load':
      try {
        stepLoad(data.inputData);
      } catch (error) {
        console.error('Load error:', error);
        postError(error?.message || String(error));
      }
      break;

    case 'run-inference':
      try {
        await stepInference(data || {});
      } catch (error) {
        console.error('Inference error:', error);
        postError(error?.message || String(error));
      }
      break;

    case 'run-deepisles-inference':
      try {
        await stepDeepIslesInference(data || {});
      } catch (error) {
        console.error('DeepISLES inference error:', error);
        postError(error?.message || String(error));
      }
      break;

    case 'run-synthstrip':
      try {
        await stepSynthStrip(data || {});
      } catch (error) {
        console.error('SynthStrip error:', error);
        postError(error?.message || String(error));
      }
      break;

    case 'run-register':
      try {
        await stepRegister(data || {});
      } catch (error) {
        console.error('Register error:', error);
        postError(error?.message || String(error));
      }
      break;

    case 'warp-mask':
      try {
        await stepWarpMask(data || {});
      } catch (error) {
        console.error('Warp-mask error:', error);
        postError(error?.message || String(error));
      }
      break;

    case 'inverse-warp-mask':
      try {
        await stepInverseWarpMask(data || {});
      } catch (error) {
        console.error('Inverse-warp-mask error:', error);
        postError(error?.message || String(error));
      }
      break;

    case 'reset-state':
      resetState();
      postLog('Worker state reset');
      break;

    case 'restore-state':
      try {
        await restoreWorkerState(data || {});
      } catch (error) {
        console.error('Restore error:', error);
        postError(error?.message || String(error));
      }
      break;
  }
};
