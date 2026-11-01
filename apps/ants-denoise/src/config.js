// DOM-independent app config. Kept pure so it can be unit-tested under Node
// without a browser (see test/config.test.js).
import automation from "../automation.json" with { type: "json" };
import { denoiseArguments } from "@neurodesk/ants-denoise";
import { DENOISE_WASM_SHA256 } from "@neurodesk/ants-denoise/pin";
import { outputNames } from "@neurodesk/webapp-components/file-io/bids-derivatives";

export const APP = Object.freeze({
  id: "ants-denoise",
  title: automation.title,
  version: "0.0.20261029",
});

// DenoiseImage's noise model and radii with its defaults, as automation.json declares them. ANTs
// takes any positive radius; the app stops at the largest pair checked against native ANTs
// (patch 2, search 3), since the work per voxel grows as (2p + 1)^3 (2r + 1)^3.
const { noiseModel, patchRadius, searchRadius } = automation.operations.denoise.parameters;
export const SETTINGS = Object.freeze({
  noiseModel: Object.freeze({ values: Object.freeze([...noiseModel.enum]), default: noiseModel.default }),
  patchRadius: Object.freeze({ min: patchRadius.minimum, max: patchRadius.maximum, default: patchRadius.default }),
  searchRadius: Object.freeze({ min: searchRadius.minimum, max: searchRadius.maximum, default: searchRadius.default }),
});

/** The denoise settings from form or automation values; a value outside its range is refused. */
export function denoiseSettings(values = {}) {
  const settings = {
    noiseModel: values.noiseModel ?? SETTINGS.noiseModel.default,
    patchRadius: values.patchRadius ?? SETTINGS.patchRadius.default,
    searchRadius: values.searchRadius ?? SETTINGS.searchRadius.default,
  };
  if (!SETTINGS.noiseModel.values.includes(settings.noiseModel)) {
    throw new Error(`Choose the ${SETTINGS.noiseModel.values.join(" or ")} noise model.`);
  }
  for (const [key, label] of [["patchRadius", "Patch radius"], ["searchRadius", "Search radius"]]) {
    const { min, max } = SETTINGS[key];
    const value = settings[key];
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(`${label} must be a whole number from ${min} to ${max}.`);
    }
  }
  return settings;
}

/** Why an image cannot be denoised here, or null: the module runs DenoiseImage -d 3 on one volume. */
export function volumeRefusal({ dimensionality, frames, dims }) {
  if (frames > 1) {
    return `This image has ${frames} volumes. Choose one 3D volume; for a diffusion series use dwidenoise.`;
  }
  if (dimensionality !== 3) {
    return `This image is ${dims.join(" × ")}, not a 3D volume. Choose a 3D image.`;
  }
  return null;
}

/** The download name of the denoised image: the input's BIDS entities with desc-denoised. */
export function denoisedName(inputName) {
  return outputNames(inputName, "denoised").image;
}

/** Integer label masks retain native ANTs' unsigned-char mask selection. */
export function maskValueRefusal(values) {
  return values.some((value) => !Number.isInteger(value) || value < 0 || value > 255)
    ? "Use a mask with whole-number values from 0 to 255. Convert probability maps to a binary mask first."
    : null;
}

function shellArgument(value) {
  return /^[A-Za-z0-9_./=-]+$/.test(value) ? value : "'" + value.replaceAll("'", "'\\''") + "'";
}

/**
 * The run's provenance: the settings, the mask and the native command that writes the same voxels.
 * DenoiseImage's adaptive filter depends on how ITK splits the image between threads, so the
 * native command runs on one thread, as the WebAssembly module does.
 */
export function provenance({ input, settings, mask = null }) {
  const argv = denoiseArguments({ input, output: denoisedName(input), mask: mask?.name ?? null, ...settings });
  return {
    method: "ANTs DenoiseImage: adaptive non-local means (Manjón et al. 2010)",
    module: { package: "@neurodesk/ants-denoise", wasmSha256: DENOISE_WASM_SHA256, threads: 1 },
    settings: { ...settings, shrinkFactor: 1 },
    mask: mask ? { name: mask.name, voxels: mask.voxels } : null,
    nativeArgv: ["DenoiseImage", ...argv],
    nativeEnvironment: { ITK_GLOBAL_DEFAULT_NUMBER_OF_THREADS: "1" },
    nativeCommand: `ITK_GLOBAL_DEFAULT_NUMBER_OF_THREADS=1 DenoiseImage ${argv.map(shellArgument).join(" ")}`,
  };
}
