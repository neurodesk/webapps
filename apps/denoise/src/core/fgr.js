// Aydin-style FGR (Feature Generation & Regression) self-supervised denoising
// (Batson & Royer, ICML 2019; Royer Lab Aydin).
//
// For fixed normalization and a fixed fitted model f, predictions f(F(x))_i use strictly
// J-invariant blind-spot features F(x)_i that have exact zero dependence on voxel x_i. As in
// Aydin, normalization and regressor fitting use the input image with an in-image holdout split
// for hyperparameter selection / early stopping, and row-strip extraction bounds peak feature memory.

import { extractSliceFeatures, featureNames } from "./features.js";
import { imageStats } from "./metrics.js";
import { createRng, shuffleInPlace } from "./rng.js";

/** Maximum pixels per horizontal feature strip (~20 MB scratch for 20 float32 features). */
const MAX_STRIP_PIXELS = 262144;

/**
 * Solves `A x = b` for symmetric positive-definite `A` (dimension `n x n`, row-major)
 * using Cholesky decomposition `A = L L^T`. Returns `null` if not positive-definite.
 * @param {Float64Array} A
 * @param {Float64Array} b
 * @param {number} n
 * @returns {Float64Array | null}
 */
export function solveCholesky(A, b, n) {
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j <= i; j += 1) {
      let sum = A[i * n + j];
      for (let k = 0; k < j; k += 1) {
        sum -= L[i * n + k] * L[j * n + k];
      }
      if (i === j) {
        if (!(sum > 1e-15)) return null;
        L[i * n + j] = Math.sqrt(sum);
      } else {
        L[i * n + j] = sum / L[j * n + j];
      }
    }
  }
  const y = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    let sum = b[i];
    for (let k = 0; k < i; k += 1) sum -= L[i * n + k] * y[k];
    y[i] = sum / L[i * n + i];
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i -= 1) {
    let sum = y[i];
    for (let k = i + 1; k < n; k += 1) sum -= L[k * n + i] * x[k];
    x[i] = sum / L[i * n + i];
  }
  return x;
}

/**
 * Draws a deterministic stratified sample of feature vectors and target pixel intensities
 * across all slices using row strips so large 2D planes never allocate a full feature matrix.
 */
function sampleFeaturesAndTargets(normVolume, dims, { use3d, maxScale, maxSamples, seed }, onProgress) {
  const [nz, ny, nx] = dims;
  const plane = ny * nx;
  const totalVoxels = nz * plane;
  const numFeatures = featureNames({ use3d, maxScale }).length;
  const targetCount = Math.min(totalVoxels, maxSamples);
  const rng = createRng(seed);

  const perSliceBase = Math.floor(targetCount / nz);
  const remainder = targetCount - perSliceBase * nz;
  const X = new Float32Array(targetCount * numFeatures);
  const y = new Float32Array(targetCount);
  const stripRows = Math.max(1, Math.min(ny, Math.floor(MAX_STRIP_PIXELS / Math.max(1, nx))));
  const scratch = {};
  let cursor = 0;

  for (let z = 0; z < nz; z += 1) {
    const kSlice = perSliceBase + (z < remainder ? 1 : 0);
    if (kSlice === 0) continue;
    const sliceBase = z * plane;

    // Pick deterministic indices within this slice first, then gather strip-by-strip.
    let chosen;
    if (kSlice >= plane) {
      chosen = null;
    } else {
      chosen = new Int32Array(kSlice);
      const stride = plane / kSlice;
      for (let i = 0; i < kSlice; i += 1) {
        const start = Math.floor(i * stride);
        const end = Math.min(plane, Math.max(start + 1, Math.floor((i + 1) * stride)));
        chosen[i] = start + Math.floor(rng() * (end - start));
      }
      chosen.sort();
    }

    let cPos = 0;
    for (let yStart = 0; yStart < ny; yStart += stripRows) {
      const yEnd = Math.min(ny, yStart + stripRows);
      const pStart = yStart * nx;
      const pEnd = yEnd * nx;
      if (chosen && (cPos >= chosen.length || chosen[cPos] >= pEnd)) continue;

      const stripFeats = extractSliceFeatures(
        normVolume,
        dims,
        z,
        { use3d, maxScale, yStart, yEnd },
        scratch,
      );

      if (!chosen) {
        const stripLen = pEnd - pStart;
        X.set(stripFeats.subarray(0, stripLen * numFeatures), cursor * numFeatures);
        y.set(normVolume.subarray(sliceBase + pStart, sliceBase + pEnd), cursor);
        cursor += stripLen;
      } else {
        while (cPos < chosen.length && chosen[cPos] < pEnd) {
          const idx = chosen[cPos];
          const local = idx - pStart;
          const srcOffset = local * numFeatures;
          const dstOffset = cursor * numFeatures;
          for (let f = 0; f < numFeatures; f += 1) {
            X[dstOffset + f] = stripFeats[srcOffset + f];
          }
          y[cursor] = normVolume[sliceBase + idx];
          cursor += 1;
          cPos += 1;
        }
      }
    }
    onProgress?.(0.25 * ((z + 1) / nz));
  }

  return { X, y, count: cursor, numFeatures };
}

/**
 * Fits an L2-regularised linear model `y ≈ w0 + X w` using holdout validation to select `lambda`.
 * Always derives train and validation counts from `count` so small images never read out of bounds.
 */
function fitRidgeModel(X, y, count, numFeatures, seed) {
  const rng = createRng(seed ^ 0x9e3779b9);
  const indices = new Int32Array(count);
  for (let i = 0; i < count; i += 1) indices[i] = i;
  shuffleInPlace(indices, rng);

  const valCount = Math.max(1, Math.min(Math.floor(count * 0.15), count - 2));
  const trainCount = count - valCount;
  const p = numFeatures + 1;

  const XtX = new Float64Array(p * p);
  const Xty = new Float64Array(p);
  const row = new Float64Array(p);
  row[numFeatures] = 1;

  for (let s = 0; s < trainCount; s += 1) {
    const idx = indices[s];
    const base = idx * numFeatures;
    const target = y[idx];
    for (let f = 0; f < numFeatures; f += 1) row[f] = X[base + f];
    for (let i = 0; i < p; i += 1) {
      const ri = row[i];
      Xty[i] += ri * target;
      const iOffset = i * p;
      for (let j = i; j < p; j += 1) {
        XtX[iOffset + j] += ri * row[j];
      }
    }
  }
  for (let i = 0; i < p; i += 1) {
    for (let j = 0; j < i; j += 1) XtX[i * p + j] = XtX[j * p + i];
  }

  const lambdas = [1e-4, 1e-3, 1e-2, 1e-1, 1, 10, 100];
  let bestLambda = 1e-2;
  let bestValMse = Infinity;
  let bestWeights = null;

  for (const lambda of lambdas) {
    const reg = Float64Array.from(XtX);
    const penalty = lambda * trainCount;
    for (let f = 0; f < numFeatures; f += 1) reg[f * p + f] += penalty;
    reg[numFeatures * p + numFeatures] += 1e-9 * trainCount;
    const weights = solveCholesky(reg, Xty, p);
    if (!weights) continue;

    let mse = 0;
    for (let s = trainCount; s < count; s += 1) {
      const idx = indices[s];
      const base = idx * numFeatures;
      let pred = weights[numFeatures];
      for (let f = 0; f < numFeatures; f += 1) pred += weights[f] * X[base + f];
      const err = pred - y[idx];
      mse += err * err;
    }
    mse /= valCount;
    if (Number.isFinite(mse) && mse < bestValMse) {
      bestValMse = mse;
      bestLambda = lambda;
      bestWeights = weights;
    }
  }

  if (!bestWeights) {
    bestWeights = new Float64Array(p);
    let meanY = 0;
    for (let i = 0; i < trainCount; i += 1) meanY += y[indices[i]];
    meanY /= trainCount;
    bestWeights[numFeatures] = meanY;
    let mse = 0;
    for (let s = trainCount; s < count; s += 1) {
      const err = meanY - y[indices[s]];
      mse += err * err;
    }
    bestValMse = mse / valCount;
  }

  return {
    weights: Float32Array.from(bestWeights),
    lambda: bestLambda,
    valMse: bestValMse,
  };
}

/**
 * Builds up to `maxBins` quantile thresholds per feature on the training subset and quantizes
 * training features into `Uint8Array` bin indices for fast histogram GBDT training.
 */
function buildFeatureBins(X, trainIndices, numFeatures, maxBins = 64) {
  const n = trainIndices.length;
  const binEdges = new Array(numFeatures);
  const binCounts = new Uint8Array(numFeatures);
  const quantized = new Uint8Array(n * numFeatures);
  const col = new Float32Array(n);

  for (let f = 0; f < numFeatures; f += 1) {
    for (let i = 0; i < n; i += 1) {
      col[i] = X[trainIndices[i] * numFeatures + f];
    }
    col.sort();
    const edges = [];
    let last = -Infinity;
    for (let b = 1; b < maxBins; b += 1) {
      const pos = Math.min(n - 1, Math.floor((b * n) / maxBins));
      const v = col[pos];
      if (v > last + 1e-12) {
        edges.push(v);
        last = v;
      }
    }
    const edgeArr = Float32Array.from(edges);
    binEdges[f] = edgeArr;
    binCounts[f] = edgeArr.length + 1;

    const numEdges = edgeArr.length;
    for (let i = 0; i < n; i += 1) {
      const v = X[trainIndices[i] * numFeatures + f];
      let lo = 0;
      let hi = numEdges;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (v <= edgeArr[mid]) hi = mid;
        else lo = mid + 1;
      }
      quantized[i * numFeatures + f] = lo;
    }
  }
  return { binEdges, binCounts, quantized };
}

/**
 * Fits a single depth-limited regression tree on negative residuals using exact L2-regularised
 * histogram gain. Returns a compact flat tree `{ feat, thresh, left, right, value }`.
 */
function fitHistogramTree({
  quantized,
  binEdges,
  binCounts,
  residuals,
  numFeatures,
  sampleOrder,
  maxDepth,
  l2Lambda,
  minChildSamples,
  colSubsample,
  rng,
}) {
  const maxNodes = (1 << (maxDepth + 1)) - 1;
  const feat = new Int16Array(maxNodes).fill(-1);
  const thresh = new Float32Array(maxNodes);
  const left = new Int32Array(maxNodes).fill(-1);
  const right = new Int32Array(maxNodes).fill(-1);
  const value = new Float32Array(maxNodes);

  const activeFeatures = [];
  for (let f = 0; f < numFeatures; f += 1) {
    if (rng() <= colSubsample) activeFeatures.push(f);
  }
  if (!activeFeatures.length) activeFeatures.push(0);

  const histGrad = new Float64Array(65);
  const histCount = new Int32Array(65);
  let nodeCount = 1;

  const stack = [{ nodeId: 0, start: 0, end: sampleOrder.length, depth: 0 }];
  const scratchLeft = new Int32Array(sampleOrder.length);
  const scratchRight = new Int32Array(sampleOrder.length);

  while (stack.length > 0) {
    const { nodeId, start, end, depth } = stack.pop();
    const count = end - start;
    let sumG = 0;
    for (let i = start; i < end; i += 1) sumG += residuals[sampleOrder[i]];
    value[nodeId] = sumG / (count + l2Lambda);

    if (depth >= maxDepth || count < 2 * minChildSamples) continue;

    const parentScore = (sumG * sumG) / (count + l2Lambda);
    let bestGain = 1e-7;
    let bestFeat = -1;
    let bestBin = -1;

    for (let fi = 0; fi < activeFeatures.length; fi += 1) {
      const f = activeFeatures[fi];
      const nBins = binCounts[f];
      if (nBins < 2) continue;
      histGrad.fill(0, 0, nBins);
      histCount.fill(0, 0, nBins);
      for (let i = start; i < end; i += 1) {
        const s = sampleOrder[i];
        const b = quantized[s * numFeatures + f];
        histGrad[b] += residuals[s];
        histCount[b] += 1;
      }
      let gL = 0;
      let cL = 0;
      for (let b = 0; b < nBins - 1; b += 1) {
        gL += histGrad[b];
        cL += histCount[b];
        const cR = count - cL;
        if (cL < minChildSamples || cR < minChildSamples) continue;
        const gR = sumG - gL;
        const gain = (gL * gL) / (cL + l2Lambda) + (gR * gR) / (cR + l2Lambda) - parentScore;
        if (gain > bestGain) {
          bestGain = gain;
          bestFeat = f;
          bestBin = b;
        }
      }
    }

    if (bestFeat < 0) continue;

    let lLen = 0;
    let rLen = 0;
    for (let i = start; i < end; i += 1) {
      const s = sampleOrder[i];
      if (quantized[s * numFeatures + bestFeat] <= bestBin) {
        scratchLeft[lLen] = s;
        lLen += 1;
      } else {
        scratchRight[rLen] = s;
        rLen += 1;
      }
    }
    for (let i = 0; i < lLen; i += 1) sampleOrder[start + i] = scratchLeft[i];
    for (let i = 0; i < rLen; i += 1) sampleOrder[start + lLen + i] = scratchRight[i];

    const leftId = nodeCount;
    const rightId = nodeCount + 1;
    nodeCount += 2;
    feat[nodeId] = bestFeat;
    thresh[nodeId] = binEdges[bestFeat][bestBin];
    left[nodeId] = leftId;
    right[nodeId] = rightId;

    stack.push({ nodeId: rightId, start: start + lLen, end, depth: depth + 1 });
    stack.push({ nodeId: leftId, start, end: start + lLen, depth: depth + 1 });
  }

  return {
    feat: feat.subarray(0, nodeCount),
    thresh: thresh.subarray(0, nodeCount),
    left: left.subarray(0, nodeCount),
    right: right.subarray(0, nodeCount),
    value: value.subarray(0, nodeCount),
  };
}

function evalTreeRow(tree, X, rowOffset) {
  let node = 0;
  while (tree.feat[node] >= 0) {
    node = X[rowOffset + tree.feat[node]] <= tree.thresh[node] ? tree.left[node] : tree.right[node];
  }
  return tree.value[node];
}

/**
 * Fits a histogram GBDT ensemble with early stopping on an in-image holdout split.
 * Derives train/val sizes from `count` and scores the 0-tree baseline so small images
 * always produce finite predictions and validation scores.
 */
function fitGbdtModel(X, y, count, numFeatures, { nTrees, maxDepth, learningRate, seed }, onProgress) {
  const rng = createRng(seed ^ 0x85ebca6b);
  const indices = new Int32Array(count);
  for (let i = 0; i < count; i += 1) indices[i] = i;
  shuffleInPlace(indices, rng);

  const valCount = Math.max(1, Math.min(Math.floor(count * 0.12), count - 2));
  const trainCount = count - valCount;
  const trainIndices = indices.subarray(0, trainCount);
  const valIndices = indices.subarray(trainCount, count);

  const { binEdges, binCounts, quantized } = buildFeatureBins(X, trainIndices, numFeatures, 64);

  let baseScore = 0;
  for (let i = 0; i < trainCount; i += 1) baseScore += y[trainIndices[i]];
  baseScore /= trainCount;

  // Score the 0-tree constant baseline on the holdout split first.
  let bestValMse = 0;
  for (let i = 0; i < valCount; i += 1) {
    const err = baseScore - y[valIndices[i]];
    bestValMse += err * err;
  }
  bestValMse /= valCount;

  const trainPred = new Float64Array(trainCount).fill(baseScore);
  const valPred = new Float64Array(valCount).fill(baseScore);
  const residuals = new Float64Array(trainCount);
  const sampleOrder = new Int32Array(trainCount);

  const trees = [];
  let bestTreeCount = 0;
  let staleRounds = 0;
  const patience = 12;
  const minChildSamples = Math.max(1, Math.min(24, Math.floor(trainCount / 20)));
  const l2Lambda = trainCount < 64 ? 1.0 : 5.0;

  for (let t = 0; t < nTrees; t += 1) {
    for (let i = 0; i < trainCount; i += 1) {
      residuals[i] = y[trainIndices[i]] - trainPred[i];
      sampleOrder[i] = i;
    }
    const tree = fitHistogramTree({
      quantized,
      binEdges,
      binCounts,
      residuals,
      numFeatures,
      sampleOrder,
      maxDepth,
      l2Lambda,
      minChildSamples,
      colSubsample: 0.8,
      rng,
    });
    trees.push(tree);

    for (let i = 0; i < trainCount; i += 1) {
      trainPred[i] += learningRate * evalTreeRow(tree, X, trainIndices[i] * numFeatures);
    }

    let valMse = 0;
    for (let i = 0; i < valCount; i += 1) {
      const idx = valIndices[i];
      valPred[i] += learningRate * evalTreeRow(tree, X, idx * numFeatures);
      const err = valPred[i] - y[idx];
      valMse += err * err;
    }
    valMse /= valCount;

    if (valMse < bestValMse - 1e-7) {
      bestValMse = valMse;
      bestTreeCount = t + 1;
      staleRounds = 0;
    } else {
      staleRounds += 1;
    }

    onProgress?.(0.25 + 0.35 * ((t + 1) / nTrees));
    if (staleRounds >= patience) break;
  }

  return {
    baseScore,
    learningRate,
    trees: trees.slice(0, bestTreeCount),
    valMse: bestValMse,
    bestTreeCount,
  };
}

/**
 * Runs Aydin-style FGR self-supervised denoising (`fgr-gbdt` or `fgr-ridge`) on a 2D or 3D
 * `[nz, ny, nx]` Float32 volume.
 *
 * @param {Float32Array} data
 * @param {[number, number, number]} dims `[nz, ny, nx]`
 * @param {{
 *   regressor?: 'gbdt' | 'ridge',
 *   use3d?: boolean,
 *   maxScale?: number,
 *   nTrees?: number,
 *   maxDepth?: number,
 *   learningRate?: number,
 *   maxSamples?: number,
 *   seed?: number,
 *   onProgress?: (fraction: number, stage: string) => void
 * }} [options]
 */
export function denoiseFgr(data, dims, options = {}) {
  const {
    regressor = "gbdt",
    use3d = dims[0] > 1,
    maxScale = 8,
    nTrees = 80,
    maxDepth = 4,
    learningRate = 0.08,
    maxSamples = regressor === "gbdt" ? 32000 : 80000,
    seed = 42,
    onProgress,
  } = options;

  const [nz, ny, nx] = dims;
  const plane = ny * nx;
  const totalVoxels = nz * plane;
  const stats = imageStats(data);
  if (!(stats.std > 1e-12) || totalVoxels < 4) {
    onProgress?.(1, "Constant or tiny image — returned unchanged");
    return {
      denoised: Float32Array.from(data),
      details: { regressor, use3d: Boolean(use3d && nz > 1), featureCount: 0, sampledVoxels: 0, valRmse: 0, treesUsed: 0 },
    };
  }

  const effective3d = Boolean(use3d && nz > 1);
  const invStd = 1 / stats.std;
  const norm = new Float32Array(data.length);
  for (let i = 0; i < data.length; i += 1) {
    norm[i] = (data[i] - stats.mean) * invStd;
  }

  onProgress?.(0.02, "Extracting J-invariant multiscale features…");
  const { X, y, count, numFeatures } = sampleFeaturesAndTargets(
    norm,
    dims,
    { use3d: effective3d, maxScale, maxSamples, seed },
    (p) => onProgress?.(p, "Extracting J-invariant multiscale features…"),
  );

  let model;
  if (regressor === "ridge") {
    onProgress?.(0.3, "Fitting self-supervised Ridge regressor…");
    model = fitRidgeModel(X, y, count, numFeatures, seed);
    onProgress?.(0.55, "Predicting denoised voxels…");
  } else {
    onProgress?.(0.25, "Training J-invariant boosted trees…");
    model = fitGbdtModel(
      X,
      y,
      count,
      numFeatures,
      { nTrees, maxDepth, learningRate, seed },
      (p) => onProgress?.(p, "Training J-invariant boosted trees…"),
    );
    onProgress?.(0.6, "Predicting denoised voxels…");
  }

  const denoised = new Float32Array(data.length);
  const stripRows = Math.max(1, Math.min(ny, Math.floor(MAX_STRIP_PIXELS / Math.max(1, nx))));
  const scratch = {};
  const mean = stats.mean;
  const std = stats.std;

  for (let z = 0; z < nz; z += 1) {
    const sliceBase = z * plane;
    for (let yStart = 0; yStart < ny; yStart += stripRows) {
      const yEnd = Math.min(ny, yStart + stripRows);
      const feats = extractSliceFeatures(
        norm,
        dims,
        z,
        { use3d: effective3d, maxScale, yStart, yEnd },
        scratch,
      );
      const stripLen = (yEnd - yStart) * nx;
      const outBase = sliceBase + yStart * nx;

      if (regressor === "ridge") {
        const w = model.weights;
        const bias = w[numFeatures];
        for (let p = 0; p < stripLen; p += 1) {
          const rowOffset = p * numFeatures;
          let pred = bias;
          for (let f = 0; f < numFeatures; f += 1) pred += w[f] * feats[rowOffset + f];
          denoised[outBase + p] = pred * std + mean;
        }
      } else {
        const { baseScore, trees } = model;
        const lr = model.learningRate;
        const numTrees = trees.length;
        for (let p = 0; p < stripLen; p += 1) {
          const rowOffset = p * numFeatures;
          let pred = baseScore;
          for (let t = 0; t < numTrees; t += 1) {
            const tree = trees[t];
            let node = 0;
            while (tree.feat[node] >= 0) {
              node = feats[rowOffset + tree.feat[node]] <= tree.thresh[node] ? tree.left[node] : tree.right[node];
            }
            pred += lr * tree.value[node];
          }
          denoised[outBase + p] = pred * std + mean;
        }
      }
    }
    onProgress?.(0.6 + 0.38 * ((z + 1) / nz), `Predicting slice ${z + 1} of ${nz}…`);
  }

  onProgress?.(1, "Done");
  return {
    denoised,
    details: {
      regressor,
      use3d: effective3d,
      featureCount: numFeatures,
      sampledVoxels: count,
      valRmse: Number((Math.sqrt(Math.max(0, model.valMse)) * std).toPrecision(4)),
      ...(regressor === "ridge" ? { lambda: model.lambda } : { treesUsed: model.bestTreeCount }),
    },
  };
}
