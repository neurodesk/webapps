/*
 * Shared inference pipeline used by both the browser worker
 * (web/js/inference-worker.js) and the Node fixture script
 * (scripts/run_browser_fixture_outputs.cjs).
 *
 * Pure JS, no I/O, no globals. Orchestrates: zero-pad -> sliding-window patch
 * inference (with optional TTA) -> threshold -> connected-component cleanup ->
 * crop back. The caller injects a `runPatch` callback that owns the ONNX
 * session, so this module is runtime-agnostic.
 *
 * Loadable as a CommonJS module (Node) or via importScripts/global (worker).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SCTInferencePipeline = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TTA_AXES = [[0], [1], [2], [0, 1], [0, 2], [1, 2], [0, 1, 2]];

  function zScoreNormalize(data) {
    const n = data.length;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += data[i];
    const mean = sum / n;
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      const d = data[i] - mean;
      sumSq += d * d;
    }
    const std = Math.sqrt(sumSq / n) || 1;
    const result = new Float32Array(n);
    for (let i = 0; i < n; i++) result[i] = (data[i] - mean) / std;
    return result;
  }

  function zeroPadToPatchMultiple(data, dims, patchSize) {
    const [nx, ny, nz] = dims;
    const [px, py, pz] = Array.isArray(patchSize) ? patchSize : [patchSize, patchSize, patchSize];
    const pad = (d, p) => d > p && d % p !== 0 ? Math.ceil(d / p) * p : d < p ? p : d;
    const nnx = pad(nx, px);
    const nny = pad(ny, py);
    const nnz = pad(nz, pz);
    if (nnx === nx && nny === ny && nnz === nz) {
      return { data, dims: [nx, ny, nz] };
    }
    const result = new Float32Array(nnx * nny * nnz);
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          result[x + y * nnx + z * nnx * nny] = data[x + y * nx + z * nx * ny];
        }
      }
    }
    return { data: result, dims: [nnx, nny, nnz] };
  }

  function centerPadToPatchSize(data, dims, patchSize) {
    const [nx, ny, nz] = dims;
    const [px, py, pz] = Array.isArray(patchSize) ? patchSize : [patchSize, patchSize, patchSize];
    const newDims = [
      Math.max(nx, px),
      Math.max(ny, py),
      Math.max(nz, pz)
    ];
    const padBelow = newDims.map((dim, index) => Math.floor((dim - dims[index]) / 2));
    const padAbove = newDims.map((dim, index) => dim - dims[index] - padBelow[index]);
    if (newDims[0] === nx && newDims[1] === ny && newDims[2] === nz) {
      return { data, dims: [nx, ny, nz], padBelow, padAbove };
    }

    const [nnx, nny] = newDims;
    const result = new Float32Array(newDims[0] * newDims[1] * newDims[2]);
    const [ox, oy, oz] = padBelow;
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        const srcOff = z * nx * ny + y * nx;
        const dstOff = (z + oz) * nnx * nny + (y + oy) * nnx + ox;
        result.set(data.subarray(srcOff, srcOff + nx), dstOff);
      }
    }
    return { data: result, dims: newDims, padBelow, padAbove };
  }

  function unpadVolume(data, dims, tgtDims, OutputCtor) {
    OutputCtor = OutputCtor || Uint8Array;
    const [nx, ny] = dims;
    const [tnx, tny, tnz] = tgtDims;
    const result = new OutputCtor(tnx * tny * tnz);
    for (let z = 0; z < tnz; z++) {
      for (let y = 0; y < tny; y++) {
        for (let x = 0; x < tnx; x++) {
          result[x + y * tnx + z * tnx * tny] = data[x + y * nx + z * nx * ny];
        }
      }
    }
    return result;
  }

  function unpadVolumeFromOffset(data, dims, tgtDims, padBelow, OutputCtor) {
    OutputCtor = OutputCtor || Uint8Array;
    const [nx, ny] = dims;
    const [tnx, tny, tnz] = tgtDims;
    const [ox, oy, oz] = padBelow || [0, 0, 0];
    const result = new OutputCtor(tnx * tny * tnz);
    for (let z = 0; z < tnz; z++) {
      for (let y = 0; y < tny; y++) {
        const srcOff = (z + oz) * nx * ny + (y + oy) * nx + ox;
        const dstOff = z * tnx * tny + y * tnx;
        result.set(data.subarray(srcOff, srcOff + tnx), dstOff);
      }
    }
    return result;
  }

  function computeGaussianWeightMap3D(dim0, dim1, dim2, sigma) {
    if (!sigma) sigma = Math.min(dim0, dim1, dim2) / 8;
    const weights = new Float32Array(dim0 * dim1 * dim2);
    const c0 = (dim0 - 1) / 2;
    const c1 = (dim1 - 1) / 2;
    const c2 = (dim2 - 1) / 2;
    const s2 = 2 * sigma * sigma;
    for (let i0 = 0; i0 < dim0; i0++) {
      const d0 = i0 - c0;
      for (let i1 = 0; i1 < dim1; i1++) {
        const d1 = i1 - c1;
        for (let i2 = 0; i2 < dim2; i2++) {
          const d2 = i2 - c2;
          weights[i0 * dim1 * dim2 + i1 * dim2 + i2] = Math.exp(-(d0 * d0 + d1 * d1 + d2 * d2) / s2);
        }
      }
    }
    return weights;
  }

  function computePatchPositions3D(volumeDims, patchDims, overlap) {
    const positions = [];
    const seen = new Set();
    const steps = patchDims.map(p => Math.max(1, Math.round(p * (1 - overlap))));
    const counts = volumeDims.map((vd, i) => {
      if (vd <= patchDims[i]) return 1;
      return Math.max(1, Math.ceil((vd - patchDims[i]) / steps[i]) + 1);
    });
    for (let iz = 0; iz < counts[2]; iz++) {
      let z = iz * steps[2];
      if (z + patchDims[2] > volumeDims[2]) z = Math.max(0, volumeDims[2] - patchDims[2]);
      for (let iy = 0; iy < counts[1]; iy++) {
        let y = iy * steps[1];
        if (y + patchDims[1] > volumeDims[1]) y = Math.max(0, volumeDims[1] - patchDims[1]);
        for (let ix = 0; ix < counts[0]; ix++) {
          let x = ix * steps[0];
          if (x + patchDims[0] > volumeDims[0]) x = Math.max(0, volumeDims[0] - patchDims[0]);
          const key = `${x},${y},${z}`;
          if (!seen.has(key)) {
            seen.add(key);
            positions.push([x, y, z]);
          }
        }
      }
    }
    return positions;
  }

  function extractPatch3D(volume, volumeDims, position, patchDims) {
    const [v0, v1, v2] = volumeDims;
    const [p0, p1, p2] = patchDims;
    const [o0, o1, o2] = position;
    const patch = new Float32Array(p0 * p1 * p2);
    for (let i0 = 0; i0 < p0; i0++) {
      const g0 = o0 + i0;
      if (g0 < 0 || g0 >= v0) continue;
      for (let i1 = 0; i1 < p1; i1++) {
        const g1 = o1 + i1;
        if (g1 < 0 || g1 >= v1) continue;
        for (let i2 = 0; i2 < p2; i2++) {
          const g2 = o2 + i2;
          if (g2 < 0 || g2 >= v2) continue;
          const srcIdx = g0 + g1 * v0 + g2 * v0 * v1;
          const dstIdx = i0 * p1 * p2 + i1 * p2 + i2;
          patch[dstIdx] = volume[srcIdx];
        }
      }
    }
    return patch;
  }

  function flipPatch3D(data, dims, axes) {
    const [p0, p1, p2] = dims;
    const flip0 = axes.includes(0);
    const flip1 = axes.includes(1);
    const flip2 = axes.includes(2);
    const result = new Float32Array(data.length);
    for (let i0 = 0; i0 < p0; i0++) {
      const s0 = flip0 ? p0 - 1 - i0 : i0;
      for (let i1 = 0; i1 < p1; i1++) {
        const s1 = flip1 ? p1 - 1 - i1 : i1;
        for (let i2 = 0; i2 < p2; i2++) {
          const s2 = flip2 ? p2 - 1 - i2 : i2;
          const dstIdx = i0 * p1 * p2 + i1 * p2 + i2;
          const srcIdx = s0 * p1 * p2 + s1 * p2 + s2;
          result[dstIdx] = data[srcIdx];
        }
      }
    }
    return result;
  }

  function accumulatePatch3D(probAccum, weightAccum, volumeDims, position, output, weights, patchDims, updateWeights) {
    updateWeights = updateWeights !== false;
    const [v0, v1] = volumeDims;
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
          if (g2 < 0 || g2 >= volumeDims[2]) continue;
          const patchIdx = i0 * p1 * p2 + i1 * p2 + i2;
          const globalIdx = g0 + g1 * v0 + g2 * v0 * v1;
          const w = weights[patchIdx];
          probAccum[globalIdx] += output[patchIdx] * w;
          if (updateWeights) weightAccum[globalIdx] += w;
        }
      }
    }
  }

  function sigmoid(logits) {
    const out = new Float32Array(logits.length);
    for (let i = 0; i < logits.length; i++) {
      out[i] = 1 / (1 + Math.exp(-logits[i]));
    }
    return out;
  }

  function sigmoidChannels(logits, channelCount) {
    const voxelCount = Math.floor(logits.length / channelCount);
    if (voxelCount * channelCount !== logits.length) {
      throw new Error(`Channel-major logits length ${logits.length} is not divisible by channelCount=${channelCount}`);
    }
    const out = new Float32Array(logits.length);
    for (let i = 0; i < logits.length; i++) {
      out[i] = 1 / (1 + Math.exp(-logits[i]));
    }
    return out;
  }

  function softmaxChannels(logits, channelCount) {
    const voxelCount = Math.floor(logits.length / channelCount);
    if (voxelCount * channelCount !== logits.length) {
      throw new Error(`Channel-major logits length ${logits.length} is not divisible by channelCount=${channelCount}`);
    }
    const out = new Float32Array(logits.length);
    for (let i = 0; i < voxelCount; i++) {
      let maxLogit = -Infinity;
      for (let c = 0; c < channelCount; c++) {
        const value = logits[c * voxelCount + i];
        if (value > maxLogit) maxLogit = value;
      }
      let sum = 0;
      for (let c = 0; c < channelCount; c++) {
        const expValue = Math.exp(logits[c * voxelCount + i] - maxLogit);
        out[c * voxelCount + i] = expValue;
        sum += expValue;
      }
      const denom = sum || 1;
      for (let c = 0; c < channelCount; c++) {
        out[c * voxelCount + i] /= denom;
      }
    }
    return out;
  }

  function argmaxLabelsFromChannels(probabilities, channelCount, labels) {
    const voxelCount = Math.floor(probabilities.length / channelCount);
    if (voxelCount * channelCount !== probabilities.length) {
      throw new Error(`Channel-major probability length ${probabilities.length} is not divisible by channelCount=${channelCount}`);
    }
    const classLabels = labels || Array.from({ length: channelCount }, (_, i) => i);
    const result = new Uint8Array(voxelCount);
    for (let i = 0; i < voxelCount; i++) {
      let bestChannel = 0;
      let bestProbability = probabilities[i];
      for (let c = 1; c < channelCount; c++) {
        const p = probabilities[c * voxelCount + i];
        if (p > bestProbability) {
          bestProbability = p;
          bestChannel = c;
        }
      }
      result[i] = classLabels[bestChannel] == null ? bestChannel : classLabels[bestChannel];
    }
    return result;
  }

  function splitLabelsByClassMap(labels, classMap) {
    const outputs = {};
    for (const entry of classMap || []) {
      const stage = entry.stage || entry.name;
      const sourceLabels = new Set(entry.labels || entry.sourceLabels || []);
      const mask = new Uint8Array(labels.length);
      for (let i = 0; i < labels.length; i++) {
        if (sourceLabels.has(labels[i])) mask[i] = 1;
      }
      outputs[stage] = mask;
    }
    return outputs;
  }

  function flipChannelMajorPatch3D(data, dims, channelCount, axes) {
    const patchVoxels = dims[0] * dims[1] * dims[2];
    if (patchVoxels * channelCount !== data.length) {
      throw new Error(`Channel-major patch length ${data.length} does not match ${channelCount} channels x ${patchVoxels} voxels`);
    }
    const result = new Float32Array(data.length);
    for (let c = 0; c < channelCount; c++) {
      const start = c * patchVoxels;
      const flipped = flipPatch3D(data.subarray(start, start + patchVoxels), dims, axes);
      result.set(flipped, start);
    }
    return result;
  }

  function accumulateChannelMajorPatch3D(channelAccums, weightAccum, volumeDims, position, probabilities, weights, patchDims) {
    const channelCount = channelAccums.length;
    const patchVoxels = patchDims[0] * patchDims[1] * patchDims[2];
    if (probabilities.length !== channelCount * patchVoxels) {
      throw new Error(`Expected ${channelCount * patchVoxels} probabilities, got ${probabilities.length}`);
    }
    for (let c = 0; c < channelCount; c++) {
      const start = c * patchVoxels;
      accumulatePatch3D(
        channelAccums[c],
        weightAccum,
        volumeDims,
        position,
        probabilities.subarray(start, start + patchVoxels),
        weights,
        patchDims,
        c === 0
      );
    }
  }

  function summarizeChannelMajorPatch(logits, probabilities, patch, patchVoxels, channelCount, threshold, pos) {
    const channels = [];
    let inMin = Infinity, inMax = -Infinity, inMean = 0;
    for (let i = 0; i < patchVoxels; i++) {
      if (patch[i] < inMin) inMin = patch[i];
      if (patch[i] > inMax) inMax = patch[i];
      inMean += patch[i];
    }
    inMean /= patchVoxels;
    for (let c = 0; c < channelCount; c++) {
      const start = c * patchVoxels;
      let pMin = Infinity, pMax = -Infinity, pMean = 0, pAbove = 0;
      let oMin = Infinity, oMax = -Infinity;
      for (let i = 0; i < patchVoxels; i++) {
        const p = probabilities[start + i];
        const o = logits[start + i];
        if (p < pMin) pMin = p;
        if (p > pMax) pMax = p;
        if (o < oMin) oMin = o;
        if (o > oMax) oMax = o;
        pMean += p;
        if (p >= threshold) pAbove++;
      }
      channels.push({ channel: c, oMin, oMax, pMin, pMax, pMean: pMean / patchVoxels, pAbove });
    }
    return { pos, inMin, inMax, inMean, channels };
  }

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
    for (let dz = -1; dz <= 0; dz++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dz === 0 && dy === 0 && dx >= 0) continue;
          neighborOffsets.push([dx, dy, dz]);
        }
      }
    }
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          const idx = z * ny * nx + y * nx + x;
          if (!binaryMask[idx]) continue;
          const neighborLabels = [];
          for (let i = 0; i < neighborOffsets.length; i++) {
            const nx2 = x + neighborOffsets[i][0];
            const ny2 = y + neighborOffsets[i][1];
            const nz2 = z + neighborOffsets[i][2];
            if (nx2 < 0 || nx2 >= nx || ny2 < 0 || ny2 >= ny || nz2 < 0 || nz2 >= nz) continue;
            const nIdx = nz2 * ny * nx + ny2 * nx + nx2;
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

  function removeSmallComponents(binaryMask, dims, minSize) {
    const n = dims[0] * dims[1] * dims[2];
    const { labels, numComponents } = connectedComponents3D(binaryMask, dims);
    if (numComponents === 0) return binaryMask;
    const sizes = new Int32Array(numComponents + 1);
    for (let i = 0; i < n; i++) {
      if (labels[i] > 0) sizes[labels[i]]++;
    }
    const result = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (labels[i] > 0 && sizes[labels[i]] >= minSize) result[i] = 1;
    }
    return result;
  }

  function keepLargestComponent(binaryMask, dims) {
    const n = dims[0] * dims[1] * dims[2];
    const { labels, numComponents } = connectedComponents3D(binaryMask, dims);
    if (numComponents <= 1) return binaryMask;
    const sizes = new Int32Array(numComponents + 1);
    for (let i = 0; i < n; i++) {
      if (labels[i] > 0) sizes[labels[i]]++;
    }
    let largestLabel = 1;
    for (let label = 2; label <= numComponents; label++) {
      if (sizes[label] > sizes[largestLabel]) largestLabel = label;
    }
    const result = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (labels[i] === largestLabel) result[i] = 1;
    }
    return result;
  }

  /**
   * Run the full SCT inference pipeline on a normalized-or-raw volume.
   *
   * Inputs:
   *   data:                Float32Array (length = dims[0]*dims[1]*dims[2])
   *   dims:                [x, y, z]
   *   patchSize:           [px, py, pz]
   *   runPatch(patch, patchDims) -> Promise<Float32Array logits>
   *
   * Options:
   *   overlap:               sliding-window overlap fraction (default 0)
   *   threshold:             probability threshold for binarization (default 0.5)
   *   minComponentSize:      drop CCs smaller than this (default 10)
   *   keepLargestComponent:  keep only the largest CC before size cleanup (default false)
   *   testTimeAugmentation:  average across 8 axis-flipped predictions (default false)
   *   normalizeInput:        z-score normalize before padding (default true)
   *
   * Callbacks (all optional):
   *   onLog(message)
   *   onProgress(stepsDone, totalSteps, label)
   *   onPatchStats(patchIndex, stats)  // for first few patches
   *
   * Returns: { labels: Uint8Array, dims: [x,y,z], probStats }
   */
  async function runInferencePipeline(input, runPatch, options) {
    options = options || {};
    const overlap = options.overlap != null ? options.overlap : 0;
    const threshold = options.threshold != null ? options.threshold : 0.5;
    const minComponentSize = options.minComponentSize != null ? options.minComponentSize : 10;
    const keepLargestComponentEnabled = !!options.keepLargestComponent;
    const testTimeAugmentation = !!options.testTimeAugmentation;
    const normalizeInput = options.normalizeInput !== false;
    const onLog = options.onLog || (() => {});
    const onProgress = options.onProgress || (() => {});
    const onPatchStats = options.onPatchStats || (() => {});

    let currentData = input.data;
    let currentDims = [...input.dims];
    const patchSize = input.patchSize;
    const [PATCH_DIM0, PATCH_DIM1, PATCH_DIM2] = patchSize;
    const patchDims = [PATCH_DIM0, PATCH_DIM1, PATCH_DIM2];

    if (normalizeInput) {
      onLog('Z-score normalizing (all voxels)...');
      currentData = zScoreNormalize(currentData);
    }

    const prePadDims = [...currentDims];
    const padded = zeroPadToPatchMultiple(currentData, currentDims, patchDims);
    if (padded.dims[0] !== currentDims[0] || padded.dims[1] !== currentDims[1] || padded.dims[2] !== currentDims[2]) {
      onLog(`Padded: ${currentDims.join('x')} -> ${padded.dims.join('x')} (zero-pad)`);
      currentData = padded.data;
      currentDims = padded.dims;
    }
    const processingDims = [...currentDims];

    const gaussianWeights = computeGaussianWeightMap3D(PATCH_DIM0, PATCH_DIM1, PATCH_DIM2, 8);
    const positions = computePatchPositions3D(currentDims, patchDims, overlap);
    const totalPatches = positions.length;
    onLog(`Starting 3D inference: ${totalPatches} patches (${PATCH_DIM0}x${PATCH_DIM1}x${PATCH_DIM2}), overlap=${overlap}, TTA=${testTimeAugmentation ? 'on' : 'off'}`);

    const totalVoxels = currentDims[0] * currentDims[1] * currentDims[2];
    const probAccum = new Float32Array(totalVoxels);
    const weightAccum = new Float32Array(totalVoxels);
    const patchVoxels = PATCH_DIM0 * PATCH_DIM1 * PATCH_DIM2;
    const ttaStepsPerPatch = testTimeAugmentation ? (TTA_AXES.length + 1) : 1;
    const totalSteps = totalPatches * ttaStepsPerPatch;
    let stepsDone = 0;
    onProgress(0, totalSteps, `Running inference: ${totalPatches} patch${totalPatches > 1 ? 'es' : ''}${testTimeAugmentation ? ' x8 TTA' : ''}...`);

    for (let pi = 0; pi < totalPatches; pi++) {
      const pos = positions[pi];
      const patch = extractPatch3D(currentData, currentDims, pos, patchDims);

      const logits = await runPatch(patch, patchDims);
      let probabilities = sigmoid(logits);
      stepsDone++;
      onProgress(stepsDone, totalSteps, testTimeAugmentation
        ? `Patch ${pi + 1}/${totalPatches} TTA 1/${ttaStepsPerPatch}`
        : `Patch ${pi + 1}/${totalPatches}`);

      if (testTimeAugmentation) {
        const probabilitySum = new Float32Array(probabilities);
        let ttaIdx = 1;
        for (const axes of TTA_AXES) {
          const flippedPatch = flipPatch3D(patch, patchDims, axes);
          const ttaLogits = await runPatch(flippedPatch, patchDims);
          const ttaProbs = sigmoid(ttaLogits);
          const unflipped = flipPatch3D(ttaProbs, patchDims, axes);
          for (let i = 0; i < patchVoxels; i++) {
            probabilitySum[i] += unflipped[i];
          }
          ttaIdx++;
          stepsDone++;
          onProgress(stepsDone, totalSteps, `Patch ${pi + 1}/${totalPatches} TTA ${ttaIdx}/${ttaStepsPerPatch}`);
        }
        probabilities = probabilitySum;
        const ttaCount = TTA_AXES.length + 1;
        for (let i = 0; i < patchVoxels; i++) probabilities[i] /= ttaCount;
      }

      if (pi < 5) {
        let pMin = Infinity, pMax = -Infinity, pMean = 0, pAbove = 0;
        let inMin = Infinity, inMax = -Infinity, inMean = 0;
        let oMin = Infinity, oMax = -Infinity;
        for (let i = 0; i < patchVoxels; i++) {
          if (probabilities[i] < pMin) pMin = probabilities[i];
          if (probabilities[i] > pMax) pMax = probabilities[i];
          pMean += probabilities[i];
          if (probabilities[i] >= threshold) pAbove++;
          if (logits[i] < oMin) oMin = logits[i];
          if (logits[i] > oMax) oMax = logits[i];
          if (patch[i] < inMin) inMin = patch[i];
          if (patch[i] > inMax) inMax = patch[i];
          inMean += patch[i];
        }
        pMean /= patchVoxels;
        inMean /= patchVoxels;
        onPatchStats(pi, { pos, inMin, inMax, inMean, oMin, oMax, pMin, pMax, pMean, pAbove });
      }

      accumulatePatch3D(probAccum, weightAccum, currentDims, pos, probabilities, gaussianWeights, patchDims);
    }

    let probMin = Infinity, probMax = -Infinity, probSum = 0, probAboveThresh = 0;
    for (let i = 0; i < totalVoxels; i++) {
      const p = weightAccum[i] > 0 ? probAccum[i] / weightAccum[i] : 0;
      if (p < probMin) probMin = p;
      if (p > probMax) probMax = p;
      probSum += p;
      if (p >= threshold) probAboveThresh++;
    }
    const probStats = { min: probMin, max: probMax, mean: probSum / totalVoxels, voxelsAboveThreshold: probAboveThresh };
    onLog(`Prob map (padded ${currentDims.join('x')}): range=[${probMin.toFixed(4)},${probMax.toFixed(4)}], mean=${(probSum / totalVoxels).toFixed(6)}, voxels>=${threshold}=${probAboveThresh}`);

    const binaryMask = new Uint8Array(totalVoxels);
    for (let i = 0; i < totalVoxels; i++) {
      if (weightAccum[i] > 0) {
        const prob = probAccum[i] / weightAccum[i];
        if (prob >= threshold) binaryMask[i] = 1;
      }
    }

    let outputLabels = binaryMask;
    if (prePadDims[0] !== processingDims[0] || prePadDims[1] !== processingDims[1] || prePadDims[2] !== processingDims[2]) {
      outputLabels = unpadVolume(outputLabels, processingDims, prePadDims, Uint8Array);
    }
    const preCleanupLabels = outputLabels;

    if (keepLargestComponentEnabled) {
      onLog('Keeping largest connected component...');
      outputLabels = keepLargestComponent(outputLabels, prePadDims);
    }

    if (minComponentSize > 1) {
      onLog(`Removing components smaller than ${minComponentSize} voxels...`);
      outputLabels = removeSmallComponents(outputLabels, prePadDims, minComponentSize);
    }

    let finalVoxels = 0;
    for (let i = 0; i < outputLabels.length; i++) {
      if (outputLabels[i] > 0) finalVoxels++;
    }
    onLog(`Output: ${finalVoxels} foreground voxels`);

    return { labels: outputLabels, preCleanupLabels, dims: prePadDims, probStats };
  }

  /**
   * Run sliding-window inference for region/channel outputs.
   *
   * The ONNX output is expected to be channel-major [1, C, x, y, z]. Each
   * configured region points to a source channel and is emitted as its own
   * binary label mask. This matches nnU-Net region training packages such as
   * SCT SCIsegV2, where spinal cord is one sigmoid region and lesion is a
   * second sigmoid region.
   */
  async function runRegionInferencePipeline(input, runPatch, options) {
    options = options || {};
    const overlap = options.overlap != null ? options.overlap : 0;
    const threshold = options.threshold != null ? options.threshold : 0.5;
    const minComponentSize = options.minComponentSize != null ? options.minComponentSize : 10;
    const testTimeAugmentation = !!options.testTimeAugmentation;
    const normalizeInput = options.normalizeInput !== false;
    const channelCount = Number(options.channelCount || options.channels || 1);
    const regionConfigs = (options.regions && options.regions.length > 0)
      ? options.regions
      : Array.from({ length: channelCount }, (_, channel) => ({ name: `channel_${channel}`, stage: `channel_${channel}`, channel }));
    const onLog = options.onLog || (() => {});
    const onProgress = options.onProgress || (() => {});
    const onPatchStats = options.onPatchStats || (() => {});

    let currentData = input.data;
    let currentDims = [...input.dims];
    const patchSize = input.patchSize;
    const [PATCH_DIM0, PATCH_DIM1, PATCH_DIM2] = patchSize;
    const patchDims = [PATCH_DIM0, PATCH_DIM1, PATCH_DIM2];

    if (normalizeInput) {
      onLog('Z-score normalizing (all voxels)...');
      currentData = zScoreNormalize(currentData);
    }

    const prePadDims = [...currentDims];
    const padded = zeroPadToPatchMultiple(currentData, currentDims, patchDims);
    if (padded.dims[0] !== currentDims[0] || padded.dims[1] !== currentDims[1] || padded.dims[2] !== currentDims[2]) {
      onLog(`Padded: ${currentDims.join('x')} -> ${padded.dims.join('x')} (zero-pad)`);
      currentData = padded.data;
      currentDims = padded.dims;
    }
    const processingDims = [...currentDims];

    const gaussianWeights = computeGaussianWeightMap3D(PATCH_DIM0, PATCH_DIM1, PATCH_DIM2, 8);
    const positions = computePatchPositions3D(currentDims, patchDims, overlap);
    const totalPatches = positions.length;
    onLog(`Starting region inference: ${totalPatches} patches (${PATCH_DIM0}x${PATCH_DIM1}x${PATCH_DIM2}), channels=${channelCount}, overlap=${overlap}, TTA=${testTimeAugmentation ? 'on' : 'off'}`);

    const totalVoxels = currentDims[0] * currentDims[1] * currentDims[2];
    const channelAccums = Array.from({ length: channelCount }, () => new Float32Array(totalVoxels));
    const weightAccum = new Float32Array(totalVoxels);
    const patchVoxels = PATCH_DIM0 * PATCH_DIM1 * PATCH_DIM2;
    const ttaStepsPerPatch = testTimeAugmentation ? (TTA_AXES.length + 1) : 1;
    const totalSteps = totalPatches * ttaStepsPerPatch;
    let stepsDone = 0;
    onProgress(0, totalSteps, `Running inference: ${totalPatches} patch${totalPatches > 1 ? 'es' : ''}${testTimeAugmentation ? ' x8 TTA' : ''}...`);

    for (let pi = 0; pi < totalPatches; pi++) {
      const pos = positions[pi];
      const patch = extractPatch3D(currentData, currentDims, pos, patchDims);

      const logits = await runPatch(patch, patchDims);
      let probabilities = sigmoidChannels(logits, channelCount);
      stepsDone++;
      onProgress(stepsDone, totalSteps, testTimeAugmentation
        ? `Patch ${pi + 1}/${totalPatches} TTA 1/${ttaStepsPerPatch}`
        : `Patch ${pi + 1}/${totalPatches}`);

      if (testTimeAugmentation) {
        const probabilitySum = new Float32Array(probabilities);
        let ttaIdx = 1;
        for (const axes of TTA_AXES) {
          const flippedPatch = flipPatch3D(patch, patchDims, axes);
          const ttaLogits = await runPatch(flippedPatch, patchDims);
          const ttaProbs = sigmoidChannels(ttaLogits, channelCount);
          const unflipped = flipChannelMajorPatch3D(ttaProbs, patchDims, channelCount, axes);
          for (let i = 0; i < probabilitySum.length; i++) probabilitySum[i] += unflipped[i];
          ttaIdx++;
          stepsDone++;
          onProgress(stepsDone, totalSteps, `Patch ${pi + 1}/${totalPatches} TTA ${ttaIdx}/${ttaStepsPerPatch}`);
        }
        probabilities = probabilitySum;
        const ttaCount = TTA_AXES.length + 1;
        for (let i = 0; i < probabilities.length; i++) probabilities[i] /= ttaCount;
      }

      if (pi < 5) {
        onPatchStats(pi, summarizeChannelMajorPatch(logits, probabilities, patch, patchVoxels, channelCount, threshold, pos));
      }

      accumulateChannelMajorPatch3D(channelAccums, weightAccum, currentDims, pos, probabilities, gaussianWeights, patchDims);
    }

    const channelProbStats = [];
    for (let c = 0; c < channelCount; c++) {
      let probMin = Infinity, probMax = -Infinity, probSum = 0, probAboveThresh = 0;
      for (let i = 0; i < totalVoxels; i++) {
        const p = weightAccum[i] > 0 ? channelAccums[c][i] / weightAccum[i] : 0;
        if (p < probMin) probMin = p;
        if (p > probMax) probMax = p;
        probSum += p;
        if (p >= threshold) probAboveThresh++;
      }
      const stats = { channel: c, min: probMin, max: probMax, mean: probSum / totalVoxels, voxelsAboveThreshold: probAboveThresh };
      channelProbStats.push(stats);
      onLog(`Region channel ${c} prob map (padded ${currentDims.join('x')}): range=[${probMin.toFixed(4)},${probMax.toFixed(4)}], mean=${stats.mean.toFixed(6)}, voxels>=${threshold}=${probAboveThresh}`);
    }

    const regions = [];
    for (const region of regionConfigs) {
      const channel = Number(region.channel ?? 0);
      if (channel < 0 || channel >= channelCount) {
        throw new Error(`Region "${region.name || region.stage}" references channel ${channel}, but channelCount=${channelCount}`);
      }
      const regionThreshold = region.threshold != null ? Number(region.threshold) : threshold;
      const regionMinComponentSize = region.minComponentSize != null ? Number(region.minComponentSize) : minComponentSize;
      const binaryMask = new Uint8Array(totalVoxels);
      for (let i = 0; i < totalVoxels; i++) {
        if (weightAccum[i] > 0 && channelAccums[channel][i] / weightAccum[i] >= regionThreshold) {
          binaryMask[i] = 1;
        }
      }

      let outputLabels = binaryMask;
      if (prePadDims[0] !== processingDims[0] || prePadDims[1] !== processingDims[1] || prePadDims[2] !== processingDims[2]) {
        outputLabels = unpadVolume(outputLabels, processingDims, prePadDims, Uint8Array);
      }
      const preCleanupLabels = outputLabels;
      if (regionMinComponentSize > 1) {
        onLog(`Removing ${region.stage || region.name || `channel_${channel}`} components smaller than ${regionMinComponentSize} voxels...`);
        outputLabels = removeSmallComponents(outputLabels, prePadDims, regionMinComponentSize);
      }

      let finalVoxels = 0;
      for (let i = 0; i < outputLabels.length; i++) {
        if (outputLabels[i] > 0) finalVoxels++;
      }
      onLog(`${region.stage || region.name || `channel_${channel}`} output: ${finalVoxels} foreground voxels`);

      regions.push({
        ...region,
        channel,
        labels: outputLabels,
        preCleanupLabels,
        dims: prePadDims,
        probStats: channelProbStats[channel],
        threshold: regionThreshold
      });
    }

    return { regions, dims: prePadDims, probStats: channelProbStats };
  }

  /**
   * Run sliding-window inference for mutually-exclusive multiclass outputs.
   *
   * The ONNX output is expected to be channel-major [1, C, x, y, z]. Channel
   * probabilities are softmax-normalized per voxel before blending, then the
   * final label map is produced by argmax over the configured classLabels.
   */
  async function runMulticlassInferencePipeline(input, runPatch, options) {
    options = options || {};
    const overlap = options.overlap != null ? options.overlap : 0;
    const testTimeAugmentation = !!options.testTimeAugmentation;
    const normalizeInput = options.normalizeInput !== false;
    const channelCount = Number(options.channelCount || options.channels || 1);
    const classLabels = Array.isArray(options.classLabels)
      ? options.classLabels
      : Array.from({ length: channelCount }, (_, i) => i);
    const onLog = options.onLog || (() => {});
    const onProgress = options.onProgress || (() => {});
    const onPatchStats = options.onPatchStats || (() => {});

    let currentData = input.data;
    let currentDims = [...input.dims];
    const patchSize = input.patchSize;
    const [PATCH_DIM0, PATCH_DIM1, PATCH_DIM2] = patchSize;
    const patchDims = [PATCH_DIM0, PATCH_DIM1, PATCH_DIM2];

    if (normalizeInput) {
      onLog('Z-score normalizing (all voxels)...');
      currentData = zScoreNormalize(currentData);
    }

    const prePadDims = [...currentDims];
    const padded = zeroPadToPatchMultiple(currentData, currentDims, patchDims);
    if (padded.dims[0] !== currentDims[0] || padded.dims[1] !== currentDims[1] || padded.dims[2] !== currentDims[2]) {
      onLog(`Padded: ${currentDims.join('x')} -> ${padded.dims.join('x')} (zero-pad)`);
      currentData = padded.data;
      currentDims = padded.dims;
    }
    const processingDims = [...currentDims];

    const gaussianWeights = computeGaussianWeightMap3D(PATCH_DIM0, PATCH_DIM1, PATCH_DIM2, 8);
    const positions = computePatchPositions3D(currentDims, patchDims, overlap);
    const totalPatches = positions.length;
    onLog(`Starting multiclass inference: ${totalPatches} patches (${PATCH_DIM0}x${PATCH_DIM1}x${PATCH_DIM2}), channels=${channelCount}, overlap=${overlap}, TTA=${testTimeAugmentation ? 'on' : 'off'}`);

    const totalVoxels = currentDims[0] * currentDims[1] * currentDims[2];
    const channelAccums = Array.from({ length: channelCount }, () => new Float32Array(totalVoxels));
    const weightAccum = new Float32Array(totalVoxels);
    const patchVoxels = PATCH_DIM0 * PATCH_DIM1 * PATCH_DIM2;
    const ttaStepsPerPatch = testTimeAugmentation ? (TTA_AXES.length + 1) : 1;
    const totalSteps = totalPatches * ttaStepsPerPatch;
    let stepsDone = 0;
    onProgress(0, totalSteps, `Running inference: ${totalPatches} patch${totalPatches > 1 ? 'es' : ''}${testTimeAugmentation ? ' x8 TTA' : ''}...`);

    for (let pi = 0; pi < totalPatches; pi++) {
      const pos = positions[pi];
      const patch = extractPatch3D(currentData, currentDims, pos, patchDims);

      const logits = await runPatch(patch, patchDims);
      let probabilities = softmaxChannels(logits, channelCount);
      stepsDone++;
      onProgress(stepsDone, totalSteps, testTimeAugmentation
        ? `Patch ${pi + 1}/${totalPatches} TTA 1/${ttaStepsPerPatch}`
        : `Patch ${pi + 1}/${totalPatches}`);

      if (testTimeAugmentation) {
        const probabilitySum = new Float32Array(probabilities);
        let ttaIdx = 1;
        for (const axes of TTA_AXES) {
          const flippedPatch = flipPatch3D(patch, patchDims, axes);
          const ttaLogits = await runPatch(flippedPatch, patchDims);
          const ttaProbs = softmaxChannels(ttaLogits, channelCount);
          const unflipped = flipChannelMajorPatch3D(ttaProbs, patchDims, channelCount, axes);
          for (let i = 0; i < probabilitySum.length; i++) probabilitySum[i] += unflipped[i];
          ttaIdx++;
          stepsDone++;
          onProgress(stepsDone, totalSteps, `Patch ${pi + 1}/${totalPatches} TTA ${ttaIdx}/${ttaStepsPerPatch}`);
        }
        probabilities = probabilitySum;
        const ttaCount = TTA_AXES.length + 1;
        for (let i = 0; i < probabilities.length; i++) probabilities[i] /= ttaCount;
      }

      if (pi < 5) {
        onPatchStats(pi, summarizeChannelMajorPatch(logits, probabilities, patch, patchVoxels, channelCount, 0.5, pos));
      }

      accumulateChannelMajorPatch3D(channelAccums, weightAccum, currentDims, pos, probabilities, gaussianWeights, patchDims);
    }

    const probabilities = new Float32Array(channelCount * totalVoxels);
    const channelProbStats = [];
    for (let c = 0; c < channelCount; c++) {
      let probMin = Infinity, probMax = -Infinity, probSum = 0;
      const channelOffset = c * totalVoxels;
      for (let i = 0; i < totalVoxels; i++) {
        const p = weightAccum[i] > 0 ? channelAccums[c][i] / weightAccum[i] : 0;
        probabilities[channelOffset + i] = p;
        if (p < probMin) probMin = p;
        if (p > probMax) probMax = p;
        probSum += p;
      }
      const stats = { channel: c, min: probMin, max: probMax, mean: probSum / totalVoxels };
      channelProbStats.push(stats);
      onLog(`Class channel ${c} prob map (padded ${currentDims.join('x')}): range=[${probMin.toFixed(4)},${probMax.toFixed(4)}], mean=${stats.mean.toFixed(6)}`);
    }

    let outputLabels = argmaxLabelsFromChannels(probabilities, channelCount, classLabels);
    if (prePadDims[0] !== processingDims[0] || prePadDims[1] !== processingDims[1] || prePadDims[2] !== processingDims[2]) {
      outputLabels = unpadVolume(outputLabels, processingDims, prePadDims, Uint8Array);
    }

    let finalVoxels = 0;
    for (let i = 0; i < outputLabels.length; i++) {
      if (outputLabels[i] > 0) finalVoxels++;
    }
    onLog(`Multiclass output: ${finalVoxels} foreground voxels`);

    return { labels: outputLabels, dims: prePadDims, probStats: channelProbStats };
  }

  /**
   * Run sliding-window inference for region-style sigmoid outputs that must be
   * collapsed into one label map before task-specific post-processing.
   *
   * This is used by TotalSpineSeg step 1, whose nnU-Net package predicts broad
   * regions such as "disc" and "canal" plus more specific regions such as
   * "C2-C3 disc" and "cord". `labelPriority` is ordered from broad to specific;
   * later thresholded labels overwrite earlier labels at the same voxel.
   */
  async function runSigmoidLabelInferencePipeline(input, runPatch, options) {
    options = options || {};
    const overlap = options.overlap != null ? options.overlap : 0;
    const threshold = options.threshold != null ? options.threshold : 0.5;
    const testTimeAugmentation = !!options.testTimeAugmentation;
    const normalizeInput = options.normalizeInput !== false;
    const channelCount = Number(options.channelCount || options.channels || 1);
    const classLabels = Array.isArray(options.classLabels)
      ? options.classLabels
      : Array.from({ length: channelCount }, (_, i) => i + 1);
    const labelPriority = Array.isArray(options.labelPriority) && options.labelPriority.length > 0
      ? options.labelPriority
      : null;
    const onLog = options.onLog || (() => {});
    const onProgress = options.onProgress || (() => {});
    const onPatchStats = options.onPatchStats || (() => {});

    let currentData = input.data;
    let currentDims = [...input.dims];
    const patchSize = input.patchSize;
    const [PATCH_DIM0, PATCH_DIM1, PATCH_DIM2] = patchSize;
    const patchDims = [PATCH_DIM0, PATCH_DIM1, PATCH_DIM2];

    if (normalizeInput) {
      onLog('Z-score normalizing (all voxels)...');
      currentData = zScoreNormalize(currentData);
    }

    const prePadDims = [...currentDims];
    const paddingMode = options.paddingMode || 'end-multiple';
    const padded = paddingMode === 'center-min-patch'
      ? centerPadToPatchSize(currentData, currentDims, patchDims)
      : zeroPadToPatchMultiple(currentData, currentDims, patchDims);
    if (padded.dims[0] !== currentDims[0] || padded.dims[1] !== currentDims[1] || padded.dims[2] !== currentDims[2]) {
      const padDetail = paddingMode === 'center-min-patch' && padded.padBelow
        ? `center zero-pad, below=${padded.padBelow.join('x')}, above=${padded.padAbove.join('x')}`
        : 'zero-pad';
      onLog(`Padded: ${currentDims.join('x')} -> ${padded.dims.join('x')} (${padDetail})`);
      currentData = padded.data;
      currentDims = padded.dims;
    }
    const processingDims = [...currentDims];

    const gaussianWeights = computeGaussianWeightMap3D(PATCH_DIM0, PATCH_DIM1, PATCH_DIM2, 8);
    const positions = computePatchPositions3D(currentDims, patchDims, overlap);
    const totalPatches = positions.length;
    onLog(`Starting sigmoid-label inference: ${totalPatches} patches (${PATCH_DIM0}x${PATCH_DIM1}x${PATCH_DIM2}), channels=${channelCount}, overlap=${overlap}, TTA=${testTimeAugmentation ? 'on' : 'off'}`);

    const totalVoxels = currentDims[0] * currentDims[1] * currentDims[2];
    const channelAccums = Array.from({ length: channelCount }, () => new Float32Array(totalVoxels));
    const weightAccum = new Float32Array(totalVoxels);
    const patchVoxels = PATCH_DIM0 * PATCH_DIM1 * PATCH_DIM2;
    const ttaStepsPerPatch = testTimeAugmentation ? (TTA_AXES.length + 1) : 1;
    const totalSteps = totalPatches * ttaStepsPerPatch;
    let stepsDone = 0;
    onProgress(0, totalSteps, `Running inference: ${totalPatches} patch${totalPatches > 1 ? 'es' : ''}${testTimeAugmentation ? ' x8 TTA' : ''}...`);

    for (let pi = 0; pi < totalPatches; pi++) {
      const pos = positions[pi];
      const patch = extractPatch3D(currentData, currentDims, pos, patchDims);

      const logits = await runPatch(patch, patchDims);
      let probabilities = sigmoidChannels(logits, channelCount);
      stepsDone++;
      onProgress(stepsDone, totalSteps, testTimeAugmentation
        ? `Patch ${pi + 1}/${totalPatches} TTA 1/${ttaStepsPerPatch}`
        : `Patch ${pi + 1}/${totalPatches}`);

      if (testTimeAugmentation) {
        const probabilitySum = new Float32Array(probabilities);
        let ttaIdx = 1;
        for (const axes of TTA_AXES) {
          const flippedPatch = flipPatch3D(patch, patchDims, axes);
          const ttaLogits = await runPatch(flippedPatch, patchDims);
          const ttaProbs = sigmoidChannels(ttaLogits, channelCount);
          const unflipped = flipChannelMajorPatch3D(ttaProbs, patchDims, channelCount, axes);
          for (let i = 0; i < probabilitySum.length; i++) probabilitySum[i] += unflipped[i];
          ttaIdx++;
          stepsDone++;
          onProgress(stepsDone, totalSteps, `Patch ${pi + 1}/${totalPatches} TTA ${ttaIdx}/${ttaStepsPerPatch}`);
        }
        probabilities = probabilitySum;
        const ttaCount = TTA_AXES.length + 1;
        for (let i = 0; i < probabilities.length; i++) probabilities[i] /= ttaCount;
      }

      if (pi < 5) {
        onPatchStats(pi, summarizeChannelMajorPatch(logits, probabilities, patch, patchVoxels, channelCount, threshold, pos));
      }

      accumulateChannelMajorPatch3D(channelAccums, weightAccum, currentDims, pos, probabilities, gaussianWeights, patchDims);
    }

    const channelProbStats = [];
    for (let c = 0; c < channelCount; c++) {
      let probMin = Infinity, probMax = -Infinity, probSum = 0, probAboveThresh = 0;
      for (let i = 0; i < totalVoxels; i++) {
        const p = weightAccum[i] > 0 ? channelAccums[c][i] / weightAccum[i] : 0;
        if (p < probMin) probMin = p;
        if (p > probMax) probMax = p;
        probSum += p;
        if (p >= threshold) probAboveThresh++;
      }
      const stats = { channel: c, label: classLabels[c], min: probMin, max: probMax, mean: probSum / totalVoxels, voxelsAboveThreshold: probAboveThresh };
      channelProbStats.push(stats);
      onLog(`Sigmoid label ${classLabels[c]} channel ${c} prob map (padded ${currentDims.join('x')}): range=[${probMin.toFixed(4)},${probMax.toFixed(4)}], mean=${stats.mean.toFixed(6)}, voxels>=${threshold}=${probAboveThresh}`);
    }

    const outputLabels = new Uint8Array(totalVoxels);
    if (labelPriority) {
      const channelByLabel = new Map(classLabels.map((label, channel) => [label, channel]));
      for (const label of labelPriority) {
        const channel = channelByLabel.get(label);
        if (channel == null) continue;
        const channelData = channelAccums[channel];
        for (let i = 0; i < totalVoxels; i++) {
          if (weightAccum[i] > 0 && channelData[i] / weightAccum[i] > threshold) outputLabels[i] = label;
        }
      }
    } else {
      for (let i = 0; i < totalVoxels; i++) {
        let bestChannel = -1;
        let bestProb = threshold;
        for (let c = 0; c < channelCount; c++) {
          const p = weightAccum[i] > 0 ? channelAccums[c][i] / weightAccum[i] : 0;
          if (p >= bestProb) {
            bestProb = p;
            bestChannel = c;
          }
        }
        if (bestChannel >= 0) outputLabels[i] = classLabels[bestChannel] == null ? bestChannel + 1 : classLabels[bestChannel];
      }
    }

    let labels = outputLabels;
    if (prePadDims[0] !== processingDims[0] || prePadDims[1] !== processingDims[1] || prePadDims[2] !== processingDims[2]) {
      labels = paddingMode === 'center-min-patch' && padded.padBelow
        ? unpadVolumeFromOffset(labels, processingDims, prePadDims, padded.padBelow, Uint8Array)
        : unpadVolume(labels, processingDims, prePadDims, Uint8Array);
    }

    let finalVoxels = 0;
    for (let i = 0; i < labels.length; i++) {
      if (labels[i] > 0) finalVoxels++;
    }
    onLog(`Sigmoid-label output: ${finalVoxels} foreground voxels`);

    return { labels, dims: prePadDims, probStats: channelProbStats };
  }

  return {
    runInferencePipeline,
    runRegionInferencePipeline,
    runMulticlassInferencePipeline,
    runSigmoidLabelInferencePipeline,
    zScoreNormalize,
    zeroPadToPatchMultiple,
    centerPadToPatchSize,
    unpadVolume,
    unpadVolumeFromOffset,
    computeGaussianWeightMap3D,
    computePatchPositions3D,
    extractPatch3D,
    flipPatch3D,
    flipChannelMajorPatch3D,
    accumulatePatch3D,
    accumulateChannelMajorPatch3D,
    sigmoid,
    sigmoidChannels,
    softmaxChannels,
    argmaxLabelsFromChannels,
    splitLabelsByClassMap,
    connectedComponents3D,
    removeSmallComponents,
    keepLargestComponent,
    TTA_AXES
  };
}));
