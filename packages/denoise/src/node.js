// Node command-line interface for @neurodesk/denoise.
// Runs the exact same self-supervised denoising core and calibrated TIFF/NIfTI encoders
// as the Denoise web application.
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import {
  DEFAULT_SETTINGS,
  MAX_SCALES,
  METHODS,
  MODES,
  NOISE_MODELS,
  denoiseVolume,
  runSettings,
} from "./core/denoise.js";
import { createNormalRng, createRng } from "./core/rng.js";
import { exportNiftiBuffer, outputNames, provenance, stackTiff } from "./format.js";
import { readVolume } from "./input.js";

/** Maximum decoded Float32 voxel bytes accepted by the CLI (256 MiB = 67.1M voxels). */
export const MAX_CLI_INPUT_BYTES = 2 ** 28;

export const OUTPUT_FORMATS = Object.freeze(["auto", "tiff", "nifti", "both"]);

export const OPTIONS = Object.freeze({
  method: {
    type: "string",
    enum: Object.keys(METHODS),
    default: DEFAULT_SETTINGS.method,
    description: "Self-supervised or classical denoising method.",
  },
  mode: {
    type: "string",
    enum: [...MODES],
    default: DEFAULT_SETTINGS.mode,
    description: "Processing mode for FGR and VST-NLM (auto uses 3D on stacks, 2D on single planes).",
  },
  nTrees: {
    type: "integer",
    flag: "trees",
    minimum: 10,
    maximum: 200,
    default: DEFAULT_SETTINGS.nTrees,
    description: "Boosted trees count for fgr-gbdt.",
  },
  maxDepth: {
    type: "integer",
    flag: "depth",
    minimum: 2,
    maximum: 6,
    default: DEFAULT_SETTINGS.maxDepth,
    description: "Maximum tree depth for fgr-gbdt.",
  },
  maxScale: {
    type: "integer",
    flag: "max-scale",
    enum: [...MAX_SCALES],
    default: DEFAULT_SETTINGS.maxScale,
    description: "Maximum J-invariant feature radius in pixels for FGR.",
  },
  iterations: {
    type: "integer",
    minimum: 50,
    maximum: 1500,
    default: DEFAULT_SETTINGS.iterations,
    description: "Adam optimization steps for zs-n2n.",
  },
  channels: {
    type: "integer",
    minimum: 16,
    maximum: 48,
    default: DEFAULT_SETTINGS.channels,
    description: "Residual CNN channel width for zs-n2n.",
  },
  noiseModel: {
    type: "string",
    flag: "noise-model",
    enum: [...NOISE_MODELS],
    default: DEFAULT_SETTINGS.noiseModel,
    description: "Noise variance model for vst-nlm.",
  },
  nlmStrength: {
    type: "number",
    flag: "nlm-strength",
    minimum: 0.2,
    maximum: 3.0,
    default: DEFAULT_SETTINGS.nlmStrength,
    description: "Non-local means filter strength multiplier for vst-nlm.",
  },
  seed: {
    type: "integer",
    minimum: 0,
    maximum: 2147483647,
    default: DEFAULT_SETTINGS.seed,
    description: "Deterministic random seed for FGR and zs-n2n.",
  },
  format: {
    type: "string",
    enum: [...OUTPUT_FORMATS],
    default: "auto",
    description: "Output image format (auto matches input format; both writes TIFF and NIfTI).",
  },
  residual: {
    type: "boolean",
    default: false,
    description: "Also write the noise residual map (input minus denoised).",
  },
  overwrite: {
    type: "boolean",
    default: false,
    description: "Allow writing into a non-empty output directory.",
  },
});

export function optionName(key) {
  return OPTIONS[key]?.flag ?? key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

function parseNumeric(raw, label, { integer = false } = {}) {
  if (raw === undefined) return undefined;
  const trimmed = String(raw).trim();
  if (!trimmed) throw new Error(`--${label} requires a value.`);
  const value = Number(trimmed);
  if (!Number.isFinite(value)) throw new Error(`--${label} must be a finite number, got '${raw}'.`);
  if (integer && !Number.isInteger(value)) throw new Error(`--${label} must be an integer, got '${raw}'.`);
  return value;
}

/** Parses CLI option values into validated denoising settings + output flags. */
export function parseCliOptions(values = {}) {
  const format = values.format ?? "auto";
  if (!OUTPUT_FORMATS.includes(format)) {
    throw new Error(`--format must be one of: ${OUTPUT_FORMATS.join(", ")}.`);
  }
  const settings = runSettings({
    method: values.method,
    mode: values.mode,
    nTrees: parseNumeric(values.trees ?? values.nTrees, "trees", { integer: true }),
    maxDepth: parseNumeric(values.depth ?? values.maxDepth, "depth", { integer: true }),
    maxScale: parseNumeric(values["max-scale"] ?? values.maxScale, "max-scale", { integer: true }),
    iterations: parseNumeric(values.iterations, "iterations", { integer: true }),
    channels: parseNumeric(values.channels, "channels", { integer: true }),
    noiseModel: values["noise-model"] ?? values.noiseModel,
    nlmStrength: parseNumeric(values["nlm-strength"] ?? values.nlmStrength, "nlm-strength"),
    seed: parseNumeric(values.seed, "seed", { integer: true }),
  });
  return {
    settings,
    format,
    residual: Boolean(values.residual),
    overwrite: Boolean(values.overwrite),
  };
}

async function prepareOutputDir(outputDir, { overwrite = false } = {}) {
  const resolved = resolve(outputDir);
  let exists = false;
  try {
    const info = await stat(resolved);
    if (!info.isDirectory()) throw new Error(`Output path '${outputDir}' exists and is not a directory.`);
    exists = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (exists) {
    const entries = await readdir(resolved);
    if (entries.length > 0 && !overwrite) {
      throw new Error(`Output directory '${outputDir}' is not empty. Choose a new directory or pass --overwrite.`);
    }
  } else {
    await mkdir(resolved, { recursive: true });
  }
  return resolved;
}

/**
 * Denoises one TIFF/OME-TIFF/NIfTI file on disk and writes calibrated outputs + provenance JSON
 * into `outputDir`.
 */
export async function denoiseFile({ input, outputDir, options = {}, onProgress }) {
  if (!input) throw new Error("Input file path is required.");
  if (!outputDir) throw new Error("Output directory path is required.");

  const { settings, format, residual: writeResidual, overwrite } = parseCliOptions(options);
  const resolvedInput = resolve(input);
  const rawBytes = await readFile(resolvedInput);
  const inputName = basename(resolvedInput);
  const file = new File([rawBytes], inputName);

  const volume = await readVolume(file, { maxBytes: MAX_CLI_INPUT_BYTES });
  const resolvedOutput = await prepareOutputDir(outputDir, { overwrite });

  const started = performance.now();
  const result = denoiseVolume(volume.data, volume.dims, settings, (fraction, stage) => {
    onProgress?.(fraction, stage);
  });
  const seconds = Number(((performance.now() - started) / 1000).toFixed(2));

  const names = outputNames(inputName);
  const exportOpts = { axisKind: volume.axisKind, frameInterval: volume.frameInterval };
  const targetFormat = format === "auto" ? volume.format : format;
  const writeTiff = targetFormat === "tiff" || targetFormat === "both";
  const writeNifti = targetFormat === "nifti" || targetFormat === "both";
  const written = [];

  if (writeTiff) {
    const tiffPath = join(resolvedOutput, names.tiff);
    await writeFile(tiffPath, new Uint8Array(stackTiff(result.denoised, volume.dims, volume.spacingUm, exportOpts)));
    written.push(tiffPath);
    if (writeResidual) {
      const resTiffPath = join(resolvedOutput, names.residualTiff);
      await writeFile(resTiffPath, new Uint8Array(stackTiff(result.residual, volume.dims, volume.spacingUm, exportOpts)));
      written.push(resTiffPath);
    }
  }

  if (writeNifti) {
    const niftiPath = join(resolvedOutput, names.nifti);
    const niftiBuf = exportNiftiBuffer(result.denoised, volume);
    await writeFile(niftiPath, gzipSync(new Uint8Array(niftiBuf)));
    written.push(niftiPath);
    if (writeResidual) {
      const resNiftiPath = join(resolvedOutput, names.residualNifti);
      const resBuf = exportNiftiBuffer(result.residual, volume);
      await writeFile(resNiftiPath, gzipSync(new Uint8Array(resBuf)));
      written.push(resNiftiPath);
    }
  }

  const record = provenance({
    input: inputName,
    dims: volume.dims,
    axisKind: volume.axisKind,
    settings: result.settings,
    details: result.details,
    diagnostics: result.diagnostics,
    seconds,
  });
  const provenancePath = join(resolvedOutput, names.provenance);
  await writeFile(provenancePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  written.push(provenancePath);

  return {
    outputDir: resolvedOutput,
    outputs: written,
    primaryOutput: written[0],
    provenance: record,
    diagnostics: result.diagnostics,
    details: result.details,
    seconds,
  };
}

/**
 * Self-check verifying the installed runtime and core denoising methods offline on a tiny
 * synthetic image (used by `denoise self-check` and the portable release verifier).
 */
export async function checkInstallation() {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const h = 24;
  const w = 24;
  const rng = createRng(1337);
  const randn = createNormalRng(rng);
  const noisy = new Float32Array(h * w);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const clean = 50 + 30 * Math.sin(x / 4) * Math.cos(y / 4);
      noisy[y * w + x] = clean + randn() * 6;
    }
  }
  const fgr = denoiseVolume(noisy, [1, h, w], { method: "fgr-ridge", maxScale: 4, seed: 7 });
  const nlm = denoiseVolume(noisy, [1, h, w], { method: "vst-nlm", noiseModel: "gaussian" });
  const zs = denoiseVolume(noisy, [1, h, w], { method: "zs-n2n", iterations: 50, channels: 16, seed: 7 });
  if (!(fgr.diagnostics.noiseFloorDropDb > 0 && nlm.diagnostics.noiseFloorDropDb > 0 && zs.diagnostics.noiseFloorDropDb > 0)) {
    throw new Error("Self-check failed: denoiser did not reduce synthetic noise floor.");
  }
  return {
    ok: true,
    package: pkg.name,
    version: pkg.version,
    executable: process.execPath,
    node: process.version,
    methods: Object.keys(METHODS),
  };
}
