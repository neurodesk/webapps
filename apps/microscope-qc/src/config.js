// DOM-independent configuration: the settings form, its validation and provenance. Kept pure
// so Node tests can import it.
import automation from "../automation.json" with { type: "json" };
import { MICROSCOPES, theoreticalResolution, wavelengthKind } from "./core/optics.js";

export const APP = Object.freeze({
  id: "microscope-qc",
  title: automation.title,
  version: "0.1.20261113",
});

export const ANALYSES = Object.freeze({ psf: "PSF from beads", field: "Field illumination" });

/** Files above this are refused before they are read into memory. */
export const MAX_FILE_BYTES = 1e9;

/** Images whose estimated peak working memory is above this are refused before decoding. */
export const MAX_PEAK_BYTES = 2e9;

// Working memory per pixel of one plane, on top of the float32 stack (4 bytes per voxel, held
// once: the page and the worker hand it back and forth): the float64 projection (8), the sort
// order array (16, V8's worst case with its sort copy), the union-find arrays (8), the maxima
// list (16) and the page's projection, its float32 copy and the display NIfTI (16). Field
// illumination's blur, zones and returned copy fit inside the same allowance.
const PLANE_BYTES_PER_PIXEL = 64;

/**
 * Estimated peak bytes for an image: while decoding, the encoded file and the stack; while
 * analysing, the stack and the per-plane working arrays.
 */
export function peakBytes({ width, height, pages }, encodedBytes = 0) {
  const plane = width * height;
  const stack = 4 * plane * pages;
  return Math.max(encodedBytes + stack, stack + PLANE_BYTES_PER_PIXEL * plane);
}

/** Refuses a file too large to read, before `file.arrayBuffer()`. */
export function checkFileSize(file) {
  if (file.size > MAX_FILE_BYTES) throw new Error(`${file.name} is ${(file.size / 1e9).toFixed(2)} GB; the limit is ${(MAX_FILE_BYTES / 1e9).toFixed(1)} GB. Crop it first.`);
}

/** Refuses stacks this app cannot interpret or hold, from the page directories, before decoding. */
export function checkStack(info, encodedBytes = 0) {
  const { metadata, pages, width, height } = info;
  if (metadata.images > 1) throw new Error(`This OME-TIFF holds ${metadata.images} images (series); save the one to analyse as its own file.`);
  if (metadata.sizeC > 1) throw new Error(`This TIFF has ${metadata.sizeC} channels; save one channel as its own stack.`);
  if (metadata.sizeT > 1 && metadata.sizeZ > 1) throw new Error(`This TIFF is a time series of ${metadata.sizeZ}-plane stacks; save one time point.`);
  if (metadata.sizeT > 1 && metadata.kind !== "baseline") throw new Error(`This TIFF is a time series of ${metadata.sizeT} frames, not a z-stack or a single image.`);
  const bytes = peakBytes({ width, height, pages }, encodedBytes);
  if (bytes > MAX_PEAK_BYTES) throw new Error(`This image needs about ${(bytes / 1e9).toFixed(2)} GB of working memory; the limit is ${(MAX_PEAK_BYTES / 1e9).toFixed(1)} GB. Crop it first.`);
}

export class SettingsError extends Error {
  constructor(field, message) {
    super(message);
    this.name = "SettingsError";
    this.field = field;
  }
}

function number(values, field, label, { min = -Infinity, max = Infinity, optional = false, exclusiveMin = false, integer = false } = {}) {
  const raw = values[field];
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    if (optional) return null;
    throw new SettingsError(field, `Enter ${label}.`);
  }
  const value = Number(raw);
  const low = exclusiveMin ? value <= min : value < min;
  if (!Number.isFinite(value) || low || value > max) {
    const range = `${exclusiveMin ? "above" : "at least"} ${min}${Number.isFinite(max) ? ` and at most ${max}` : ""}`;
    throw new SettingsError(field, `${label[0].toUpperCase()}${label.slice(1)} must be a number ${range}.`);
  }
  if (integer && !Number.isInteger(value)) throw new SettingsError(field, `${label[0].toUpperCase()}${label.slice(1)} must be a whole number.`);
  return value;
}

/**
 * Validates the form values for one analysis. PSF needs the optics (for the theoretical
 * resolution) and the voxel size; field illumination needs neither.
 */
export function readSettings(values) {
  const analysis = values.analysis;
  if (!(analysis in ANALYSES)) throw new SettingsError("analysis", `Choose an analysis: ${Object.keys(ANALYSES).join(" or ")}.`);
  if (analysis === "field") {
    return {
      analysis,
      blur: values.blur !== false && values.blur !== "false",
      referenceZone: values.referenceZone !== false && values.referenceZone !== "false",
      step: number(values, "step", "the iso-intensity step", { min: 1, max: 50, integer: true }),
    };
  }
  const microscope = values.microscope;
  if (!(microscope in MICROSCOPES)) throw new SettingsError("microscope", `Choose a microscope type: ${Object.keys(MICROSCOPES).join(", ")}.`);
  const na = number(values, "na", "the numerical aperture", { min: 0, max: 1.7, exclusiveMin: true });
  const refractiveIndex = number(values, "refractiveIndex", "the immersion refractive index", { min: 1, max: 2 });
  if (na >= refractiveIndex) throw new SettingsError("na", `The NA (${na}) must be below the refractive index (${refractiveIndex}).`);
  const kind = wavelengthKind(microscope);
  const emission = number(values, "emission", "the emission wavelength", { min: 200, max: 2000, optional: kind !== "emission" });
  const excitation = number(values, "excitation", "the excitation wavelength", { min: 200, max: 2000, optional: kind !== "excitation" });
  const pixelX = number(values, "pixelX", "the pixel width in µm", { min: 0, max: 100, exclusiveMin: true });
  const pixelY = number(values, "pixelY", "the pixel height in µm", { min: 0, max: 100, exclusiveMin: true });
  const zStep = number(values, "zStep", "the z step in µm", { min: 0, max: 100, exclusiveMin: true });
  const theory = theoreticalResolution({ type: microscope, na, refractiveIndex, emission, excitation });
  const boxRadius = number(values, "boxRadius", "the bead box radius in µm", { min: 0, max: 100, optional: true, exclusiveMin: true });
  const prominence = number(values, "prominence", "the prominence", { min: 0, optional: true, exclusiveMin: true });
  const minR2 = number(values, "minR2", "the minimum R²", { min: 0, max: 1 });
  return {
    analysis,
    microscope,
    na,
    refractiveIndex,
    emission,
    excitation,
    pixelX,
    pixelY,
    zStep,
    theory,
    boxRadius,
    prominence,
    minR2,
    excludeSaturated: values.excludeSaturated !== false && values.excludeSaturated !== "false",
  };
}

/** The bead box half-width in pixels: the entered radius, or 4 theoretical lateral FWHMs. */
export function boxHalfWidth(settings) {
  const radius = settings.boxRadius ?? 4 * settings.theory.lateral;
  return Math.max(2, Math.round(radius / Math.min(settings.pixelX, settings.pixelY)));
}

/** The value counted as saturated for a sample type (the largest an integer type holds). */
export function saturationLevel(dtype) {
  return { uint8: 255, uint16: 65535, uint32: 4294967295, int8: 127, int16: 32767, int32: 2147483647 }[dtype] ?? null;
}

/** The analysis an image suggests: a z-stack is beads, a single plane a field image. */
export function suggestedAnalysis(planes) {
  return planes > 1 ? "psf" : "field";
}

export function provenance({ input, settings, dims, extra = {} }) {
  return {
    app: APP.id,
    version: APP.version,
    analysis: settings.analysis,
    definitions: "MetroloJ_QC (Faklaris et al. 2022, J Cell Biol 221:e202107093)",
    input: { name: input.name, bytes: input.size, width: dims.width, height: dims.height, planes: dims.planes, dtype: dims.dtype, metadata: dims.metadataKind },
    settings: Object.fromEntries(Object.entries(settings).filter(([key]) => key !== "theory")),
    ...(settings.theory ? { theoreticalResolutionUm: settings.theory } : {}),
    ...extra,
    created: new Date().toISOString(),
  };
}
