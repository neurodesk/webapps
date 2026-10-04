/**
 * MuscleMap Inference Worker
 *
 * Runs ONNX model inference for 2D slice-by-slice muscle segmentation.
 * Pipeline: NIfTI parse → orient → resample → normalize → crop → 2D sliding window → postprocess → output
 */

import * as ort from '../wasm/ort.webgpu.bundle.min.mjs';
import { roundtripTemporaryChunk } from './upstream-chunk.js';
import { createWorkerEmitter, fetchModel as fetchModelAsset, getOptimalWasmThreads, installWorkerRouter } from '../vendor/webapp-components/src/worker/index.js';
import { createNiftiFromData, parseNiftiVolume } from '../vendor/webapp-components/src/file-io/NiftiUtils.js';
import {
  computeForegroundBBox,
  cropVolume,
  getOrientationTransform,
  inverseOrient,
  orientToRAS,
  resampleVolume,
  uncropVolume as uncrop,
} from '../vendor/webapp-components/src/volume/geometry.js';
import { zScoreNormalize } from '../vendor/webapp-components/src/volume/normalization.js';

let localforage;
let nifti;
let MuscleMapLabelCodec;
let MuscleMapAssetIntegrity;
let MuscleMapMonaiCompat;
let MuscleMapSlidingWindowPolicy;
let dependenciesReady;

function loadDependencies() {
  dependenciesReady ||= Promise.all([
    import('https://cdn.jsdelivr.net/npm/localforage@1.10.0/+esm'),
    import('../nifti-js/index.js'),
    import('./label-codec.js'),
    import('./asset-integrity.js'),
    import('./monai-compat.js'),
    import('./sliding-window-policy.js')
  ]).then(([localForageModule]) => {
    localforage = localForageModule.default;
    nifti = globalThis.nifti;
    MuscleMapLabelCodec = globalThis.MuscleMapLabelCodec;
    MuscleMapAssetIntegrity = globalThis.MuscleMapAssetIntegrity;
    MuscleMapMonaiCompat = globalThis.MuscleMapMonaiCompat;
    MuscleMapSlidingWindowPolicy = globalThis.MuscleMapSlidingWindowPolicy;
    if (!localforage || !nifti || !MuscleMapLabelCodec || !MuscleMapAssetIntegrity || !MuscleMapMonaiCompat || !MuscleMapSlidingWindowPolicy) {
      throw new Error('MuscleMap worker dependencies failed to initialize');
    }
    return { localforage, nifti };
  });
  return dependenciesReady;
}

// ==================== Message Helpers ====================

const workerMessages = createWorkerEmitter(self);
const {
  complete: postComplete,
  error: postError,
  log: postLog,
  progress: postProgress,
} = workerMessages;

function postStageData(stage, niftiData, description, provenance = null) {
  workerMessages.stageData(stage, niftiData, description, { provenance });
}

function postDetectedLabels(labels) {
  workerMessages.emit('detectedLabels', { labels }, { transfer: false });
}

function postMetrics(metrics) {
  workerMessages.emit('metrics', { metrics }, { transfer: false });
}

// ==================== NIfTI Parsing ====================

function parseNiftiInput(arrayBuffer) {
  return parseNiftiVolume(arrayBuffer, { decompress: buffer => nifti.decompress(buffer) });
}

// ==================== NIfTI Output ====================

function createOutputNifti(labelData, sourceHeader, dims) {
  return createNiftiFromData(labelData, sourceHeader, { dims });
}

// ==================== Preprocessing ====================





// ==================== Sliding Window ====================

function cropForeground(data, dims, margin) {
  const bbox = computeForegroundBBox(data, dims, margin);
  if (!bbox) return { data: new Float32Array(0), dims: [0, 0, 0], origin: [0, 0, 0] };
  return cropVolume(data, dims, bbox);
}

function computeGaussianWeightMap(h, w) {
  return MuscleMapSlidingWindowPolicy.computeGaussianWeightMap(h, w);
}

function computeTilePositions(imgH, imgW, patchH, patchW, overlap) {
  return MuscleMapSlidingWindowPolicy.computeTilePositions(imgH, imgW, patchH, patchW, overlap);
}

// ==================== Postprocessing ====================

function perLabelLargestComponent(labelVolume, dims, numLabels, progressBase = 0.85, progressSpan = 0.10) {
  const [nx, ny, nz] = dims;
  const n = nx * ny * nz;
  const result = new Uint8Array(n);
  const labelCounts = new Int32Array(numLabels + 1);
  const minX = new Int32Array(numLabels + 1);
  const minY = new Int32Array(numLabels + 1);
  const minZ = new Int32Array(numLabels + 1);
  const maxX = new Int32Array(numLabels + 1);
  const maxY = new Int32Array(numLabels + 1);
  const maxZ = new Int32Array(numLabels + 1);

  minX.fill(nx);
  minY.fill(ny);
  minZ.fill(nz);
  maxX.fill(-1);
  maxY.fill(-1);
  maxZ.fill(-1);

  for (let z = 0; z < nz; z++) {
    const zOff = z * nx * ny;
    for (let y = 0; y < ny; y++) {
      const rowOff = zOff + y * nx;
      for (let x = 0; x < nx; x++) {
        const label = labelVolume[rowOff + x];
        if (label <= 0 || label > numLabels) continue;

        labelCounts[label]++;
        if (x < minX[label]) minX[label] = x;
        if (x > maxX[label]) maxX[label] = x;
        if (y < minY[label]) minY[label] = y;
        if (y > maxY[label]) maxY[label] = y;
        if (z < minZ[label]) minZ[label] = z;
        if (z > maxZ[label]) maxZ[label] = z;
      }
    }
  }

  const activeLabels = [];
  for (let label = 1; label <= numLabels; label++) {
    if (labelCounts[label] > 0) {
      activeLabels.push(label);
    }
  }

  const totalActive = activeLabels.length;
  if (totalActive === 0) {
    return result;
  }

  for (let activeIdx = 0; activeIdx < totalActive; activeIdx++) {
    const label = activeLabels[activeIdx];
    const boxNx = maxX[label] - minX[label] + 1;
    const boxNy = maxY[label] - minY[label] + 1;
    const boxNz = maxZ[label] - minZ[label] + 1;
    const boxN = boxNx * boxNy * boxNz;
    const mask = new Uint8Array(boxN);

    for (let z = minZ[label]; z <= maxZ[label]; z++) {
      const srcZOff = z * nx * ny;
      const localZOff = (z - minZ[label]) * boxNx * boxNy;
      for (let y = minY[label]; y <= maxY[label]; y++) {
        const srcRowOff = srcZOff + y * nx;
        const localRowOff = localZOff + (y - minY[label]) * boxNx;
        for (let x = minX[label]; x <= maxX[label]; x++) {
          if (labelVolume[srcRowOff + x] === label) {
            mask[localRowOff + (x - minX[label])] = 1;
          }
        }
      }
    }

    const { labels: ccLabels, numComponents } = MuscleMapMonaiCompat.connectedComponents3D6(mask, [boxNx, boxNy, boxNz]);

    if (numComponents <= 1) {
      for (let z = minZ[label]; z <= maxZ[label]; z++) {
        const dstZOff = z * nx * ny;
        const localZOff = (z - minZ[label]) * boxNx * boxNy;
        for (let y = minY[label]; y <= maxY[label]; y++) {
          const dstRowOff = dstZOff + y * nx;
          const localRowOff = localZOff + (y - minY[label]) * boxNx;
          for (let x = minX[label]; x <= maxX[label]; x++) {
            if (mask[localRowOff + (x - minX[label])]) {
              result[dstRowOff + x] = label;
            }
          }
        }
      }
    } else {
      const sizes = new Int32Array(numComponents + 1);
      for (let i = 0; i < boxN; i++) {
        if (ccLabels[i] > 0) sizes[ccLabels[i]]++;
      }
      let best = 1, bestSize = 0;
      for (let c = 1; c <= numComponents; c++) {
        if (sizes[c] > bestSize) { bestSize = sizes[c]; best = c; }
      }
      for (let z = minZ[label]; z <= maxZ[label]; z++) {
        const dstZOff = z * nx * ny;
        const localZOff = (z - minZ[label]) * boxNx * boxNy;
        for (let y = minY[label]; y <= maxY[label]; y++) {
          const dstRowOff = dstZOff + y * nx;
          const localRowOff = localZOff + (y - minY[label]) * boxNx;
          for (let x = minX[label]; x <= maxX[label]; x++) {
            if (ccLabels[localRowOff + (x - minX[label])] === best) {
              result[dstRowOff + x] = label;
            }
          }
        }
      }
    }

    if (activeIdx % 5 === 0 || activeIdx === totalActive - 1) {
      postProgress(
        progressBase + progressSpan * ((activeIdx + 1) / totalActive),
        `Cleaning label ${activeIdx + 1}/${totalActive}...`
      );
    }
  }

  return result;
}

// ==================== Inverse Transform ====================


function resampleLabelsNearest(data, dims, tgtDims) {
  const [nx, ny, nz] = dims;
  const [tnx, tny, tnz] = tgtDims;
  const result = new Uint8Array(tnx * tny * tnz);
  const scaleX = (nx - 1) / Math.max(tnx - 1, 1);
  const scaleY = (ny - 1) / Math.max(tny - 1, 1);
  const scaleZ = (nz - 1) / Math.max(tnz - 1, 1);
  for (let z = 0; z < tnz; z++) {
    const sz = Math.round(z * scaleZ);
    for (let y = 0; y < tny; y++) {
      const sy = Math.round(y * scaleY);
      for (let x = 0; x < tnx; x++) {
        const sx = Math.round(x * scaleX);
        result[x + y*tnx + z*tnx*tny] = data[sx + sy*nx + sz*nx*ny];
      }
    }
  }
  return result;
}


function applyInverseTransforms(labels, workingDims, resampledDims, cropOrigin, needsResample, rasDims, isIdentity, perm, flip, origDims) {
  let outputLabels = uncrop(labels, workingDims, resampledDims, cropOrigin);

  if (needsResample) {
    outputLabels = resampleLabelsNearest(outputLabels, resampledDims, rasDims);
  }

  if (!isIdentity) {
    outputLabels = inverseOrient(outputLabels, rasDims, perm, flip, origDims);
  }

  return outputLabels;
}

// ==================== Model Loading ====================

async function fetchModel(asset, modelName, progressBase, progressSpan) {
  const url = asset?.url;
  if (!url) throw new Error('The selected model has no published asset URL');
  const displayName = modelName || url.split('/').pop();
  const cacheKey = `${url}#sha256=${asset.sha256}`;

  try {
    const cached = await localforage.getItem(cacheKey);
    if (cached) {
      await MuscleMapAssetIntegrity.verifyAssetBuffer(cached, asset);
      postLog(`Model loaded from cache: ${displayName}`);
      postProgress(progressBase + progressSpan, `Cached: ${displayName}`);
      return cached;
    }
  } catch (error) {
    postLog(`Discarding unverified cached model: ${error.message}`);
    await localforage.removeItem(cacheKey).catch(() => {});
  }

  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    postLog(`Downloading: ${displayName}${attempt === 2 ? ' (retry)' : ''}...`);
    const sources = asset.parts?.length
      ? asset.parts.map(part => ({
          ...part,
          url: new URL(`../${part.path}`, self.location.href).href
        }))
      : [{ url, bytes: asset.bytes, sha256: asset.sha256 }];
    const data = new Uint8Array(asset.bytes);
    let received = 0;
    let lastReportedPercent = -1;
    try {
      for (const source of sources) {
        const partStart = received;
        const part = await fetchModelAsset(
          {
            url: source.url,
            integrity: { bytes: source.bytes, sha256: source.sha256 }
          },
          {
            requestCache: attempt === 1 ? 'no-store' : 'reload',
            onProgress: ({ received: partReceived }) => {
              const dlProgress = (partStart + partReceived) / asset.bytes;
              const totalReceived = partStart + partReceived;
              const percent = Math.floor(dlProgress * 100);
              if (percent === lastReportedPercent) return;
              lastReportedPercent = percent;
              const mb = (totalReceived / 1048576).toFixed(1);
              const totalMb = (asset.bytes / 1048576).toFixed(0);
              postProgress(progressBase + dlProgress * progressSpan, `Downloading ${displayName} (${mb}/${totalMb} MB)`);
            }
          }
        );
        if (received + part.byteLength > data.length) throw new Error('Downloaded model exceeds the declared byte length');
        data.set(new Uint8Array(part), received);
        received += part.byteLength;
        if (part.byteLength === source.bytes) {
          const dlProgress = received / asset.bytes;
          const percent = Math.floor(dlProgress * 100);
          if (percent !== lastReportedPercent) {
            lastReportedPercent = percent;
            const mb = (received / 1048576).toFixed(1);
            const totalMb = (asset.bytes / 1048576).toFixed(0);
            postProgress(progressBase + dlProgress * progressSpan, `Downloading ${displayName} (${mb}/${totalMb} MB)`);
          }
        }
        await MuscleMapAssetIntegrity.verifyAssetBuffer(data.slice(partStart, received).buffer, source);
      }
      await MuscleMapAssetIntegrity.verifyAssetBuffer(data.buffer, asset);
    } catch (error) {
      lastError = error;
      await localforage.removeItem(cacheKey).catch(() => {});
      if (attempt === 2) throw error;
      postLog(`Model download failed: ${error.message}`);
      continue;
    }

    try {
      await localforage.setItem(cacheKey, data.buffer);
    } catch (e) {
      postLog('Warning: Could not cache model (storage full?)');
    }

    postLog(`Downloaded and verified: ${displayName} (${(received / 1048576).toFixed(1)} MB)`);
    return data.buffer;
  }

  throw lastError || new Error(`Unable to verify downloaded model: ${displayName}`);
}

// ==================== Chunk Size Resolution ====================

function resolveChunkSize(setting, numClasses, roiH, roiW) {
  if (typeof setting === 'number' && [1, 2, 4, 8].includes(setting)) {
    return setting;
  }
  // Auto mode: detect device memory
  const deviceMemory = (typeof navigator !== 'undefined' && navigator.deviceMemory) || 4;
  const availableMB = deviceMemory * 1024 * 0.3; // use 30% of total
  const perChunkMB = (numClasses * roiH * roiW * 4) / (1024 * 1024);
  const chunkSize = Math.min(8, Math.max(1, Math.floor(availableMB / perChunkMB)));
  return chunkSize;
}

function resolveSourceChunkSize(setting, sourceDepth) {
  if (setting === 'full') return sourceDepth;
  const parsed = Number(setting);
  if (Number.isInteger(parsed) && parsed > 0) return Math.min(parsed, sourceDepth);
  return Math.min(17, sourceDepth);
}

function extractSourceChunk(data, dims, start, end) {
  const planeSize = dims[0] * dims[1];
  return {
    data: data.slice(start * planeSize, end * planeSize),
    dims: [dims[0], dims[1], end - start]
  };
}

function prepareSourceChunk(data, dims, affine, targetSpacing, cropMargin) {
  const oriented = MuscleMapMonaiCompat.orientToRAS(data, dims, affine);
  const sourceSpacing = MuscleMapMonaiCompat.affineSpacing(oriented.affine);
  const actualTarget = targetSpacing.map((value, axis) => value > 0 ? value : sourceSpacing[axis]);
  const needsResample = sourceSpacing.some((value, axis) => Math.abs(value - actualTarget[axis]) > 1e-3);
  const spaced = needsResample
    ? MuscleMapMonaiCompat.resampleVolume(oriented.data, oriented.dims, oriented.affine, targetSpacing)
    : { data: oriented.data, dims: oriented.dims, affine: oriented.affine, spacing: sourceSpacing };
  const normalized = zScoreNormalize(spaced.data, { nonzeroOnly: true });
  const positiveForeground = Uint8Array.from(normalized, value => value > 0 ? 1 : 0);
  const bbox = computeForegroundBBox(positiveForeground, spaced.dims, cropMargin);
  if (!bbox) throw new Error('No foreground voxels found in source chunk');
  const cropped = cropVolume(normalized, spaced.dims, bbox);
  return {
    data: cropped.data,
    dims: cropped.dims,
    cropOrigin: cropped.origin,
    spacingDims: spaced.dims,
    spacingAffine: spaced.affine,
    orientedDims: oriented.dims,
    orientedAffine: oriented.affine,
    perm: oriented.perm,
    flip: oriented.flip
  };
}

async function inferSliceLogits({
  session,
  slice,
  sizeX,
  sizeY,
  roiHeight,
  roiWidth,
  numClasses,
  overlap,
  gaussianWeights,
  batchSize
}) {
  const inferHeight = Math.max(sizeX, roiHeight);
  const inferWidth = Math.max(sizeY, roiWidth);
  const transposed = MuscleMapSlidingWindowPolicy.transposeNiftiSliceToModelOrder(slice, sizeX, sizeY);
  const padded = new Float32Array(inferHeight * inferWidth);
  for (let x = 0; x < sizeX; x++) {
    padded.set(transposed.subarray(x * sizeY, (x + 1) * sizeY), x * inferWidth);
  }
  const tiles = computeTilePositions(inferHeight, inferWidth, roiHeight, roiWidth, overlap);
  const pixelCount = inferHeight * inferWidth;
  const patchSize = roiHeight * roiWidth;
  const logits = new Float32Array(pixelCount * numClasses);
  const weightSum = new Float32Array(pixelCount);
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];

  for (let tileStart = 0; tileStart < tiles.length; tileStart += batchSize) {
    const batchTiles = tiles.slice(tileStart, tileStart + batchSize);
    const batchInput = new Float32Array(batchTiles.length * patchSize);
    for (let batchIndex = 0; batchIndex < batchTiles.length; batchIndex++) {
      const tile = batchTiles[batchIndex];
      for (let patchY = 0; patchY < roiHeight; patchY++) {
        const sourceOffset = (tile.y + patchY) * inferWidth + tile.x;
        batchInput.set(
          padded.subarray(sourceOffset, sourceOffset + roiWidth),
          batchIndex * patchSize + patchY * roiWidth
        );
      }
    }
    const inputTensor = new ort.Tensor('float32', batchInput, [batchTiles.length, 1, roiHeight, roiWidth]);
    const result = await session.run({ [inputName]: inputTensor });
    const outputTensor = result[outputName];
    const output = outputTensor.data;
    inputTensor.dispose();

    for (let batchIndex = 0; batchIndex < batchTiles.length; batchIndex++) {
      const tile = batchTiles[batchIndex];
      const batchOffset = batchIndex * numClasses * patchSize;
      for (let patchY = 0; patchY < roiHeight; patchY++) {
        for (let patchX = 0; patchX < roiWidth; patchX++) {
          const patchPixel = patchY * roiWidth + patchX;
          const pixel = (tile.y + patchY) * inferWidth + tile.x + patchX;
          const weight = gaussianWeights[patchPixel];
          weightSum[pixel] += weight;
          const logitOffset = pixel * numClasses;
          for (let label = 0; label < numClasses; label++) {
            logits[logitOffset + label] += output[batchOffset + label * patchSize + patchPixel] * weight;
          }
        }
      }
    }
    outputTensor.dispose?.();
  }

  for (let pixel = 0; pixel < pixelCount; pixel++) {
    if (weightSum[pixel] <= 0) throw new Error(`Sliding-window coverage gap at pixel ${pixel}`);
    const inverseWeight = 1 / weightSum[pixel];
    const offset = pixel * numClasses;
    for (let label = 0; label < numClasses; label++) logits[offset + label] *= inverseWeight;
  }
  return { logits, dims: [inferHeight, inferWidth] };
}

function writeInverseLogitSlice({
  logits,
  inferenceDims,
  workingSlice,
  workingDims,
  cropOrigin,
  spacingDims,
  spacingAffine,
  orientedDims,
  orientedAffine,
  perm,
  flip,
  chunkDims,
  chunkLabels,
  numClasses
}) {
  const gridTransform = MuscleMapMonaiCompat.createTorchGridTransform(
    spacingAffine,
    spacingDims,
    orientedAffine,
    orientedDims
  );
  const [inferHeight, inferWidth] = inferenceDims;
  const [workingX, workingY] = workingDims;
  const targetSpacingZ = workingSlice + cropOrigin[2];
  const getLogit = (x, y, label) => {
    if (x < 0 || x >= workingX || y < 0 || y >= workingY) return 0;
    return logits[(x * inferWidth + y) * numClasses + label];
  };

  for (let orientedZ = 0; orientedZ < orientedDims[2]; orientedZ++) {
    const center = MuscleMapMonaiCompat.torchGridSourcePoint(
      gridTransform,
      [0, 0, orientedZ],
      spacingDims,
      orientedDims
    );
    if (Math.abs(center[2] - targetSpacingZ) > 1e-3) continue;
    const xCoordinates = Array.from({ length: orientedDims[0] }, (_, orientedX) =>
      MuscleMapMonaiCompat.torchGridSourcePoint(
        gridTransform,
        [orientedX, 0, orientedZ],
        spacingDims,
        orientedDims
      )[0] - cropOrigin[0]
    );
    const yCoordinates = Array.from({ length: orientedDims[1] }, (_, orientedY) =>
      MuscleMapMonaiCompat.torchGridSourcePoint(
        gridTransform,
        [0, orientedY, orientedZ],
        spacingDims,
        orientedDims
      )[1] - cropOrigin[1]
    );
    for (let orientedY = 0; orientedY < orientedDims[1]; orientedY++) {
      for (let orientedX = 0; orientedX < orientedDims[0]; orientedX++) {
        const x = xCoordinates[orientedX];
        const y = yCoordinates[orientedY];
        const x0 = Math.floor(x), x1 = x0 + 1, xWeight = x - x0;
        const y0 = Math.floor(y), y1 = y0 + 1, yWeight = y - y0;
        let bestLabel = 0;
        let bestValue = -Infinity;
        for (let label = 0; label < numClasses; label++) {
          const top = getLogit(x0, y0, label) * (1 - xWeight) + getLogit(x1, y0, label) * xWeight;
          const bottom = getLogit(x0, y1, label) * (1 - xWeight) + getLogit(x1, y1, label) * xWeight;
          const value = top * (1 - yWeight) + bottom * yWeight;
          if (value > bestValue) {
            bestValue = value;
            bestLabel = label;
          }
        }
        const orientedPoint = [orientedX, orientedY, orientedZ];
        const source = [0, 0, 0];
        for (let axis = 0; axis < 3; axis++) {
          source[perm[axis]] = flip[axis]
            ? orientedDims[axis] - 1 - orientedPoint[axis]
            : orientedPoint[axis];
        }
        const sourceIndex = source[0] + source[1] * chunkDims[0] + source[2] * chunkDims[0] * chunkDims[1];
        chunkLabels[sourceIndex] = bestLabel;
      }
    }
  }
}

async function emitUpstreamCompatibleOutput({
  outputLabels,
  numClasses,
  imageData,
  origDims,
  origVoxelSize,
  headerBytes,
  labelCodec,
  provenance,
  calculateMetrics,
  normalizedImfSettings
}) {
  const labelCounts = new Int32Array(numClasses);
  for (let index = 0; index < outputLabels.length; index++) {
    const label = outputLabels[index];
    if (label > 0 && label < numClasses) labelCounts[label]++;
  }
  const detectedIndices = [];
  for (let label = 1; label < numClasses; label++) {
    if (labelCounts[label] > 0) detectedIndices.push(label);
  }
  postLog(`Detected ${detectedIndices.length} muscles`);
  postDetectedLabels(detectedIndices);

  if (calculateMetrics || normalizedImfSettings.enabled) {
    const voxelVolMm3 = origVoxelSize[0] * origVoxelSize[1] * origVoxelSize[2];
    const labelVolumes = {};
    let totalVolumeMl = 0;
    for (const label of detectedIndices) {
      const volumeMl = labelCounts[label] * voxelVolMm3 / 1000;
      labelVolumes[label] = volumeMl;
      totalVolumeMl += volumeMl;
    }
    const { labelSliceCounts, sliceAxis, nSlices } = countLabelSlices(
      outputLabels,
      detectedIndices,
      origDims,
      origVoxelSize
    );
    const metrics = {
      labelVolumes,
      labelSliceCounts,
      totalVolumeMl,
      voxelSizeMm: origVoxelSize,
      totalSlices: nSlices,
      sliceAxis
    };
    if (normalizedImfSettings.enabled) {
      postProgress(0.985, 'Calculating IMF...');
      try {
        metrics.imf = calculateImfMetrics(
          imageData,
          outputLabels,
          detectedIndices,
          labelCounts,
          voxelVolMm3,
          normalizedImfSettings
        );
      } catch (error) {
        postLog(`Warning: IMF metrics failed: ${error.message}`);
      }
    }
    postMetrics(metrics);
  }

  const externalLabels = labelCodec.encode(outputLabels);
  postStageData(
    'segmentation',
    createOutputNifti(externalLabels, headerBytes, origDims),
    'Muscle segmentation',
    { ...provenance, encoding: 'sparse' }
  );
  postStageData(
    'segmentation_display',
    createOutputNifti(outputLabels, headerBytes, origDims),
    'Muscle segmentation (display)',
    { ...provenance, encoding: 'class-index' }
  );

  let foregroundVoxels = 0;
  for (const label of outputLabels) {
    if (label > 0) foregroundVoxels++;
  }
  postLog(`Output: ${foregroundVoxels} labeled voxels, ${detectedIndices.length} muscles`);
  postProgress(1.0, 'Complete');
  postComplete();
}


// ==================== Intramuscular Fat Metrics ====================

function normalizeImfSettings(settings = {}) {
  const mode = settings.mode === 'dixon' || settings.mode === 'both'
    ? settings.mode
    : 'threshold';
  return {
    enabled: !!settings.enabled,
    mode,
    method: settings.method === 'gmm' ? 'gmm' : 'kmeans',
    components: Number(settings.components) === 3 ? 3 : 2
  };
}

function imfUsesThreshold(settings) {
  return settings.mode !== 'dixon';
}

function imfUsesDixon(settings) {
  return settings.mode === 'dixon' || settings.mode === 'both';
}

function roundTo(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function getRange1D(values) {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let sumSq = 0;

  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (value < min) min = value;
    if (value > max) max = value;
    sum += value;
    sumSq += value * value;
  }

  const mean = values.length ? sum / values.length : 0;
  const variance = values.length ? Math.max(sumSq / values.length - mean * mean, 0) : 0;
  return { min, max, mean, variance };
}

function initializeCenters1D(values, components) {
  const { min, max } = getRange1D(values);
  const centers = new Float64Array(components);

  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
    centers.fill(Number.isFinite(min) ? min : 0);
    return centers;
  }

  for (let c = 0; c < components; c++) {
    centers[c] = min + (max - min) * (c / Math.max(components - 1, 1));
  }
  return centers;
}

function runKMeans1D(values, components, maxIterations = 100) {
  const labels = new Uint8Array(values.length);
  const centers = initializeCenters1D(values, components);

  for (let iter = 0; iter < maxIterations; iter++) {
    let changed = 0;
    const sums = new Float64Array(components);
    const counts = new Int32Array(components);

    for (let i = 0; i < values.length; i++) {
      const value = values[i];
      let bestCluster = 0;
      let bestDistance = Infinity;

      for (let c = 0; c < components; c++) {
        const distance = Math.abs(value - centers[c]);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestCluster = c;
        }
      }

      if (labels[i] !== bestCluster) changed++;
      labels[i] = bestCluster;
      sums[bestCluster] += value;
      counts[bestCluster]++;
    }

    let shift = 0;
    for (let c = 0; c < components; c++) {
      if (counts[c] === 0) continue;
      const nextCenter = sums[c] / counts[c];
      shift += Math.abs(nextCenter - centers[c]);
      centers[c] = nextCenter;
    }

    if (changed === 0 || shift < 0.001) break;
  }

  return { labels, centers };
}

function gaussianPdf1D(value, mean, variance, minVariance) {
  const safeVariance = Math.max(variance, minVariance);
  const diff = value - mean;
  return Math.exp(-0.5 * diff * diff / safeVariance) / Math.sqrt(2 * Math.PI * safeVariance);
}

function initializeGaussianMixture(values, components) {
  const initial = runKMeans1D(values, components, 50);
  const { variance: globalVariance } = getRange1D(values);
  const minVariance = Math.max(globalVariance * 1e-6, 1e-6);
  const means = new Float64Array(components);
  const variances = new Float64Array(components);
  const weights = new Float64Array(components);
  const sums = new Float64Array(components);
  const sumSquares = new Float64Array(components);
  const counts = new Int32Array(components);

  for (let i = 0; i < values.length; i++) {
    const cluster = initial.labels[i];
    const value = values[i];
    sums[cluster] += value;
    sumSquares[cluster] += value * value;
    counts[cluster]++;
  }

  for (let c = 0; c < components; c++) {
    if (counts[c] > 0) {
      means[c] = sums[c] / counts[c];
      variances[c] = Math.max(sumSquares[c] / counts[c] - means[c] * means[c], minVariance);
      weights[c] = counts[c] / values.length;
    } else {
      means[c] = initial.centers[c];
      variances[c] = Math.max(globalVariance, minVariance);
      weights[c] = 1 / components;
    }
  }

  return { means, variances, weights, minVariance };
}

function runGaussianMixture1D(values, components, maxIterations = 100) {
  const labels = new Uint8Array(values.length);
  const { means, variances, weights, minVariance } = initializeGaussianMixture(values, components);
  const probabilities = new Float64Array(components);
  let previousLogLikelihood = -Infinity;

  for (let iter = 0; iter < maxIterations; iter++) {
    const nk = new Float64Array(components);
    const sums = new Float64Array(components);
    const sumSquares = new Float64Array(components);
    let logLikelihood = 0;

    for (let i = 0; i < values.length; i++) {
      const value = values[i];
      let totalProbability = 0;

      for (let c = 0; c < components; c++) {
        const probability = weights[c] * gaussianPdf1D(value, means[c], variances[c], minVariance);
        probabilities[c] = probability;
        totalProbability += probability;
      }

      if (totalProbability <= 0 || !Number.isFinite(totalProbability)) {
        let nearest = 0;
        let bestDistance = Infinity;
        for (let c = 0; c < components; c++) {
          const distance = Math.abs(value - means[c]);
          if (distance < bestDistance) {
            bestDistance = distance;
            nearest = c;
          }
        }
        probabilities.fill(0);
        probabilities[nearest] = 1;
        totalProbability = 1;
      }

      logLikelihood += Math.log(totalProbability);

      for (let c = 0; c < components; c++) {
        const responsibility = probabilities[c] / totalProbability;
        nk[c] += responsibility;
        sums[c] += responsibility * value;
        sumSquares[c] += responsibility * value * value;
      }
    }

    for (let c = 0; c < components; c++) {
      if (nk[c] <= 0) continue;
      means[c] = sums[c] / nk[c];
      variances[c] = Math.max(sumSquares[c] / nk[c] - means[c] * means[c], minVariance);
      weights[c] = nk[c] / values.length;
    }

    if (Math.abs(logLikelihood - previousLogLikelihood) < 1e-4 * Math.max(values.length, 1)) {
      break;
    }
    previousLogLikelihood = logLikelihood;
  }

  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    let bestCluster = 0;
    let bestProbability = -Infinity;

    for (let c = 0; c < components; c++) {
      const probability = weights[c] * gaussianPdf1D(value, means[c], variances[c], minVariance);
      if (probability > bestProbability) {
        bestProbability = probability;
        bestCluster = c;
      }
    }
    labels[i] = bestCluster;
  }

  return { labels, centers: means };
}

function calculateThresholdsFromClusters(values, labels, components) {
  const counts = new Int32Array(components);
  const sums = new Float64Array(components);
  const mins = new Float64Array(components);
  const maxs = new Float64Array(components);
  mins.fill(Infinity);
  maxs.fill(-Infinity);

  for (let i = 0; i < values.length; i++) {
    const cluster = labels[i];
    const value = values[i];
    counts[cluster]++;
    sums[cluster] += value;
    if (value < mins[cluster]) mins[cluster] = value;
    if (value > maxs[cluster]) maxs[cluster] = value;
  }

  for (let c = 0; c < components; c++) {
    if (counts[c] === 0) return null;
  }

  const sortedClusters = Array.from({ length: components }, (_, cluster) => ({
    cluster,
    mean: sums[cluster] / counts[cluster]
  })).sort((a, b) => a.mean - b.mean);

  if (components === 2) {
    const muscleCluster = sortedClusters[0].cluster;
    return {
      muscleMax: maxs[muscleCluster],
      fatMin: null
    };
  }

  const muscleCluster = sortedClusters[0].cluster;
  const fatCluster = sortedClusters[2].cluster;
  return {
    muscleMax: maxs[muscleCluster],
    fatMin: mins[fatCluster]
  };
}

function calculateThresholdMetricValues(values, thresholds, components, voxelVolMl) {
  const totalVoxels = values.length;
  const totalVolumeMl = totalVoxels * voxelVolMl;

  if (components === 2) {
    let muscleVoxels = 0;
    for (let i = 0; i < values.length; i++) {
      if (values[i] <= thresholds.muscleMax) muscleVoxels++;
    }
    const fatVoxels = totalVoxels - muscleVoxels;
    return {
      musclePercentage: 100 * muscleVoxels / totalVoxels,
      fatPercentage: 100 * fatVoxels / totalVoxels,
      totalVolumeMl,
      fatVolumeMl: fatVoxels * voxelVolMl,
      muscleVolumeMl: muscleVoxels * voxelVolMl,
      undefinedPercentage: null,
      undefinedVolumeMl: null
    };
  }

  let musclePercentageVoxels = 0;
  let undefinedPercentageVoxels = 0;
  let fatVoxels = 0;
  let muscleVolumeVoxels = 0;
  let undefinedVolumeVoxels = 0;

  for (let i = 0; i < values.length; i++) {
    const value = values[i];

    if (value < thresholds.muscleMax) {
      musclePercentageVoxels++;
    } else if (value >= thresholds.fatMin) {
      fatVoxels++;
    } else {
      undefinedPercentageVoxels++;
    }

    if (value <= thresholds.muscleMax) {
      muscleVolumeVoxels++;
    } else if (value > thresholds.muscleMax && value < thresholds.fatMin) {
      undefinedVolumeVoxels++;
    }
  }

  return {
    musclePercentage: 100 * musclePercentageVoxels / totalVoxels,
    fatPercentage: 100 * fatVoxels / totalVoxels,
    totalVolumeMl,
    fatVolumeMl: fatVoxels * voxelVolMl,
    muscleVolumeMl: muscleVolumeVoxels * voxelVolMl,
    undefinedPercentage: 100 * undefinedPercentageVoxels / totalVoxels,
    undefinedVolumeMl: undefinedVolumeVoxels * voxelVolMl
  };
}

function collectLabelIntensityValues(sourceData, outputLabels, detectedIndices, labelCounts) {
  const valuesByLabel = {};
  const offsets = {};
  let skippedNonFinite = 0;

  for (const label of detectedIndices) {
    valuesByLabel[label] = new Float32Array(labelCounts[label]);
    offsets[label] = 0;
  }

  for (let i = 0; i < outputLabels.length; i++) {
    const label = outputLabels[i];
    const values = valuesByLabel[label];
    if (!values) continue;

    const value = sourceData[i];
    if (Number.isFinite(value)) {
      values[offsets[label]++] = value;
    } else {
      skippedNonFinite++;
    }
  }

  for (const label of detectedIndices) {
    valuesByLabel[label] = valuesByLabel[label].subarray(0, offsets[label]);
  }

  return { valuesByLabel, skippedNonFinite };
}

function calculateImfMetrics(sourceData, outputLabels, detectedIndices, labelCounts, voxelVolMm3, settings) {
  const voxelVolMl = voxelVolMm3 / 1000;
  const { valuesByLabel, skippedNonFinite } = collectLabelIntensityValues(
    sourceData,
    outputLabels,
    detectedIndices,
    labelCounts
  );

  const result = {
    mode: 'threshold',
    method: settings.method,
    components: settings.components,
    labelMusclePercentages: {},
    labelFatPercentages: {},
    labelUndefinedPercentages: {},
    labelTotalVolumesMl: {},
    labelFatVolumesMl: {},
    labelMuscleVolumesMl: {},
    labelUndefinedVolumesMl: {},
    thresholds: {},
    skippedLabels: [],
    skippedNonFinite,
    totalMeasuredVolumeMl: 0,
    totalFatVolumeMl: 0,
    totalMuscleVolumeMl: 0,
    totalUndefinedVolumeMl: 0,
    totalFatPercentage: NaN,
    totalMusclePercentage: NaN,
    totalUndefinedPercentage: NaN
  };

  for (const label of detectedIndices) {
    const values = valuesByLabel[label];
    if (!values || values.length < settings.components) {
      result.skippedLabels.push(label);
      continue;
    }

    const clustering = settings.method === 'gmm'
      ? runGaussianMixture1D(values, settings.components)
      : runKMeans1D(values, settings.components);
    const thresholds = calculateThresholdsFromClusters(values, clustering.labels, settings.components);
    if (!thresholds) {
      result.skippedLabels.push(label);
      continue;
    }

    const metrics = calculateThresholdMetricValues(values, thresholds, settings.components, voxelVolMl);
    result.thresholds[label] = thresholds;
    result.labelMusclePercentages[label] = roundTo(metrics.musclePercentage, 2);
    result.labelFatPercentages[label] = roundTo(metrics.fatPercentage, 2);
    result.labelTotalVolumesMl[label] = metrics.totalVolumeMl;
    result.labelFatVolumesMl[label] = metrics.fatVolumeMl;
    result.labelMuscleVolumesMl[label] = metrics.muscleVolumeMl;

    if (settings.components === 3) {
      result.labelUndefinedPercentages[label] = roundTo(metrics.undefinedPercentage, 2);
      result.labelUndefinedVolumesMl[label] = metrics.undefinedVolumeMl;
      result.totalUndefinedVolumeMl += metrics.undefinedVolumeMl;
    }

    result.totalMeasuredVolumeMl += metrics.totalVolumeMl;
    result.totalFatVolumeMl += metrics.fatVolumeMl;
    result.totalMuscleVolumeMl += metrics.muscleVolumeMl;
  }

  if (result.totalMeasuredVolumeMl > 0) {
    result.totalFatPercentage = roundTo(100 * result.totalFatVolumeMl / result.totalMeasuredVolumeMl, 2);
    result.totalMusclePercentage = roundTo(100 * result.totalMuscleVolumeMl / result.totalMeasuredVolumeMl, 2);
    if (settings.components === 3) {
      result.totalUndefinedPercentage = roundTo(100 * result.totalUndefinedVolumeMl / result.totalMeasuredVolumeMl, 2);
    }
  }

  return result;
}

function calculateDixonImfMetrics(fatData, waterData, outputLabels, detectedIndices, labelCounts, voxelVolMm3) {
  const voxelVolMl = voxelVolMm3 / 1000;
  const sums = {};
  const counts = {};

  for (const label of detectedIndices) {
    sums[label] = 0;
    counts[label] = 0;
  }

  let skippedNonFinite = 0;
  for (let i = 0; i < outputLabels.length; i++) {
    const label = outputLabels[i];
    if (!sums.hasOwnProperty(label)) continue;

    const fat = fatData[i];
    const water = waterData[i];
    if (!Number.isFinite(fat) || !Number.isFinite(water)) {
      skippedNonFinite++;
      continue;
    }

    const denom = fat + water;
    const fraction = denom !== 0 ? fat / denom : 0;
    sums[label] += fraction;
    counts[label]++;
  }

  const result = {
    mode: 'dixon',
    method: 'dixon',
    components: null,
    labelMusclePercentages: {},
    labelFatPercentages: {},
    labelUndefinedPercentages: {},
    labelTotalVolumesMl: {},
    labelFatVolumesMl: {},
    labelMuscleVolumesMl: {},
    labelUndefinedVolumesMl: {},
    thresholds: {},
    skippedLabels: [],
    skippedNonFinite,
    totalMeasuredVolumeMl: 0,
    totalFatVolumeMl: 0,
    totalMuscleVolumeMl: 0,
    totalUndefinedVolumeMl: 0,
    totalFatPercentage: NaN,
    totalMusclePercentage: NaN,
    totalUndefinedPercentage: NaN
  };

  for (const label of detectedIndices) {
    const count = counts[label] || 0;
    if (count === 0) {
      result.skippedLabels.push(label);
      continue;
    }

    const meanFatFraction = sums[label] / count;
    const totalVolumeMl = (labelCounts[label] || count) * voxelVolMl;
    const fatVolumeMl = totalVolumeMl * meanFatFraction;
    const muscleVolumeMl = Math.max(0, totalVolumeMl - fatVolumeMl);

    result.labelFatPercentages[label] = roundTo(meanFatFraction * 100, 2);
    result.labelMusclePercentages[label] = roundTo((1 - meanFatFraction) * 100, 2);
    result.labelTotalVolumesMl[label] = totalVolumeMl;
    result.labelFatVolumesMl[label] = fatVolumeMl;
    result.labelMuscleVolumesMl[label] = muscleVolumeMl;

    result.totalMeasuredVolumeMl += totalVolumeMl;
    result.totalFatVolumeMl += fatVolumeMl;
    result.totalMuscleVolumeMl += muscleVolumeMl;
  }

  if (result.totalMeasuredVolumeMl > 0) {
    result.totalFatPercentage = roundTo(100 * result.totalFatVolumeMl / result.totalMeasuredVolumeMl, 2);
    result.totalMusclePercentage = roundTo(100 * result.totalMuscleVolumeMl / result.totalMeasuredVolumeMl, 2);
  }

  return result;
}

function consolidateLabelVolumes(labelVolumes) {
  if (labelVolumes.length === 1) return labelVolumes[0];

  const voxelCount = labelVolumes[0].length;
  const output = new Uint8Array(voxelCount);

  for (let i = 0; i < voxelCount; i++) {
    let bestLabel = 0;
    let bestCount = 0;

    for (let j = 0; j < labelVolumes.length; j++) {
      const candidate = labelVolumes[j][i];
      if (candidate === 0) continue;

      let count = 0;
      for (let k = 0; k < labelVolumes.length; k++) {
        if (labelVolumes[k][i] === candidate) count++;
      }

      if (count > bestCount) {
        bestLabel = candidate;
        bestCount = count;
      }
    }

    output[i] = bestLabel;
  }

  return output;
}

function getSliceCountingInfo(dims, voxelSize) {
  const [onx, ony] = dims;
  const maxSpacing = Math.max(...voxelSize);
  const minSpacing = Math.min(...voxelSize);
  const sliceAxis = (maxSpacing / minSpacing < 1.01)
    ? 2
    : voxelSize.indexOf(maxSpacing);
  const nSlices = dims[sliceAxis];
  const getSliceIndex = sliceAxis === 0
    ? (i) => i % onx
    : sliceAxis === 1
      ? (i) => Math.floor(i / onx) % ony
      : (i) => Math.floor(i / (onx * ony));

  return { sliceAxis, nSlices, getSliceIndex };
}

function countLabelSlices(outputLabels, detectedIndices, dims, voxelSize) {
  const { sliceAxis, nSlices, getSliceIndex } = getSliceCountingInfo(dims, voxelSize);
  const sliceLabelSets = new Array(nSlices);
  for (let s = 0; s < nSlices; s++) sliceLabelSets[s] = new Set();
  for (let i = 0; i < outputLabels.length; i++) {
    if (outputLabels[i] > 0) sliceLabelSets[getSliceIndex(i)].add(outputLabels[i]);
  }

  const labelSliceCounts = {};
  for (const idx of detectedIndices) {
    let count = 0;
    for (let s = 0; s < nSlices; s++) {
      if (sliceLabelSets[s].has(idx)) count++;
    }
    labelSliceCounts[idx] = count;
  }

  return { labelSliceCounts, sliceAxis, nSlices };
}

function computeVolumetricMetrics(outputLabels, origDims, origVoxelSize, numClasses) {
  const classCount = numClasses || 256;
  const labelCounts = new Int32Array(classCount);
  for (let i = 0; i < outputLabels.length; i++) {
    if (outputLabels[i] > 0 && outputLabels[i] < classCount) {
      labelCounts[outputLabels[i]]++;
    }
  }

  const detectedIndices = [];
  for (let i = 1; i < classCount; i++) {
    if (labelCounts[i] > 0) detectedIndices.push(i);
  }

  const voxelVolMm3 = origVoxelSize[0] * origVoxelSize[1] * origVoxelSize[2];
  const labelVolumes = {};
  let totalVolumeMl = 0;

  for (const idx of detectedIndices) {
    const volMl = labelCounts[idx] * voxelVolMm3 / 1000;
    labelVolumes[idx] = volMl;
    totalVolumeMl += volMl;
  }

  const { labelSliceCounts, sliceAxis, nSlices } = countLabelSlices(
    outputLabels,
    detectedIndices,
    origDims,
    origVoxelSize
  );

  return {
    labelCounts,
    detectedIndices,
    voxelVolMm3,
    labelVolumes,
    labelSliceCounts,
    sliceAxis,
    nSlices,
    totalVolumeMl
  };
}

function parseSegmentationLabelVolumes(segmentationInputs, emptyMessage) {
  if (!segmentationInputs.length) {
    throw new Error(emptyMessage);
  }

  const expectedLabelSpaceId = segmentationInputs[0].labelSpaceId;
  if (!expectedLabelSpaceId) throw new Error('Segmentation label-space attribution is required');
  const parsedSegmentations = segmentationInputs.map(input => ({
    input,
    parsed: parseNiftiInput(input.data)
  }));
  const firstSegmentation = parsedSegmentations[0].parsed;
  const labelVolumes = [];
  const inputLabelResolutions = [];

  for (const { input, parsed } of parsedSegmentations) {
    if (input.labelSpaceId !== expectedLabelSpaceId || input.labelSpace?.id !== expectedLabelSpaceId) {
      throw new Error('All segmentation label maps must use the same declared label space');
    }
    if (!MuscleMapLabelCodec.sameGeometry(parsed, firstSegmentation)) {
      throw new Error('All segmentation label maps must have identical dimensions and affine geometry');
    }
    const codec = MuscleMapLabelCodec.createLabelCodec(input.labelSpace);
    const normalized = codec.normalizeSegmentation(parsed.imageData, input.encoding);
    labelVolumes.push(normalized.indices);
    inputLabelResolutions.push({
      ...normalized.resolution,
      requestedEncoding: input.encoding,
      summary: normalized.summary
    });
    parsed.imageData = null;
  }

  return {
    firstSegmentation,
    labelVolumes,
    inputLabelResolutions,
    labelSpace: segmentationInputs[0].labelSpace,
    labelSpaceId: expectedLabelSpaceId
  };
}

function detectLabelIndices(outputLabels, numClasses) {
  const labelCounts = new Int32Array(numClasses);
  for (let i = 0; i < outputLabels.length; i++) {
    if (outputLabels[i] > 0 && outputLabels[i] < numClasses) {
      labelCounts[outputLabels[i]]++;
    }
  }

  const detectedIndices = [];
  for (let i = 1; i < numClasses; i++) {
    if (labelCounts[i] > 0) detectedIndices.push(i);
  }
  return detectedIndices;
}

async function runMetricExtraction(config) {
  const {
    segmentationInputs = [],
    metricSourceData = null,
    dixonFatData = null,
    dixonWaterData = null,
    settings = {}
  } = config;

  postProgress(0.05, 'Reading segmentation...');
  const {
    firstSegmentation,
    labelVolumes,
    inputLabelResolutions,
    labelSpace,
    labelSpaceId
  } = parseSegmentationLabelVolumes(
    segmentationInputs,
    'No segmentation data provided for metrics'
  );
  for (const resolution of inputLabelResolutions) postLog(resolution.summary);

  const outputLabels = settings.consolidateSegmentations
    ? consolidateLabelVolumes(labelVolumes)
    : labelVolumes[0];

  const metricsBase = computeVolumetricMetrics(
    outputLabels,
    firstSegmentation.dims,
    firstSegmentation.voxelSize,
    labelSpace.classCount
  );

  postLog(`Detected ${metricsBase.detectedIndices.length} muscles`);
  postDetectedLabels(metricsBase.detectedIndices);

  let imfThreshold = null;
  let imfDixon = null;
  const imfSettings = normalizeImfSettings(settings.imfMetrics || {});
  if (imfSettings.enabled) {
    postProgress(0.35, 'Calculating IMF...');
    if (imfUsesThreshold(imfSettings)) {
      if (!metricSourceData) {
        throw new Error('Threshold IMF metrics require one source image');
      }
      const source = parseNiftiInput(metricSourceData);
      if (!MuscleMapLabelCodec.sameGeometry(source, firstSegmentation)) {
        throw new Error('Metric source image and segmentation must have identical dimensions and affine geometry');
      }
      imfThreshold = calculateImfMetrics(
        source.imageData,
        outputLabels,
        metricsBase.detectedIndices,
        metricsBase.labelCounts,
        metricsBase.voxelVolMm3,
        imfSettings
      );
      postLog(`Threshold IMF metrics complete for ${metricsBase.detectedIndices.length - imfThreshold.skippedLabels.length}/${metricsBase.detectedIndices.length} labels`);
    }
    if (imfUsesDixon(imfSettings)) {
      if (!dixonFatData || !dixonWaterData) {
        throw new Error('Dixon IMF metrics require fat and water images');
      }
      const fat = parseNiftiInput(dixonFatData);
      const water = parseNiftiInput(dixonWaterData);
      if (!MuscleMapLabelCodec.sameGeometry(fat, firstSegmentation) ||
          !MuscleMapLabelCodec.sameGeometry(water, firstSegmentation)) {
        throw new Error('Dixon fat, water, and segmentation images must have identical dimensions and affine geometry');
      }
      imfDixon = calculateDixonImfMetrics(
        fat.imageData,
        water.imageData,
        outputLabels,
        metricsBase.detectedIndices,
        metricsBase.labelCounts,
        metricsBase.voxelVolMm3
      );
      postLog(`Dixon fat metrics complete for ${metricsBase.detectedIndices.length - imfDixon.skippedLabels.length}/${metricsBase.detectedIndices.length} labels`);
    }
  }

  const metrics = {
    labelVolumes: metricsBase.labelVolumes,
    labelSliceCounts: metricsBase.labelSliceCounts,
    totalVolumeMl: metricsBase.totalVolumeMl,
    voxelSizeMm: firstSegmentation.voxelSize,
    totalSlices: metricsBase.nSlices,
    sliceAxis: metricsBase.sliceAxis
  };
  if (imfThreshold) {
    metrics.imf = imfThreshold;
    metrics.imfThreshold = imfThreshold;
  }
  if (imfDixon) {
    if (!metrics.imf) metrics.imf = imfDixon;
    metrics.imfDixon = imfDixon;
  }

  const outputNifti = createOutputNifti(
    MuscleMapLabelCodec.createLabelCodec(labelSpace).encode(outputLabels),
    firstSegmentation.headerBytes,
    firstSegmentation.dims
  );
  postStageData(
    'segmentation',
    outputNifti,
    settings.consolidateSegmentations ? 'Consolidated muscle segmentation' : 'Muscle segmentation',
    { labelSpaceId, encoding: 'sparse', inputLabelResolutions }
  );
  postStageData(
    'segmentation_display',
    createOutputNifti(outputLabels, firstSegmentation.headerBytes, firstSegmentation.dims),
    'Muscle segmentation (display)',
    { labelSpaceId, encoding: 'class-index' }
  );
  postMetrics(metrics);
  postProgress(1.0, 'Complete');
  postComplete();
}

async function runConsolidationOnly(config) {
  const {
    segmentationInputs = [],
    settings = {}
  } = config;

  if (segmentationInputs.length < 2) {
    throw new Error('At least two segmentation label maps are required for consolidation');
  }

  postProgress(0.05, 'Reading segmentations...');
  const {
    firstSegmentation,
    labelVolumes,
    inputLabelResolutions,
    labelSpace,
    labelSpaceId
  } = parseSegmentationLabelVolumes(
    segmentationInputs,
    'No segmentation data provided for consolidation'
  );
  for (const resolution of inputLabelResolutions) postLog(resolution.summary);

  postProgress(0.45, 'Consolidating segmentations...');
  const outputLabels = consolidateLabelVolumes(labelVolumes);
  const detectedIndices = detectLabelIndices(outputLabels, labelSpace.classCount);
  postLog(`Detected ${detectedIndices.length} muscles in consolidated segmentation`);
  postDetectedLabels(detectedIndices);

  const outputNifti = createOutputNifti(
    MuscleMapLabelCodec.createLabelCodec(labelSpace).encode(outputLabels),
    firstSegmentation.headerBytes,
    firstSegmentation.dims
  );
  postStageData(
    'segmentation',
    outputNifti,
    'Consolidated muscle segmentation',
    { labelSpaceId, encoding: 'sparse', inputLabelResolutions }
  );
  postStageData(
    'segmentation_display',
    createOutputNifti(outputLabels, firstSegmentation.headerBytes, firstSegmentation.dims),
    'Consolidated muscle segmentation (display)',
    { labelSpaceId, encoding: 'class-index' }
  );
  postProgress(1.0, 'Complete');
  postComplete();
}

// ==================== Main Inference Pipeline ====================

async function runInference(config) {
  const { inputData, settings } = config;
  const {
    model,
    overlap = 0.9,
    chunkSize: chunkSizeSetting = 'auto',
    sourceChunkSize: sourceChunkSizeSetting = 17,
    useWebGPU: useWebGPUSetting,
    sliceThickness = -1,
    lowRes = false,
    calculateMetrics = false,
    imfMetrics = {}
  } = settings;

  if (!model?.asset || !model?.labelSpace) {
    throw new Error('Inference requires a published model descriptor with a label space');
  }
  const modelName = model.filename;
  const numClassesSetting = model.numClasses;
  const roiSizeSetting = model.roiSize;
  const labelCodec = MuscleMapLabelCodec.createLabelCodec(model.labelSpace);
  const provenance = {
    modelId: model.id,
    modelVersion: model.modelVersion,
    labelSpaceId: model.labelSpaceId,
    assetSha256: model.asset.sha256
  };

  const useWebGPU = self._useWebGPU && (useWebGPUSetting !== false);
  if (!useWebGPU && self._useWebGPU) {
    const maxThreads = getOptimalWasmThreads();
    ort.env.wasm.numThreads = maxThreads;
    postLog(`Forcing WASM backend with ${maxThreads} threads`);
  }

  const NUM_CLASSES = numClassesSetting || 100;
  const [ROI_H, ROI_W] = roiSizeSetting || [256, 256];
  const TARGET_SPACING = [1.0, 1.0, (sliceThickness > 0) ? sliceThickness : -1];
  const UPSTREAM_TARGET_SPACING = model.preprocessing?.targetSpacing || [1.0, 1.0, -1];
  const CROP_MARGIN = 20;
  const normalizedImfSettings = normalizeImfSettings(imfMetrics);

  postLog('Parsing input volume...');
  postProgress(0.02, 'Reading NIfTI...');
  const { imageData, dims, voxelSize, headerBytes, affine, header } = parseNiftiInput(inputData);
  const [nx, ny, nz] = dims;
  postLog(`Volume: ${nx}x${ny}x${nz}, spacing: ${voxelSize.map(v => v.toFixed(2)).join('x')}mm`);

  const origDims = [...dims];
  const origVoxelSize = [...voxelSize];

  const modelVersion = Number.parseFloat(model.modelVersion);
  const useUpstreamCompatiblePipeline = model.id === 'wholebody' && modelVersion >= 1.4;
  if (useUpstreamCompatiblePipeline) {
    if (sliceThickness > 0) {
      postLog('Ignoring the legacy slice-thickness control; MuscleMap v1.4 uses its pinned native through-plane spacing');
    }
    if (lowRes) {
      postLog('Low-res cleanup is disabled for MuscleMap v1.4 upstream compatibility');
    }

    const sourceChunkSize = resolveSourceChunkSize(sourceChunkSizeSetting, nz);
    const sourceChunkCount = Math.ceil(nz / sourceChunkSize);
    const inferenceBatchSize = resolveChunkSize(chunkSizeSetting, NUM_CLASSES, ROI_H, ROI_W);
    postLog(
      `Upstream-compatible pipeline: ${sourceChunkCount} source chunks of up to ${sourceChunkSize} slices, ` +
      `overlap=${overlap}, inference batch=${inferenceBatchSize}`
    );

    const modelData = await fetchModel(model.asset, modelName, 0.05, 0.18);
    postProgress(0.23, 'Loading ONNX model...');
    const executionProviders = useWebGPU ? ['webgpu', 'wasm'] : ['wasm'];
    const session = await ort.InferenceSession.create(modelData, {
      executionProviders,
      graphOptimizationLevel: 'all'
    });
    postLog(`Session created. Input: ${session.inputNames}, Output: ${session.outputNames}`);

    const outputLabels = new Uint8Array(nx * ny * nz);
    const gaussianWeights = computeGaussianWeightMap(ROI_H, ROI_W);
    const inferenceStartTime = performance.now();
    let processedWorkingSlices = 0;
    let estimatedWorkingSlices = sourceChunkCount * Math.max(nx, ny);

    try {
      for (let chunkIndex = 0, start = 0; start < nz; chunkIndex++, start += sourceChunkSize) {
        const end = Math.min(start + sourceChunkSize, nz);
        const sourceChunk = extractSourceChunk(imageData, dims, start, end);
        if (sourceChunkSize < nz) {
          sourceChunk.data = roundtripTemporaryChunk(sourceChunk.data, header.datatype);
        }
        postProgress(0.25 + 0.60 * (chunkIndex / sourceChunkCount), `Preprocessing source slices ${start + 1}-${end}/${nz}`);
        const prepared = prepareSourceChunk(
          sourceChunk.data,
          sourceChunk.dims,
          affine,
          UPSTREAM_TARGET_SPACING,
          CROP_MARGIN
        );
        const [workingX, workingY, workingZ] = prepared.dims;
        estimatedWorkingSlices = sourceChunkCount * workingZ;
        postLog(
          `Source chunk ${chunkIndex + 1}/${sourceChunkCount}: ${start}:${end} -> ` +
          `${Math.max(workingX, ROI_H)}x${Math.max(workingY, ROI_W)}x${workingZ}`
        );
        const chunkLabels = new Uint8Array(sourceChunk.data.length);
        const workingPlane = workingX * workingY;

        for (let workingSlice = 0; workingSlice < workingZ; workingSlice++) {
          const slice = prepared.data.subarray(
            workingSlice * workingPlane,
            (workingSlice + 1) * workingPlane
          );
          const inference = await inferSliceLogits({
            session,
            slice,
            sizeX: workingX,
            sizeY: workingY,
            roiHeight: ROI_H,
            roiWidth: ROI_W,
            numClasses: NUM_CLASSES,
            overlap,
            gaussianWeights,
            batchSize: inferenceBatchSize
          });
          writeInverseLogitSlice({
            logits: inference.logits,
            inferenceDims: inference.dims,
            workingSlice,
            workingDims: prepared.dims,
            cropOrigin: prepared.cropOrigin,
            spacingDims: prepared.spacingDims,
            spacingAffine: prepared.spacingAffine,
            orientedDims: prepared.orientedDims,
            orientedAffine: prepared.orientedAffine,
            perm: prepared.perm,
            flip: prepared.flip,
            chunkDims: sourceChunk.dims,
            chunkLabels,
            numClasses: NUM_CLASSES
          });
          processedWorkingSlices++;
          if (workingSlice % 5 === 0 || workingSlice === workingZ - 1) {
            const elapsedSeconds = (performance.now() - inferenceStartTime) / 1000;
            const remainingSlices = Math.max(estimatedWorkingSlices - processedWorkingSlices, 0);
            const etaSeconds = elapsedSeconds / processedWorkingSlices * remainingSlices;
            postProgress(
              0.25 + 0.60 * Math.min(processedWorkingSlices / estimatedWorkingSlices, 1),
              `Chunk ${chunkIndex + 1}/${sourceChunkCount}, slice ${workingSlice + 1}/${workingZ} (ETA: ${etaSeconds.toFixed(0)}s)`
            );
          }
        }
        outputLabels.set(chunkLabels, start * nx * ny);
      }
    } finally {
      await session.release();
    }

    const totalTime = ((performance.now() - inferenceStartTime) / 1000).toFixed(1);
    postLog(`Inference complete: ${processedWorkingSlices} working slices in ${totalTime}s`);
    postProgress(0.86, 'Cleaning labels...');
    postLog('Keeping the largest 6-connected component for each class in the full source volume...');
    const cleanedLabels = perLabelLargestComponent(outputLabels, origDims, NUM_CLASSES - 1, 0.86, 0.10);
    await emitUpstreamCompatibleOutput({
      outputLabels: cleanedLabels,
      numClasses: NUM_CLASSES,
      imageData,
      origDims,
      origVoxelSize,
      headerBytes,
      labelCodec,
      provenance,
      calculateMetrics,
      normalizedImfSettings
    });
    return;
  }

  postProgress(0.05, 'Orienting to RAS...');
  postLog('Orienting to RAS...');
  const { perm, flip } = getOrientationTransform(affine);
  const isIdentity = perm[0] === 0 && perm[1] === 1 && perm[2] === 2 && !flip[0] && !flip[1] && !flip[2];

  let currentData, currentDims, currentSpacing;
  if (isIdentity) {
    currentData = imageData;
    currentDims = [...dims];
    currentSpacing = [...voxelSize];
  } else {
    const oriented = orientToRAS(imageData, dims, perm, flip);
    currentData = oriented.data;
    currentDims = oriented.dims;
    currentSpacing = [voxelSize[perm[0]], voxelSize[perm[1]], voxelSize[perm[2]]];
  }
  postLog(`RAS dims: ${currentDims.join('x')}`);

  const rasDims = [...currentDims];
  const rasSpacing = [...currentSpacing];

  postProgress(0.08, 'Resampling...');
  const needsResample = Math.abs(currentSpacing[0] - TARGET_SPACING[0]) > 0.01 ||
                         Math.abs(currentSpacing[1] - TARGET_SPACING[1]) > 0.01 ||
                         (TARGET_SPACING[2] > 0 && Math.abs(currentSpacing[2] - TARGET_SPACING[2]) > 0.01);

  let resampledDims;
  if (needsResample) {
    postLog('Resampling to target spacing...');
    const resampled = resampleVolume(currentData, currentDims, currentSpacing, TARGET_SPACING);
    currentData = resampled.data;
    currentDims = resampled.dims;
    currentSpacing = resampled.spacing;
    postLog(`Resampled: ${currentDims.join('x')}`);
  }
  resampledDims = [...currentDims];

  postProgress(0.10, 'Normalizing...');
  postLog('Z-score normalizing (nonzero voxels)...');
  currentData = zScoreNormalize(currentData, { nonzeroOnly: true });

  postProgress(0.12, 'Cropping foreground...');
  const cropped = cropForeground(currentData, currentDims, CROP_MARGIN);
  if (cropped.dims[0] === 0) {
    throw new Error('No foreground voxels found in volume');
  }
  currentData = cropped.data;
  currentDims = cropped.dims;
  const cropOrigin = cropped.origin;
  postLog(`Cropped: ${currentDims.join('x')} (origin: ${cropOrigin.join(',')})`);

  const modelData = await fetchModel(model.asset, modelName, 0.15, 0.15);

  postProgress(0.30, 'Loading ONNX model...');
  const executionProviders = useWebGPU ? ['webgpu', 'wasm'] : ['wasm'];
  postLog(`Creating ONNX InferenceSession (${executionProviders.join(', ')})...`);
  const session = await ort.InferenceSession.create(modelData, {
    executionProviders,
    graphOptimizationLevel: 'all'
  });
  postLog(`Session created. Input: ${session.inputNames}, Output: ${session.outputNames}`);

  const gaussianWeights = computeGaussianWeightMap(ROI_H, ROI_W);

  const [cnx, cny, cnz] = currentDims;
  const labelVolume = new Uint8Array(cnx * cny * cnz);
  const sliceSize = cnx * cny;

  const resolvedChunkSize = resolveChunkSize(chunkSizeSetting, NUM_CLASSES, ROI_H, ROI_W);
  postLog(`Starting 2D inference: ${cnz} slices, overlap=${overlap}, chunkSize=${resolvedChunkSize}${chunkSizeSetting === 'auto' ? ' (auto)' : ''}, backend=${useWebGPU ? 'webgpu' : 'wasm'}`);
  postLog(`Postprocessing mode: ${lowRes ? 'low-res (cleanup before inverse transforms)' : 'full-res (cleanup after inverse transforms)'}`);
  const inferenceStartTime = performance.now();

  for (let z = 0; z < cnz; z++) {
    const slice = currentData.subarray(z * sliceSize, (z + 1) * sliceSize);

    let hasData = false;
    for (let i = 0; i < sliceSize; i++) {
      if (slice[i] !== 0) { hasData = true; break; }
    }

    if (!hasData) {
      if (z % 20 === 0) {
        postProgress(0.32 + 0.50 * (z / cnz), `Slice ${z+1}/${cnz} (empty)`);
      }
      continue;
    }

    const transposed = MuscleMapSlidingWindowPolicy.transposeNiftiSliceToModelOrder(
      slice,
      cnx,
      cny
    );

    let inferH = cnx, inferW = cny;
    let paddedSlice = transposed;
    let padOffsetX = 0, padOffsetY = 0;

    if (cnx < ROI_H || cny < ROI_W) {
      inferH = Math.max(cnx, ROI_H);
      inferW = Math.max(cny, ROI_W);
      paddedSlice = new Float32Array(inferH * inferW);
      padOffsetY = 0;
      padOffsetX = 0;
      for (let r = 0; r < cnx; r++) {
        paddedSlice.set(
          transposed.subarray(r * cny, r * cny + cny),
          (r + padOffsetY) * inferW + padOffsetX
        );
      }
    }

    const tiles = computeTilePositions(inferH, inferW, ROI_H, ROI_W, overlap);

    const blocks = MuscleMapSlidingWindowPolicy.computeAccumulatorBlocks(
      inferH,
      inferW,
      NUM_CLASSES
    );
    const inputName = session.inputNames[0];
    const outputName = session.outputNames[0];
    const patchSize = ROI_H * ROI_W;

    for (const block of blocks) {
      const blockPixelCount = block.width * block.height;
      const accum = new Float32Array(blockPixelCount * NUM_CLASSES);
      const weightSum = new Float32Array(blockPixelCount);
      const blockTiles = tiles.filter(tile => MuscleMapSlidingWindowPolicy.intersects(block, {
        x: tile.x,
        y: tile.y,
        width: ROI_W,
        height: ROI_H
      }));

      for (let ti = 0; ti < blockTiles.length; ti += resolvedChunkSize) {
        const chunkTiles = blockTiles.slice(ti, ti + resolvedChunkSize);
        const batchInput = new Float32Array(chunkTiles.length * patchSize);
        for (let batchIndex = 0; batchIndex < chunkTiles.length; batchIndex++) {
          const tile = chunkTiles[batchIndex];
          for (let patchY = 0; patchY < ROI_H; patchY++) {
            const sourceOffset = (tile.y + patchY) * inferW + tile.x;
            const destinationOffset = batchIndex * patchSize + patchY * ROI_W;
            batchInput.set(paddedSlice.subarray(sourceOffset, sourceOffset + ROI_W), destinationOffset);
          }
        }

        const inputTensor = new ort.Tensor(
          'float32',
          batchInput,
          [chunkTiles.length, 1, ROI_H, ROI_W]
        );
        const results = await session.run({ [inputName]: inputTensor });
        const outputTensor = results[outputName];
        const output = outputTensor.data;
        inputTensor.dispose();

        const outputPerTile = NUM_CLASSES * patchSize;
        for (let batchIndex = 0; batchIndex < chunkTiles.length; batchIndex++) {
          const tile = chunkTiles[batchIndex];
          const startY = Math.max(block.y, tile.y);
          const endY = Math.min(block.y + block.height, tile.y + ROI_H);
          const startX = Math.max(block.x, tile.x);
          const endX = Math.min(block.x + block.width, tile.x + ROI_W);
          const batchOffset = batchIndex * outputPerTile;

          for (let globalY = startY; globalY < endY; globalY++) {
            const patchY = globalY - tile.y;
            for (let globalX = startX; globalX < endX; globalX++) {
              const patchX = globalX - tile.x;
              const patchPixel = patchY * ROI_W + patchX;
              const blockPixel = (globalY - block.y) * block.width + globalX - block.x;
              const weight = gaussianWeights[patchPixel];
              weightSum[blockPixel] += weight;
              const accumOffset = blockPixel * NUM_CLASSES;
              for (let classIndex = 0; classIndex < NUM_CLASSES; classIndex++) {
                accum[accumOffset + classIndex] +=
                  output[batchOffset + classIndex * patchSize + patchPixel] * weight;
              }
            }
          }
        }
        outputTensor.dispose?.();
      }

      for (let blockPixel = 0; blockPixel < blockPixelCount; blockPixel++) {
        if (weightSum[blockPixel] === 0) {
          throw new Error(`Sliding-window coverage gap at slice ${z}, block pixel ${blockPixel}`);
        }
        const accumOffset = blockPixel * NUM_CLASSES;
        let bestClass = 0;
        let bestValue = accum[accumOffset];
        for (let classIndex = 1; classIndex < NUM_CLASSES; classIndex++) {
          const value = accum[accumOffset + classIndex];
          if (value > bestValue) {
            bestValue = value;
            bestClass = classIndex;
          }
        }

        const paddedY = block.y + Math.floor(blockPixel / block.width);
        const paddedX = block.x + blockPixel % block.width;
        const outputX = paddedY - padOffsetY;
        const outputY = paddedX - padOffsetX;
        if (outputX >= 0 && outputX < cnx && outputY >= 0 && outputY < cny) {
          labelVolume[z * sliceSize + outputY * cnx + outputX] = bestClass;
        }
      }
    }

    if (z % 5 === 0 || z === cnz - 1) {
      const elapsed = (performance.now() - inferenceStartTime) / 1000;
      const eta = (elapsed / (z + 1)) * (cnz - z - 1);
      postProgress(0.32 + 0.50 * ((z + 1) / cnz), `Slice ${z+1}/${cnz} (ETA: ${eta.toFixed(0)}s)`);
    }
  }

  const totalTime = ((performance.now() - inferenceStartTime) / 1000).toFixed(1);
  postLog(`Inference complete: ${cnz} slices in ${totalTime}s`);

  await session.release();

  let outputLabels;
  if (lowRes) {
    postProgress(0.83, 'Cleaning labels (low-res)...');
    postLog('Running connected component cleanup in the low-resolution working volume...');
    const cleanedLabels = perLabelLargestComponent(labelVolume, currentDims, NUM_CLASSES - 1, 0.83, 0.12);

    postProgress(0.95, 'Inverse transform...');
    postLog('Applying inverse transforms...');
    outputLabels = applyInverseTransforms(cleanedLabels, currentDims, resampledDims, cropOrigin, needsResample, rasDims, isIdentity, perm, flip, origDims);
  } else {
    postProgress(0.83, 'Inverse transform...');
    postLog('Applying inverse transforms before connected component cleanup...');
    const transformedLabels = applyInverseTransforms(labelVolume, currentDims, resampledDims, cropOrigin, needsResample, rasDims, isIdentity, perm, flip, origDims);

    postProgress(0.90, 'Cleaning labels...');
    postLog('Running connected component cleanup at full output resolution...');
    outputLabels = perLabelLargestComponent(transformedLabels, origDims, NUM_CLASSES - 1, 0.90, 0.08);
  }

  const labelCounts = new Int32Array(NUM_CLASSES);
  for (let i = 0; i < outputLabels.length; i++) {
    if (outputLabels[i] > 0 && outputLabels[i] < NUM_CLASSES) {
      labelCounts[outputLabels[i]]++;
    }
  }
  const detectedIndices = [];
  for (let i = 1; i < NUM_CLASSES; i++) {
    if (labelCounts[i] > 0) detectedIndices.push(i);
  }
  postLog(`Detected ${detectedIndices.length} muscles`);
  postDetectedLabels(detectedIndices);

  if (calculateMetrics || normalizedImfSettings.enabled) {
    const voxelVolMm3 = origVoxelSize[0] * origVoxelSize[1] * origVoxelSize[2];
    const labelVolumes = {};
    let totalVolumeMl = 0;

    for (let i = 0; i < detectedIndices.length; i++) {
      const idx = detectedIndices[i];
      const volMl = labelCounts[idx] * voxelVolMm3 / 1000;
      labelVolumes[idx] = volMl;
      totalVolumeMl += volMl;
    }

    const { labelSliceCounts, sliceAxis, nSlices } = countLabelSlices(
      outputLabels,
      detectedIndices,
      origDims,
      origVoxelSize
    );

    let imf = null;
    if (normalizedImfSettings.enabled) {
      postProgress(0.985, 'Calculating IMF...');
      postLog(`Calculating IMF metrics (${normalizedImfSettings.method}, ${normalizedImfSettings.components} components)...`);
      try {
        imf = calculateImfMetrics(
          imageData,
          outputLabels,
          detectedIndices,
          labelCounts,
          voxelVolMm3,
          normalizedImfSettings
        );
        const processedCount = detectedIndices.length - imf.skippedLabels.length;
        postLog(`IMF metrics complete for ${processedCount}/${detectedIndices.length} labels`);
        if (imf.skippedLabels.length > 0) {
          postLog(`IMF skipped labels with too few or degenerate voxels: ${imf.skippedLabels.join(', ')}`);
        }
        if (imf.skippedNonFinite > 0) {
          postLog(`IMF ignored ${imf.skippedNonFinite} non-finite source voxels`);
        }
      } catch (error) {
        postLog(`Warning: IMF metrics failed: ${error.message}`);
        imf = null;
      }
    }

    const metrics = {
      labelVolumes,
      labelSliceCounts,
      totalVolumeMl,
      voxelSizeMm: origVoxelSize,
      totalSlices: nSlices,
      sliceAxis
    };
    if (imf) metrics.imf = imf;
    postMetrics(metrics);
  }

  const externalLabels = labelCodec.encode(outputLabels);
  const outputNifti = createOutputNifti(externalLabels, headerBytes, origDims);
  postStageData('segmentation', outputNifti, 'Muscle segmentation', {
    ...provenance,
    encoding: 'sparse'
  });

  const zWasResampled = TARGET_SPACING[2] > 0 && Math.abs(rasSpacing[2] - TARGET_SPACING[2]) > 0.01;
  const DISPLAY_MAX_DIM = 128;
  const maxDim = Math.max(...origDims);
  let displayLabels = outputLabels;
  let displayDims = origDims;
  if (zWasResampled && maxDim > DISPLAY_MAX_DIM) {
    const scale = DISPLAY_MAX_DIM / maxDim;
    displayDims = origDims.map(d => Math.max(1, Math.round(d * scale)));
    displayLabels = resampleLabelsNearest(outputLabels, origDims, displayDims);
  }
  const displayNifti = createOutputNifti(displayLabels, headerBytes, displayDims);
  if (displayDims !== origDims) {
    const dv = new DataView(displayNifti);
    const srcView = new DataView(headerBytes);
    for (let i = 1; i <= 3; i++) {
      const origPixdim = Math.abs(srcView.getFloat32(76 + i * 4, true));
      dv.setFloat32(76 + i * 4, origPixdim * origDims[i-1] / displayDims[i-1], true);
    }
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        const offset = 280 + row * 16 + col * 4;
        const val = srcView.getFloat32(offset, true);
        dv.setFloat32(offset, val * origDims[col] / displayDims[col], true);
      }
    }
  }
  postStageData('segmentation_display', displayNifti, 'Muscle segmentation (display)', {
    ...provenance,
    encoding: 'class-index'
  });

  let totalVoxels = 0;
  for (let i = 0; i < outputLabels.length; i++) {
    if (outputLabels[i] > 0) totalVoxels++;
  }
  postLog(`Output: ${totalVoxels} labeled voxels, ${detectedIndices.length} muscles`);

  postProgress(1.0, 'Complete');
  postComplete();
}

// ==================== Message Handler ====================

installWorkerRouter({
  scope: self,
  getServices: loadDependencies,
  handle: async ({ type, data, ...message }) => {

  switch (type) {
    case 'init':
      try {
        self._appVersion = message.version || '';
        ort.env.wasm.numThreads = getOptimalWasmThreads();
        ort.env.wasm.wasmPaths = '../wasm/';

        // Detect WebGPU support
        self._useWebGPU = false;
        if (typeof navigator !== 'undefined' && navigator.gpu) {
          try {
            const adapter = await navigator.gpu.requestAdapter();
            if (adapter) {
              self._useWebGPU = true;
              postLog('WebGPU available - will use GPU acceleration');
            }
          } catch (e) {
            postLog('WebGPU detection failed, using WASM backend');
          }
        }
        if (!self._useWebGPU) {
          postLog(`Using WASM backend (WebGPU not available, ${ort.env.wasm.numThreads} threads)`);
        }

        localforage.config({
          name: 'MuscleMapModelCache',
          storeName: 'models'
        });

        workerMessages.initialized({ webgpuAvailable: self._useWebGPU });
      } catch (error) {
        postError(`Initialization failed: ${error.message}`);
      }
      break;

    case 'run':
      try {
        await runInference(data);
      } catch (error) {
        console.error('Inference error:', error);
        postError(error?.message || String(error));
      }
      break;

    case 'metricsOnly':
      try {
        await runMetricExtraction(data);
      } catch (error) {
        console.error('Metrics error:', error);
        postError(error?.message || String(error));
      }
      break;

    case 'consolidateOnly':
      try {
        await runConsolidationOnly(data);
      } catch (error) {
        console.error('Consolidation error:', error);
        postError(error?.message || String(error));
      }
      break;
  }
  }
});
