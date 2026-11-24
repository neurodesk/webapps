// Unified self-supervised and classical denoising pipeline dispatcher.
// DOM-free so both browser workers and Node unit/reference tests execute the exact same code.

import { denoiseFgr } from "./fgr.js";
import { assertFiniteVoxels, residualDiagnostics } from "./metrics.js";
import { denoiseVstNlm } from "./vst-nlm.js";
import { denoiseZsN2n } from "./zsn2n.js";

export const METHODS = Object.freeze({
  "fgr-gbdt": Object.freeze({
    id: "fgr-gbdt",
    label: "Aydin FGR (Boosted Trees)",
    shortLabel: "Aydin FGR-GBDT",
  }),
  "fgr-ridge": Object.freeze({
    id: "fgr-ridge",
    label: "Aydin FGR (Fast Ridge)",
    shortLabel: "Aydin FGR-Ridge",
  }),
  "zs-n2n": Object.freeze({
    id: "zs-n2n",
    label: "Zero-Shot Noise2Noise (CNN)",
    shortLabel: "ZS-N2N",
  }),
  "vst-nlm": Object.freeze({
    id: "vst-nlm",
    label: "Anscombe VST + Non-Local Means",
    shortLabel: "VST-NLM",
  }),
});

export const MODES = Object.freeze(["auto", "2d", "3d"]);
export const NOISE_MODELS = Object.freeze(["poisson-gaussian", "gaussian"]);
export const MAX_SCALES = Object.freeze([2, 4, 8]);

export const DEFAULT_SETTINGS = Object.freeze({
  method: "fgr-gbdt",
  mode: "auto",
  nTrees: 80,
  maxDepth: 4,
  maxScale: 8,
  iterations: 200,
  channels: 16,
  noiseModel: "poisson-gaussian",
  nlmStrength: 1.0,
  seed: 42,
});

function checkInt(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be a whole number from ${min} to ${max}.`);
  }
  return value;
}

function checkNumber(value, name, min, max) {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a number from ${min} to ${max}.`);
  }
  return value;
}

/**
 * Validates and normalises denoising settings, validating only parameters active for the
 * selected `method` so inactive/disabled form controls never block another method.
 * @param {Partial<typeof DEFAULT_SETTINGS>} [raw]
 */
export function runSettings(raw = {}) {
  const method = raw.method ?? DEFAULT_SETTINGS.method;
  if (!Object.hasOwn(METHODS, method)) {
    throw new Error(`Unknown denoising method '${method}'.`);
  }
  const base = { ...DEFAULT_SETTINGS, method };

  if (method !== "zs-n2n") {
    const mode = raw.mode ?? DEFAULT_SETTINGS.mode;
    if (!MODES.includes(mode)) {
      throw new Error(`Processing mode must be one of: ${MODES.join(", ")}.`);
    }
    base.mode = mode;
  }

  if (method === "fgr-gbdt" || method === "fgr-ridge") {
    const maxScale = Number(raw.maxScale ?? DEFAULT_SETTINGS.maxScale);
    if (!MAX_SCALES.includes(maxScale)) {
      throw new Error(`Max scale radius must be one of: ${MAX_SCALES.join(", ")}.`);
    }
    base.maxScale = maxScale;
    base.seed = checkInt(Number(raw.seed ?? DEFAULT_SETTINGS.seed), "Random seed", 0, 2147483647);
  }

  if (method === "fgr-gbdt") {
    base.nTrees = checkInt(Number(raw.nTrees ?? DEFAULT_SETTINGS.nTrees), "Trees", 10, 200);
    base.maxDepth = checkInt(Number(raw.maxDepth ?? DEFAULT_SETTINGS.maxDepth), "Tree depth", 2, 6);
  }

  if (method === "zs-n2n") {
    base.iterations = checkInt(Number(raw.iterations ?? DEFAULT_SETTINGS.iterations), "Training steps", 50, 1500);
    base.channels = checkInt(Number(raw.channels ?? DEFAULT_SETTINGS.channels), "CNN channels", 16, 48);
    base.seed = checkInt(Number(raw.seed ?? DEFAULT_SETTINGS.seed), "Random seed", 0, 2147483647);
  }

  if (method === "vst-nlm") {
    const noiseModel = raw.noiseModel ?? DEFAULT_SETTINGS.noiseModel;
    if (!NOISE_MODELS.includes(noiseModel)) {
      throw new Error(`Noise model must be one of: ${NOISE_MODELS.join(", ")}.`);
    }
    base.noiseModel = noiseModel;
    base.nlmStrength = checkNumber(Number(raw.nlmStrength ?? DEFAULT_SETTINGS.nlmStrength), "Filter strength", 0.2, 3.0);
  }

  return base;
}

/**
 * Returns the exact subset of settings that govern a run of `settings.method`,
 * suitable for provenance and exact replay.
 */
export function effectiveSettings(settings) {
  if (settings.method === "fgr-gbdt") {
    return {
      method: settings.method,
      mode: settings.mode,
      nTrees: settings.nTrees,
      maxDepth: settings.maxDepth,
      maxScale: settings.maxScale,
      seed: settings.seed,
    };
  }
  if (settings.method === "fgr-ridge") {
    return {
      method: settings.method,
      mode: settings.mode,
      maxScale: settings.maxScale,
      seed: settings.seed,
    };
  }
  if (settings.method === "zs-n2n") {
    return {
      method: settings.method,
      iterations: settings.iterations,
      channels: settings.channels,
      seed: settings.seed,
    };
  }
  return {
    method: settings.method,
    mode: settings.mode,
    noiseModel: settings.noiseModel,
    nlmStrength: settings.nlmStrength,
  };
}

/**
 * Runs the requested denoising method on `[nz, ny, nx]` Float32 data and computes residual diagnostics.
 * Validates input and output finiteness before returning.
 *
 * @param {Float32Array} data
 * @param {[number, number, number]} dims
 * @param {Partial<typeof DEFAULT_SETTINGS>} [rawSettings]
 * @param {(fraction: number, stage: string) => void} [onProgress]
 */
export function denoiseVolume(data, dims, rawSettings = {}, onProgress) {
  const settings = runSettings(rawSettings);
  const [nz, ny, nx] = dims;
  if (!(nz >= 1 && ny >= 1 && nx >= 1) || data.length !== nz * ny * nx) {
    throw new Error(`Volume dimensions [${dims.join(", ")}] do not match data length ${data.length}.`);
  }
  assertFiniteVoxels(data, "Input image");

  const use3d = settings.mode === "2d" ? false : nz > 1;
  const emit = (fraction, stage) => onProgress?.(Math.min(0.96, Math.max(0, fraction * 0.96)), stage);

  let outcome;
  if (settings.method === "fgr-gbdt") {
    outcome = denoiseFgr(data, dims, {
      regressor: "gbdt",
      use3d,
      maxScale: settings.maxScale,
      nTrees: settings.nTrees,
      maxDepth: settings.maxDepth,
      seed: settings.seed,
      onProgress: emit,
    });
  } else if (settings.method === "fgr-ridge") {
    outcome = denoiseFgr(data, dims, {
      regressor: "ridge",
      use3d,
      maxScale: settings.maxScale,
      seed: settings.seed,
      onProgress: emit,
    });
  } else if (settings.method === "zs-n2n") {
    outcome = denoiseZsN2n(data, dims, {
      iterations: settings.iterations,
      channels: settings.channels,
      seed: settings.seed,
      onProgress: emit,
    });
  } else {
    outcome = denoiseVstNlm(data, dims, {
      noiseModel: settings.noiseModel,
      use3d,
      strength: settings.nlmStrength,
      onProgress: emit,
    });
  }

  assertFiniteVoxels(outcome.denoised, "Denoised output");
  onProgress?.(0.97, "Computing residual diagnostics…");
  const { residual, ...diagnostics } = residualDiagnostics(data, outcome.denoised, dims);
  assertFiniteVoxels(residual, "Residual output");
  onProgress?.(1, "Done");

  return {
    denoised: outcome.denoised,
    residual,
    diagnostics,
    details: outcome.details,
    settings,
  };
}
