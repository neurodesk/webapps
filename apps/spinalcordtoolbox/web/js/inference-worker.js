/**
 * SpinalCordToolbox Inference Worker
 *
 * Runs ONNX model inference for 3D patch-based SCT segmentation.
 * Pipeline is split into interactive steps:
 *   1. Load (NIfTI parse + orient to RAS)
 *   2. Inference (resample → normalize → crop → sliding window → threshold → CC → inverse)
 */

/* global importScripts, ort, localforage, nifti, SCTInferencePipeline, SCTLesionAnalysis, TotalSpineSeg */

importScripts('../wasm/ort.webgpu.min.js');
importScripts('https://cdn.jsdelivr.net/npm/localforage@1.10.0/dist/localforage.min.js');
importScripts('../nifti-js/index.js');
importScripts('./inference-pipeline.js');
importScripts('./modules/lesion-analysis.js');
importScripts('./modules/vertebrae.js');
importScripts('./modules/totalspineseg.js');

const FIXED_TARGET_SPACING = [0.3, 0.3, 0.3];
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
  lesionLabelsRAS: null,
  segMinComponentSize: 10,
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
    lesionLabelsRAS: null,
    segMinComponentSize: 10,
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
    { type: 'stageData', kind: 'nifti', stage, niftiData, description, taskId: self._currentTaskId || 'spinalcord' },
    [niftiData]
  );
}

function postMetricsData(stage, metrics, description) {
  self.postMessage({
    type: 'stageData',
    kind: 'metrics',
    stage,
    rows: metrics.rows || [],
    summary: metrics.summary || null,
    csv: metrics.csv || '',
    filename: metrics.filename,
    description,
    taskId: self._currentTaskId || 'spinalcord'
  });
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

function createOutputNifti(uint8Data, sourceHeader, dims) {
  const srcView = new DataView(sourceHeader);
  const voxOffset = srcView.getFloat32(108, true);
  const headerSize = Math.ceil(voxOffset);

  const buffer = new ArrayBuffer(headerSize + uint8Data.length);
  const destBytes = new Uint8Array(buffer);
  const destView = new DataView(buffer);

  destBytes.set(new Uint8Array(sourceHeader).slice(0, headerSize));

  // Set datatype to UINT8
  destView.setInt16(70, 2, true);
  destView.setInt16(72, 8, true);

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
  for (let i = 0; i < uint8Data.length; i++) {
    if (uint8Data[i] > maxVal) maxVal = uint8Data[i];
  }
  destView.setFloat32(124, Math.max(1, maxVal), true);  // cal_max
  destView.setFloat32(128, 0, true);                    // cal_min

  new Uint8Array(buffer, headerSize).set(uint8Data);
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

function flipVolumeAxes(data, dims, axes, OutputCtor) {
  const [nx, ny, nz] = dims;
  const result = new (OutputCtor || data.constructor || Uint8Array)(data.length);
  const flipX = axes.includes(0);
  const flipY = axes.includes(1);
  const flipZ = axes.includes(2);
  for (let z = 0; z < nz; z++) {
    const sz = flipZ ? nz - 1 - z : z;
    for (let y = 0; y < ny; y++) {
      const sy = flipY ? ny - 1 - y : y;
      for (let x = 0; x < nx; x++) {
        const sx = flipX ? nx - 1 - x : x;
        result[x + y*nx + z*nx*ny] = data[sx + sy*nx + sz*nx*ny];
      }
    }
  }
  return { data: result, dims: [...dims] };
}

function orientationFlipAxesFromRAS(modelOrientation) {
  if (!modelOrientation || modelOrientation === 'RAS') return [];
  if (modelOrientation === 'RPI') return [1, 2];
  if (modelOrientation === 'LPI') return [0, 1, 2];
  throw new Error(`Unsupported modelOrientation "${modelOrientation}"`);
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

async function fetchModel(url, modelName, progressBase, progressSpan) {
  const displayName = modelName || url.split('/').pop();
  const cacheKey = self._modelCacheKey || `${url}?v=${self._appVersion || ''}`;

  try {
    const cached = await localforage.getItem(cacheKey);
    if (cached && cached.byteLength > 100000) {
      postLog(`Model loaded from cache: ${displayName}`);
      postProgress(progressBase + progressSpan, `Cached: ${displayName}`);
      return cached;
    }
  } catch (e) { /* cache miss */ }

  let response = null;
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      postLog(`Downloading: ${displayName}${attempt > 1 ? ' (retry)' : ''}...`);
      response = await fetch(url, { cache: attempt > 1 ? 'reload' : 'default' });
      if (response.ok) break;
      lastError = new Error(`Failed to fetch model: ${response.status} ${response.statusText}`);
    } catch (error) {
      lastError = error;
    }
  }
  if (!response || !response.ok) {
    throw lastError || new Error(`Failed to fetch model: ${displayName}`);
  }

  const contentLength = parseInt(response.headers.get('content-length'), 10);
  const reader = response.body.getReader();
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
    try {
      await localforage.removeItem(cacheKey);
    } catch (e) { /* ignore cleanup failure */ }
    throw new Error(`Downloaded model asset is unexpectedly small: ${displayName}`);
  }

  try {
    await localforage.setItem(cacheKey, data.buffer);
  } catch (e) {
    postLog('Warning: Could not cache model (storage full?)');
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
  workerState.lesionLabelsRAS = null;
  workerState.segMinComponentSize = 10;

  // Post volume info for UI
  postVolumeInfo({
    rasDims: [...workerState.rasDims],
    rasSpacing: [...workerState.rasSpacing],
    totalSlices: workerState.rasDims[2]
  });
}

function stepLoad(inputData) {
  loadStateFromInput(inputData, { emitUpdates: true });

  postProgress(1.0, 'Volume loaded');
  postStepComplete('load');
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
    keepLargestComponent = false,
    taskId = 'spinalcord',
    modelAssetId = 'sct-spinalcord',
    modelName = 'sct-spinalcord.onnx',
    modelUrl,
    patchSize = [64, 64, 64],
    modelBaseUrl,
    supportStatus = 'unvalidated',
    testTimeAugmentation = false,
    cacheKey,
    provenance = {},
    preprocessing = {},
    output = {}
  } = params;

  if (supportStatus !== 'supported') {
    throw new Error(`SCT task "${taskId}" is ${supportStatus}. Convert and validate model asset "${modelAssetId}" before running inference.`);
  }
  self._currentTaskId = taskId;

  // Download + create ONNX session.
  self._modelCacheKey = cacheKey || `${taskId}:${modelAssetId}:${self._appVersion || ''}`;
  const resolvedModelUrl = modelUrl || `${modelBaseUrl}/${modelName}`;
  const modelData = await fetchModel(resolvedModelUrl, modelName, 0.05, 0.15);
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
    const spacingText = targetSpacing.map(v => v.toFixed(3)).join('x');
    const modelOrderSpacing = preprocessing.modelAxisOrder === 'zyx'
      ? [targetSpacing[2], targetSpacing[1], targetSpacing[0]]
      : targetSpacing;
    const modelOrderText = modelOrderSpacing.map(v => v.toFixed(3)).join('x');
    postLog(`Resampled for ${taskId}: ${modelInputDims.join('x')} -> ${resampled.dims.join('x')} at ${spacingText} mm RAS/XYZ (model order ${modelOrderText} mm)`);
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

  const modelOrientationFlipAxes = orientationFlipAxesFromRAS(preprocessing.modelOrientation);
  if (modelOrientationFlipAxes.length > 0) {
    const oriented = flipVolumeAxes(modelInputData, modelInputDims, modelOrientationFlipAxes, Float32Array);
    postLog(`Reoriented for ${taskId}: RAS -> ${preprocessing.modelOrientation}`);
    modelInputData = oriented.data;
    modelInputDims = oriented.dims;
    const previousOutputToRas = modelOutputToRas;
    modelOutputToRas = (labels, dims, OutputCtor) => {
      const restored = flipVolumeAxes(labels, dims, modelOrientationFlipAxes, OutputCtor || Uint8Array);
      return previousOutputToRas(restored.data, restored.dims, OutputCtor || Uint8Array);
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

  const runPatch = async (patch, patchDims) => {
    const [p0, p1, p2] = patchDims;
    const inputTensor = new ort.Tensor('float32', patch, [1, 1, p0, p1, p2]);
    const out = await session.run({ [inputName]: inputTensor });
    const logits = out[outputName].data;
    inputTensor.dispose();
    return logits;
  };

  const progressHandler = (stepsDone, totalSteps, label) => {
    const elapsed = (performance.now() - inferenceStartTime) / 1000;
    const eta = stepsDone > 0 ? (elapsed / stepsDone) * (totalSteps - stepsDone) : 0;
    const frac = totalSteps > 0 ? stepsDone / totalSteps : 0;
    postProgress(0.25 + 0.55 * frac, `${label} (ETA: ${eta.toFixed(0)}s)`);
  };

  if (output.activation === 'sigmoid-regions') {
    const regions = Array.isArray(output.regions) ? output.regions : [];
    const channelCount = output.channelCount || output.channelOrder?.length || regions.length || 1;
    const result = await SCTInferencePipeline.runRegionInferencePipeline(
      {
        data: modelInputData,
        dims: modelInputDims,
        patchSize
      },
      runPatch,
      {
        overlap,
        threshold,
        minComponentSize,
        testTimeAugmentation,
        channelCount,
        regions,
        onLog: (msg) => postLog(msg),
        onProgress: progressHandler,
        onPatchStats: (pi, s) => {
          const channelText = s.channels.map(channel => (
            `c${channel.channel}: logit=[${channel.oMin.toFixed(3)},${channel.oMax.toFixed(3)}], prob=[${channel.pMin.toFixed(4)},${channel.pMax.toFixed(4)}] mean=${channel.pMean.toFixed(4)}, n>thr=${channel.pAbove}`
          )).join('; ');
          postLog(`Patch ${pi} pos=[${s.pos}]: in=[${s.inMin.toFixed(3)},${s.inMax.toFixed(3)}] mean=${s.inMean.toFixed(3)}; ${channelText}`);
        }
      }
    );
    await session.release();
    postLog(`Inference complete in ${((performance.now() - inferenceStartTime) / 1000).toFixed(1)}s`);

    postProgress(0.86, 'Inverse transform...');
    let spinalCordRAS = null;
    let lesionRAS = null;
    for (const region of result.regions) {
      const stage = region.stage || region.name || `channel_${region.channel}`;
      const description = region.description || (stage === 'lesion' ? 'SCI lesion segmentation' : 'SCT segmentation');
      const preCleanupRAS = modelOutputToRas(region.preCleanupLabels, region.dims, Uint8Array);
      const outputRAS = modelOutputToRas(region.labels, region.dims, Uint8Array);
      if (stage === 'segmentation') {
        workerState.segLabelsRAS = new Uint8Array(preCleanupRAS.data);
        workerState.segMinComponentSize = minComponentSize;
        spinalCordRAS = new Uint8Array(outputRAS.data);
      }
      if (stage === 'lesion') {
        workerState.lesionLabelsRAS = new Uint8Array(outputRAS.data);
        lesionRAS = new Uint8Array(outputRAS.data);
      }

      let outputLabels = new Uint8Array(outputRAS.data);
      if (!workerState.isIdentity) {
        outputLabels = inverseOrient(outputLabels, workerState.rasDims, workerState.perm, workerState.flip, workerState.origDims);
      }
      const outputNifti = createOutputNifti(outputLabels, workerState.origHeaderBytes, workerState.origDims);
      postStageData(stage, outputNifti, description);

      let finalVoxels = 0;
      for (let i = 0; i < outputLabels.length; i++) {
        if (outputLabels[i] > 0) finalVoxels++;
      }
      postLog(`${stage}: ${finalVoxels} foreground voxels`);
      if (finalVoxels === 0) {
        const stats = region.probStats;
        postLog(`WARNING: ${stage} mask is empty. Probability map max=${stats?.max?.toFixed?.(4) || 'n/a'} (threshold=${region.threshold}).`);
      }
    }

    if (workerState.segLabelsRAS) emitSegmentationStateArtifact();

    if (spinalCordRAS && lesionRAS && self.SCTLesionAnalysis) {
      postProgress(0.94, 'Computing lesion metrics...');
      const metrics = self.SCTLesionAnalysis.analyzeLesions({
        lesion: lesionRAS,
        spinalCord: spinalCordRAS,
        dims: workerState.rasDims,
        spacing: workerState.rasSpacing
      });
      metrics.filename = `${taskId}_lesion_metrics.csv`;
      postMetricsData('lesion_metrics', metrics, 'SCI lesion metrics');
      postLog(`Lesion metrics: ${metrics.summary.lesion_count} lesion(s), total volume=${metrics.summary.total_volume_mm3} mm^3`);
    }
  } else if (output.activation === 'sigmoid-labels') {
    const channelCount = output.channelCount || output.channelOrder?.length || output.classLabels?.length || 1;
    const result = await SCTInferencePipeline.runSigmoidLabelInferencePipeline(
      {
        data: modelInputData,
        dims: modelInputDims,
        patchSize
      },
      runPatch,
      {
        overlap,
        threshold,
        testTimeAugmentation,
        channelCount,
        classLabels: output.classLabels,
        labelPriority: output.labelPriority,
        paddingMode: output.paddingMode,
        onLog: (msg) => postLog(msg),
        onProgress: progressHandler,
        onPatchStats: (pi, s) => {
          const channelText = s.channels.map(channel => (
            `c${channel.channel}: logit=[${channel.oMin.toFixed(3)},${channel.oMax.toFixed(3)}], prob=[${channel.pMin.toFixed(4)},${channel.pMax.toFixed(4)}] mean=${channel.pMean.toFixed(4)}, n>thr=${channel.pAbove}`
          )).join('; ');
          postLog(`Patch ${pi} pos=[${s.pos}]: in=[${s.inMin.toFixed(3)},${s.inMax.toFixed(3)}] mean=${s.inMean.toFixed(3)}; ${channelText}`);
        }
      }
    );
    await session.release();
    postLog(`Inference complete in ${((performance.now() - inferenceStartTime) / 1000).toFixed(1)}s`);

    postProgress(0.86, 'Inverse transform...');
    const rawRAS = modelOutputToRas(result.labels, result.dims, Uint8Array);
    if (output.postprocess === 'totalspineseg-step1') {
      if (!self.TotalSpineSeg) throw new Error('TotalSpineSeg post-processing module is not available.');
      postProgress(0.90, 'Labeling TotalSpineSeg discs...');
      const processed = self.TotalSpineSeg.postprocessStep1(rawRAS.data, rawRAS.dims, {
        discPointRadius: output.discPointRadius
      });
      for (const warning of processed.warnings) postLog(`TotalSpineSeg warning: ${warning}`);

      const stages = [
        {
          stage: 'spine_step1',
          labels: processed.step1Labels,
          description: 'TotalSpineSeg step 1 labels'
        },
        {
          stage: 'spine_discs',
          labels: processed.discLabels,
          description: 'TotalSpineSeg disc labels'
        }
      ];

      for (const stageOutput of stages) {
        let outputLabels = stageOutput.labels;
        if (!workerState.isIdentity) {
          outputLabels = inverseOrient(outputLabels, workerState.rasDims, workerState.perm, workerState.flip, workerState.origDims);
        }
        const outputNifti = createOutputNifti(outputLabels, workerState.origHeaderBytes, workerState.origDims);
        postStageData(stageOutput.stage, outputNifti, stageOutput.description);
      }
    } else {
      let outputLabels = rawRAS.data;
      if (!workerState.isIdentity) {
        outputLabels = inverseOrient(outputLabels, workerState.rasDims, workerState.perm, workerState.flip, workerState.origDims);
      }
      const outputNifti = createOutputNifti(outputLabels, workerState.origHeaderBytes, workerState.origDims);
      postStageData('segmentation', outputNifti, 'SCT sigmoid-label segmentation');
    }
  } else if (output.activation === 'softmax') {
    const channelCount = output.channelCount || output.channelOrder?.length || output.classLabels?.length || 1;
    const result = await SCTInferencePipeline.runMulticlassInferencePipeline(
      {
        data: modelInputData,
        dims: modelInputDims,
        patchSize
      },
      runPatch,
      {
        overlap,
        testTimeAugmentation,
        channelCount,
        classLabels: output.classLabels,
        paddingMode: output.paddingMode,
        onLog: (msg) => postLog(msg),
        onProgress: progressHandler,
        onPatchStats: (pi, s) => {
          const channelText = s.channels.map(channel => (
            `c${channel.channel}: logit=[${channel.oMin.toFixed(3)},${channel.oMax.toFixed(3)}], prob=[${channel.pMin.toFixed(4)},${channel.pMax.toFixed(4)}] mean=${channel.pMean.toFixed(4)}`
          )).join('; ');
          postLog(`Patch ${pi} pos=[${s.pos}]: in=[${s.inMin.toFixed(3)},${s.inMax.toFixed(3)}] mean=${s.inMean.toFixed(3)}; ${channelText}`);
        }
      }
    );
    await session.release();
    postLog(`Inference complete in ${((performance.now() - inferenceStartTime) / 1000).toFixed(1)}s`);

    postProgress(0.86, 'Inverse transform...');
    const rawRAS = modelOutputToRas(result.labels, result.dims, Uint8Array);
    if (output.postprocess === 'totalspineseg-step1') {
      if (!self.TotalSpineSeg) throw new Error('TotalSpineSeg post-processing module is not available.');
      postProgress(0.90, 'Labeling TotalSpineSeg discs...');
      const processed = self.TotalSpineSeg.postprocessStep1(rawRAS.data, rawRAS.dims, {
        discPointRadius: output.discPointRadius
      });
      for (const warning of processed.warnings) postLog(`TotalSpineSeg warning: ${warning}`);

      const stages = [
        {
          stage: 'spine_step1',
          labels: processed.step1Labels,
          description: 'TotalSpineSeg step 1 labels'
        },
        {
          stage: 'spine_discs',
          labels: processed.discLabels,
          description: 'TotalSpineSeg disc labels'
        }
      ];

      for (const stageOutput of stages) {
        let outputLabels = stageOutput.labels;
        if (!workerState.isIdentity) {
          outputLabels = inverseOrient(outputLabels, workerState.rasDims, workerState.perm, workerState.flip, workerState.origDims);
        }
        const outputNifti = createOutputNifti(outputLabels, workerState.origHeaderBytes, workerState.origDims);
        postStageData(stageOutput.stage, outputNifti, stageOutput.description);
      }
    } else {
      let outputLabels = rawRAS.data;
      if (!workerState.isIdentity) {
        outputLabels = inverseOrient(outputLabels, workerState.rasDims, workerState.perm, workerState.flip, workerState.origDims);
      }
      const outputNifti = createOutputNifti(outputLabels, workerState.origHeaderBytes, workerState.origDims);
      postStageData('segmentation', outputNifti, 'SCT multiclass segmentation');
    }
  } else {
    // Delegate the per-patch inference + sliding-window orchestration to the
    // shared pipeline module, injecting an ORT-backed runPatch callback.
    const result = await SCTInferencePipeline.runInferencePipeline(
      {
        data: modelInputData,
        dims: modelInputDims,
        patchSize
      },
      runPatch,
      {
        overlap, threshold, minComponentSize, keepLargestComponent, testTimeAugmentation,
        onLog: (msg) => postLog(msg),
        onProgress: progressHandler,
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
    postStageData('segmentation', outputNifti, 'SCT segmentation');

    let finalVoxels = 0;
    for (let i = 0; i < outputLabels.length; i++) {
      if (outputLabels[i] > 0) finalVoxels++;
    }
    postLog(`Output: ${finalVoxels} foreground voxels`);
    if (finalVoxels === 0) {
      postLog(`WARNING: Segmentation is empty. Probability map max=${result.probStats.max.toFixed(4)} (threshold=${threshold}). Try lowering the probability threshold or check input contrast/orientation.`);
    }
  }

  postProgress(1.0, 'Complete');
  postStepComplete('inference');
  postComplete();
}

async function stepVertebralLabeling(params = {}) {
  if (!workerState.rasData) {
    throw new Error('No volume loaded. Run Load first.');
  }
  if (!workerState.segLabelsRAS) {
    throw new Error('No spinal cord segmentation is available. Run segmentation first.');
  }
  if (!self.SCTVertebrae) {
    throw new Error('Vertebral labeling module is not available.');
  }

  self._currentTaskId = 'vertebrae';
  postProgress(0.05, 'Loading vertebral labeling assets...');
  const modelBaseUrl = params.modelBaseUrl || '../models';
  const c2c3ModelUrl = params.c2c3ModelUrl || `${modelBaseUrl}/c2c3_disc_models/t2_model.yml`;
  const pam50LevelsUrl = params.pam50LevelsUrl || `${modelBaseUrl}/templates/PAM50/PAM50_levels.nii.gz`;
  const result = await self.SCTVertebrae.labelVertebrae({
    anatomy: workerState.rasData,
    segmentation: workerState.segLabelsRAS,
    dims: workerState.rasDims,
    spacing: workerState.rasSpacing,
    c2c3ModelUrl,
    pam50LevelsUrl,
    scaleDist: params.scaleDist ?? 0.55,
    detectorMinScore: params.detectorMinScore ?? 0.1
  });

  postProgress(0.85, 'Writing vertebral labels...');
  postLog(`C2-C3 detector: z=${result.detected.z}, score=${Number.isFinite(result.detected.score) ? result.detected.score.toFixed(4) : 'n/a'}, fallback=${!!result.detected.fallback}`);
  postLog(`Vertebral boundaries: ${result.boundaries.map(boundary => boundary.z).join(', ')}`);

  let outputLabels = result.labels;
  if (!workerState.isIdentity) {
    outputLabels = inverseOrient(outputLabels, workerState.rasDims, workerState.perm, workerState.flip, workerState.origDims);
  }

  const outputNifti = createOutputNifti(outputLabels, workerState.origHeaderBytes, workerState.origDims);
  postStageData('vertebrae', outputNifti, 'SCT vertebral labeling');

  postProgress(1.0, 'Vertebral labeling complete');
  postStepComplete('processing');
}

// ==================== Message Handler ====================

self.onmessage = async (e) => {
  const { type, data } = e.data;

  switch (type) {
    case 'init':
      try {
        self._appVersion = e.data.version || '';
        ort.env.wasm.numThreads = getOptimalWasmThreads();
        ort.env.wasm.wasmPaths = '../wasm/';

        postLog(`Using WASM backend (${ort.env.wasm.numThreads} threads)`);

        localforage.config({
          name: 'SCTModelCache',
          storeName: 'models'
        });

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

    case 'run-vertebral-labeling':
      try {
        await stepVertebralLabeling(data || {});
      } catch (error) {
        console.error('Vertebral labeling error:', error);
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

    // Legacy support for old 'run' message
    case 'run':
      try {
        // Decompose the old single-run into steps for backwards compat
        const { inputData, settings } = data;
        stepLoad(inputData);
        await stepInference({
          overlap: settings.overlap,
          taskId: settings.taskId,
          modelAssetId: settings.modelAssetId,
          supportStatus: settings.supportStatus,
          cacheKey: settings.cacheKey,
          provenance: settings.provenance,
          threshold: settings.threshold ?? settings.probabilityThreshold,
          minComponentSize: settings.minComponentSize,
          keepLargestComponent: settings.keepLargestComponent,
          modelName: settings.modelName,
          modelUrl: settings.modelUrl,
          patchSize: settings.patchSize,
          preprocessing: settings.preprocessing,
          output: settings.output,
          testTimeAugmentation: settings.testTimeAugmentation,
          modelBaseUrl: settings.modelBaseUrl
        });
      } catch (error) {
        console.error('Inference error:', error);
        postError(error?.message || String(error));
      }
      break;
  }
};
