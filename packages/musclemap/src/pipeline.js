import { createNiftiFromData, parseNiftiVolume } from '@neurodesk/webapp-components/file-io/nifti';
import { computeForegroundBBox, cropVolume, zScoreNormalize } from '@neurodesk/webapp-components/volume';
import { MuscleMapMonaiCompat } from './monai-compat.js';
import { MuscleMapSlidingWindowPolicy } from './sliding-window-policy.js';
import { MuscleMapLabelCodec } from './label-codec.js';
import { roundtripTemporaryChunk } from './upstream-chunk.js';

// Browser and Node inject their runtime and model loading; all science lives here.
export function createMuscleMapPipeline({ Tensor, createSession, loadModel, decompress, deviceMemory = 4, events = {} }) {
let result;
let busy = false;
const postLog = message => events.log?.(message);
const postProgress = (value, text) => events.progress?.(value, text);
const postDetectedLabels = labels => { result.detectedLabels = labels; events.detectedLabels?.(labels); };
const postMetrics = metrics => { result.metrics = metrics; events.metrics?.(metrics); };
const postComplete = () => {};
function postStageData(stage, niftiData, description, provenance = null) {
  result.stages[stage] = { niftiData, description, provenance };
  events.stageData?.(stage, niftiData, description, provenance);
}

// ==================== NIfTI Parsing ====================

function parseNiftiInput(arrayBuffer) {
  return parseNiftiVolume(arrayBuffer, { decompress: decompress });
}

// ==================== NIfTI Output ====================

function createOutputNifti(labelData, sourceHeader, dims) {
  return createNiftiFromData(labelData, sourceHeader, { dims });
}

// ==================== Sliding Window ====================

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

// ==================== Chunk Size Resolution ====================

function resolveChunkSize(setting, numClasses, roiH, roiW) {
  if (typeof setting === 'number' && [1, 2, 4, 8].includes(setting)) {
    return setting;
  }
  // Auto mode: detect device memory
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
  padHeight,
  padWidth,
  roiHeight,
  roiWidth,
  numClasses,
  overlap,
  gaussianWeights,
  batchSize
}) {
  const inferHeight = Math.max(sizeX, padHeight, roiHeight);
  const inferWidth = Math.max(sizeY, padWidth, roiWidth);
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
    const inputTensor = new Tensor('float32', batchInput, [batchTiles.length, 1, roiHeight, roiWidth]);
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

async function emitSegmentationOutput({
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
    if (!Object.hasOwn(sums, label)) continue;

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

  const NUM_CLASSES = numClassesSetting || 100;
  const [ROI_H, ROI_W] = roiSizeSetting || [256, 256];
  const TARGET_SPACING = model.preprocessing.targetSpacing;
  const SPATIAL_PAD = model.preprocessing.spatialPad;
  const CROP_MARGIN = 20;
  const normalizedImfSettings = normalizeImfSettings(imfMetrics);

  postLog('Parsing input volume...');
  postProgress(0.02, 'Reading NIfTI...');
  const { imageData, dims, voxelSize, headerBytes, affine, header } = parseNiftiInput(inputData);
  const [nx, ny, nz] = dims;
  postLog(`Volume: ${nx}x${ny}x${nz}, spacing: ${voxelSize.map(v => v.toFixed(2)).join('x')}mm`);

  const origDims = [...dims];
  const origVoxelSize = [...voxelSize];

  const sourceChunkSize = resolveSourceChunkSize(sourceChunkSizeSetting, nz);
  const sourceChunkCount = Math.ceil(nz / sourceChunkSize);
  const inferenceBatchSize = resolveChunkSize(chunkSizeSetting, NUM_CLASSES, ROI_H, ROI_W);
  postLog(
    `MONAI-compatible pipeline: ${sourceChunkCount} source chunks of up to ${sourceChunkSize} slices, ` +
    `overlap=${overlap}, inference batch=${inferenceBatchSize}`
  );

  const modelData = await loadModel(model.asset, modelName, 0.05, 0.18);
  postProgress(0.23, 'Loading ONNX model...');
  const session = await createSession(modelData);
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
        TARGET_SPACING,
        CROP_MARGIN
      );
      const [workingX, workingY, workingZ] = prepared.dims;
      estimatedWorkingSlices = sourceChunkCount * workingZ;
      postLog(
        `Source chunk ${chunkIndex + 1}/${sourceChunkCount}: ${start}:${end} -> ` +
        `${Math.max(workingX, SPATIAL_PAD[0], ROI_H)}x${Math.max(workingY, SPATIAL_PAD[1], ROI_W)}x${workingZ}`
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
          padHeight: SPATIAL_PAD[0],
          padWidth: SPATIAL_PAD[1],
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
  await emitSegmentationOutput({
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
}


async function execute(operation, config) {
  if (busy) throw new Error('A MuscleMap pipeline operation is already running');
  busy = true;
  result = { stages: {}, metrics: null, detectedLabels: [] };
  try {
    await operation(config);
    return result;
  } finally {
    busy = false;
  }
}
return {
  run: config => execute(runInference, config),
  metrics: config => execute(runMetricExtraction, config),
  consolidate: config => execute(runConsolidationOnly, config)
};
}
