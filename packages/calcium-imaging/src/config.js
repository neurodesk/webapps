// DOM-independent app config: settings validation and provenance, shared by webapp and CLI.
import packageJson from "../package.json" with { type: "json" };
import { DEFAULTS } from "./core/pipeline.js";

/** Maximum decoded float32 movie size (500 MB). */
export const MAX_MOVIE_BYTES = 500_000_000;

/**
 * Refuses a TIFF that is not one single-plane, single-channel movie of at least 20 frames,
 * from its page directories (before any pixel is decoded).
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

/** Validated run settings from raw form or CLI values. Throws SettingsError naming the field. */
export function readSettings(values) {
  const settings = { ...DEFAULTS };
  if (!Object.hasOwn(MOTION_LABELS, values.motion)) throw new SettingsError("motion", `Unknown motion correction "${values.motion}".`);
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
export function provenance({ input, settings, dims, roiSource, cells, detection, timings, version = packageJson.version }) {
  return {
    app: "calcium-imaging",
    version,
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
