/*
 * Pure numeric helpers used by the LNM inference worker
 * (web/js/inference-worker.js). No ONNX, no DOM, no worker globals, so the
 * same code runs in the module worker and under Node tests
 * (scripts/test_inference_numerics.mjs).
 */

import * as InferencePipeline from '../inference-pipeline.js';

export function shouldUseZYXModelAxisOrder(preprocessing, dims, patchSize) {
  const modelAxisOrder = preprocessing?.modelAxisOrder;
  if (modelAxisOrder === 'zyx') return true;
  if (modelAxisOrder !== 'zyx-if-x-short-z-long') return false;

  const [nx, , nz] = dims;
  const [px] = Array.isArray(patchSize) ? patchSize : [];
  return Number.isFinite(px) && nx < px && nz >= px;
}

export function binaryMaskFromBuffer(maskBuffer, maskDims, expectedDims, label) {
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

export function foregroundMaskFromScalar(data, fractionOfMax = 0.05) {
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

export function robustNormalizeMasked(data, mask = null, options = {}) {
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

export function normaliseSynthMorphExecutionProviders(value) {
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

export function fOrderToNDHWC(fdata, dims) {
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

export function dimsEqual(a, b) {
  return Array.isArray(a) && Array.isArray(b) &&
    a.length === b.length &&
    a.every((value, index) => Number(value) === Number(b[index]));
}

export function affinesClose(a, b, tolerance = 1e-3) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) {
      if (Math.abs(Number(a[r]?.[c]) - Number(b[r]?.[c])) > tolerance) return false;
    }
  }
  return true;
}

export function nonzeroZScore(data) {
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
    // Like MONAI NormalizeIntensity(nonzero=True): only nonzero voxels are
    // normalised; zero background (and non-finite input) stays zero.
    out[i] = value !== 0 && Number.isFinite(value) ? (value - mean) / std : 0;
  }
  return out;
}

export function zeroPadChannelsToPatchMultiple(channels, dims, patchSize) {
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

export function extractMultiChannelPatch(channels, volumeDims, position, patchDims) {
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

export function softmaxStrokeChannel(raw, voxels, channels = 2, strokeChannel = 1) {
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

export async function runDeepIslesMultiChannelPipeline(input, runPatch, options = {}) {
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

// Collapse 2-channel softmax logits ([bg, stroke], NCDHW) to single-channel
// raw log-odds: `logit_stroke - logit_bg`. The pipeline sigmoids this and
// thresholds; under the softmax model that yields P(stroke). 1-channel
// models pass through unchanged.
export function collapseBinarySoftmaxLogits(raw, voxels, outputName = 'output') {
  if (raw.length === voxels) return raw;
  if (raw.length === 2 * voxels) {
    const collapsed = new Float32Array(voxels);
    for (let i = 0; i < voxels; i++) collapsed[i] = raw[voxels + i] - raw[i];
    return collapsed;
  }
  throw new Error(
    `Unexpected ${outputName} length ${raw.length}; expected ${voxels} (1-channel) or ${2 * voxels} (binary softmax)`
  );
}

// Convert an inverse-warped (nearest-sampled) Float32 volume back to its
// integer output type: label maps keep their rounded positive labels, binary
// masks are thresholded at 0.5.
export function projectedVolumeToLabels(projected, { labelMap = false, labelDataType = 'uint8' } = {}) {
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
  return projectedOut;
}
