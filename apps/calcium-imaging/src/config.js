// DOM-independent app config: settings validation and provenance, unit-tested under Node.
import automation from "../automation.json" with { type: "json" };
import { DEFAULTS } from "./core/pipeline.js";

export const APP = Object.freeze({
  id: "calcium-imaging",
  title: automation.title,
  version: "0.0.20261105",
});

/**
 * The decoded float32 movie may use at most 500 MB. Measured 2026-11-05 (Playwright Chromium,
 * Linux, cross-origin isolated) on a synthetic 512 × 512 × 256 uint16 movie (268 MB as
 * float32): loading, a default rigid run, viewing and downloading the registered movie peaked at
 * 7.4× the float32 size, summed PSS of every Chromium process (page, workers, GPU). 500 MB
 * keeps that peak near 3.7 GB.
 */
export const MAX_MOVIE_BYTES = 500_000_000;

/**
 * Refuses a TIFF that is not one single-plane, single-channel movie of at least 20 frames,
 * from its page directories (before any pixel is decoded). A plain TIFF does not label its
 * pages, and ImageJ writes any unlabelled stack as `slices=N` without `frames=` or
 * `hyperstack=true`, so such a stack is read as N frames; OME `SizeZ` and ImageJ hyperstack
 * `slices` are spatial and refused.
 * @param {import("@neurodesk/webapp-components/file-io/tiff").TiffStackInfo} info
 * @returns {{ frames: number }}
 */
export function checkMovie({ pages, metadata }, name) {
  const unlabelled = metadata.unlabelledStack === true;
  const sizeZ = unlabelled ? 1 : metadata.sizeZ;
  const sizeT = unlabelled ? pages / Math.max(1, metadata.sizeC) : metadata.sizeT;
  if (metadata.sizeC > 1) throw new Error(`${name} has ${metadata.sizeC} channels; save the calcium channel as its own movie.`);
  if (sizeZ > 1 && sizeT > 1) throw new Error(`${name} is a volume time series (${sizeZ} planes × ${sizeT} time points); save one plane as its own movie.`);
  if (sizeZ > 1) throw new Error(`${name} is a Z-stack of ${sizeZ} planes, not a movie; this app needs one plane over time.`);
  if (sizeT !== pages) throw new Error(`${name} declares ${sizeT} time points but holds ${pages} pages; save the movie again.`);
  if (pages < 20) throw new Error(`${name} has ${pages} pages; a movie needs at least 20 frames.`);
  return { frames: pages };
}

export const MOTION_LABELS = Object.freeze({
  rigid: "Rigid",
  piecewise: "Piecewise rigid",
  none: "None",
});

const FIELDS = {
  frameRate: { label: "Frame rate", min: 0.01, max: 10000 },
  maxShift: { label: "Maximum shift", min: 0, max: 200, integer: true },
  upsample: { label: "Sub-pixel upsampling", min: 1, max: 100, integer: true },
  templatePasses: { label: "Template passes", min: 1, max: 5, integer: true },
  patchSize: { label: "Patch size", min: 16, max: 1024, integer: true },
  patchOverlap: { label: "Patch overlap", min: 0, max: 1023, integer: true },
  maxDeviation: { label: "Maximum patch deviation", min: 0, max: 50, integer: true },
  diameter: { label: "Cell diameter", min: 3, max: 100 },
  seedZ: { label: "Seed threshold", min: 0.5, max: 50 },
  neuropilCoefficient: { label: "Neuropil coefficient", min: 0, max: 1.5 },
  baselineWindow: { label: "Baseline window", min: 1, max: 100000 },
  baselinePercentile: { label: "Baseline percentile", min: 0, max: 100 },
};

export class SettingsError extends Error {
  constructor(field, message) {
    super(message);
    this.name = "SettingsError";
    this.field = field;
  }
}

/**
 * Validated run settings from raw form values (strings or numbers). Throws SettingsError naming
 * the field that needs attention.
 */
export function readSettings(values) {
  const settings = { ...DEFAULTS };
  if (!(values.motion in MOTION_LABELS)) throw new SettingsError("motion", `Unknown motion correction "${values.motion}".`);
  settings.motion = values.motion;
  if (!["none", "phase"].includes(values.normalization ?? "none")) throw new SettingsError("normalization", `Unknown normalisation "${values.normalization}".`);
  settings.normalization = values.normalization ?? "none";
  settings.deconvolution = values.deconvolution !== false;
  for (const [name, rule] of Object.entries(FIELDS)) {
    const raw = values[name];
    if (raw === undefined || raw === "") {
      if (name === "frameRate") throw new SettingsError(name, "Enter the frame rate in Hz.");
      continue;
    }
    const value = Number(raw);
    if (!Number.isFinite(value) || value < rule.min || value > rule.max || (rule.integer && !Number.isInteger(value))) {
      throw new SettingsError(name, `${rule.label} must be ${rule.integer ? "a whole number " : ""}between ${rule.min} and ${rule.max}.`);
    }
    settings[name] = value;
  }
  if (settings.motion === "piecewise" && settings.patchOverlap >= settings.patchSize) {
    throw new SettingsError("patchOverlap", "Patch overlap must be smaller than the patch size.");
  }
  return settings;
}

/** The run's provenance record, written beside the outputs. */
export function provenance({ input, settings, dims, roiSource, cells, detection, timings }) {
  return {
    app: APP.id,
    version: APP.version,
    input: { name: input.name, bytes: input.size, dtype: dims.dtype, frames: dims.frames, height: dims.height, width: dims.width, metadata: dims.metadataKind },
    frameRateHz: settings.frameRate,
    motionCorrection: {
      mode: settings.motion,
      estimator: settings.normalization === "phase" ? "phase correlation" : "Fourier cross-correlation",
      upsample: settings.upsample,
      maxShiftPx: settings.maxShift,
      templatePasses: settings.templatePasses,
      initialTemplate: "median of 10-frame bin means",
      resampling: "bilinear, borders replicated",
      ...(settings.motion === "piecewise" ? { patchSizePx: settings.patchSize, patchOverlapPx: settings.patchOverlap, maxDeviationPx: settings.maxDeviation } : {}),
    },
    rois: {
      source: roiSource,
      count: cells.length,
      ...(detection ? { method: "local-correlation seeds and watershed", cellDiameterPx: settings.diameter, seedZ: settings.seedZ, seedThreshold: detection.threshold, growthFloor: detection.floor, borderMarginPx: detection.margin, seeds: detection.seeds } : {}),
    },
    traces: {
      neuropil: "ring from 2 px beyond each ROI, ≥ 200 px, excluding pixels within 2 px of any ROI and the border band",
      neuropilCoefficient: settings.neuropilCoefficient,
      baseline: `running ${settings.baselinePercentile}th percentile over ${settings.baselineWindow} s`,
      deltaFOverF: "(Fc − F0) / F0",
    },
    deconvolution: settings.deconvolution ? { method: "OASIS AR(1), L1, noise-constrained (Friedrich et al. 2017)", input: "ΔF/F" } : null,
    timings,
  };
}
