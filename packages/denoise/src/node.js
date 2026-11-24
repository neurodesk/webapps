// Node command-line interface for @neurodesk/denoise.
// Runs the exact same self-supervised denoising core and calibrated TIFF/NIfTI encoders
// as the Denoise web application.
import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { InputTooLargeError } from "@neurodesk/webapp-components/file-io/input-limits";
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
const CLI_METADATA_BYTES = 2 ** 25;

const LOCK_FILE = ".denoise-run.lock";

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

/**
 * Opens an input file and reads at most `maxFileBytes` without allocating unbounded memory.
 * Returns a zero-copy File-like object compatible with `readVolume` and `assertNiftiDecodedSize`.
 */
async function readBoundedInputFile(resolvedInput, inputName, maxFileBytes) {
  const fh = await open(resolvedInput, "r");
  try {
    const info = await fh.stat();
    if (!info.isFile()) throw new Error(`${inputName} is not a regular file.`);
    if (info.size === 0) throw new Error(`${inputName} is empty.`);
    if (info.size > maxFileBytes) {
      throw new InputTooLargeError(info.size, maxFileBytes, { subject: inputName });
    }

    const chunks = [];
    let total = 0;
    const chunkSize = Math.min(info.size + 1, 4 * 1024 * 1024);
    while (true) {
      const buf = Buffer.allocUnsafe(chunkSize);
      const { bytesRead } = await fh.read(buf, 0, chunkSize, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxFileBytes) {
        throw new InputTooLargeError(total, maxFileBytes, { subject: inputName });
      }
      chunks.push(bytesRead === buf.length ? buf : buf.subarray(0, bytesRead));
    }

    const combined = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, total);
    const bytes = new Uint8Array(combined.buffer, combined.byteOffset, combined.byteLength);
    const makeSlice = (start = 0, end = bytes.byteLength) => {
      const len = bytes.byteLength;
      const s = start < 0 ? Math.max(len + start, 0) : Math.min(start, len);
      const e = end < 0 ? Math.max(len + end, 0) : Math.min(end, len);
      const view = bytes.subarray(s, Math.max(s, e));
      return {
        size: view.byteLength,
        arrayBuffer: async () => view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength),
        stream: () => new Blob([view]).stream(),
      };
    };

    return {
      name: inputName,
      size: bytes.byteLength,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      slice: makeSlice,
      stream: () => new Blob([bytes]).stream(),
    };
  } finally {
    await fh.close();
  }
}

/**
 * Exclusively reserves `outputDir` before processing by atomically creating `.denoise-run.lock`
 * with `O_CREAT | O_EXCL` (`wx`), preventing concurrent CLI runs from colliding or interleaving
 * outputs. Returns a handle with `release({ removeIfEmpty })`.
 */
async function reserveOutputDir(outputDir, { overwrite = false } = {}) {
  const resolved = resolve(outputDir);
  let createdDir = false;
  try {
    const info = await stat(resolved);
    if (!info.isDirectory()) throw new Error(`Output path '${outputDir}' exists and is not a directory.`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await mkdir(resolved, { recursive: true });
    createdDir = true;
  }

  const lockPath = join(resolved, LOCK_FILE);
  let lockHandle;
  try {
    lockHandle = await open(lockPath, "wx");
    await lockHandle.writeFile(`${process.pid}\n`, "utf8");
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error(`Output directory '${outputDir}' is locked by another running denoise process (or contains ${LOCK_FILE}).`);
    }
    throw error;
  } finally {
    await lockHandle?.close();
  }

  const release = async ({ removeIfEmpty = false } = {}) => {
    await unlink(lockPath).catch(() => {});
    if (removeIfEmpty && createdDir) {
      await rmdir(resolved).catch(() => {});
    }
  };

  try {
    if (!overwrite) {
      const entries = (await readdir(resolved)).filter((name) => name !== LOCK_FILE);
      if (entries.length > 0) {
        throw new Error(`Output directory '${outputDir}' is not empty. Choose a new directory or pass --overwrite.`);
      }
    }
  } catch (error) {
    await release({ removeIfEmpty: true });
    throw error;
  }

  return { dir: resolved, createdDir, release };
}

/**
 * Validates all target destination paths before publishing staged outputs so a colliding
 * directory or blocked path fails cleanly without leaving partial outputs behind.
 */
async function assertPublishableTargets(dir, filenames, { overwrite }) {
  for (const name of filenames) {
    const target = join(dir, name);
    try {
      const info = await lstat(target);
      if (info.isDirectory()) {
        throw new Error(`Cannot write '${name}' because '${target}' is a directory.`);
      }
      if (!overwrite) {
        throw new Error(`Output file '${target}' already exists. Choose a new directory or pass --overwrite.`);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

/**
 * Denoises one TIFF/OME-TIFF/NIfTI file on disk and writes calibrated outputs + provenance JSON
 * atomically into `outputDir`.
 */
export async function denoiseFile({
  input,
  outputDir,
  options = {},
  onProgress,
  maxBytes = MAX_CLI_INPUT_BYTES,
  maxFileBytes = maxBytes + CLI_METADATA_BYTES,
}) {
  if (!input) throw new Error("Input file path is required.");
  if (!outputDir) throw new Error("Output directory path is required.");

  const { settings, format, residual: writeResidual, overwrite } = parseCliOptions(options);
  const resolvedInput = resolve(input);
  const inputName = basename(resolvedInput);
  const file = await readBoundedInputFile(resolvedInput, inputName, maxFileBytes);
  const volume = await readVolume(file, { maxBytes, maxFileBytes });

  const reservation = await reserveOutputDir(outputDir, { overwrite });
  const stageDir = join(reservation.dir, `.denoise-stage-${process.pid}-${randomBytes(4).toString("hex")}`);
  let published = false;

  try {
    const names = outputNames(inputName);
    const targetFormat = format === "auto" ? volume.format : format;
    const writeTiff = targetFormat === "tiff" || targetFormat === "both";
    const writeNifti = targetFormat === "nifti" || targetFormat === "both";

    const plannedNames = [];
    if (writeTiff) {
      plannedNames.push(names.tiff);
      if (writeResidual) plannedNames.push(names.residualTiff);
    }
    if (writeNifti) {
      plannedNames.push(names.nifti);
      if (writeResidual) plannedNames.push(names.residualNifti);
    }
    plannedNames.push(names.provenance);

    // Reject unwritable targets (e.g. a directory at the provenance path) before heavy compute.
    await assertPublishableTargets(reservation.dir, plannedNames, { overwrite });

    const started = performance.now();
    const result = denoiseVolume(volume.data, volume.dims, settings, (fraction, stage) => {
      onProgress?.(fraction, stage);
    });
    const seconds = Number(((performance.now() - started) / 1000).toFixed(2));

    const exportOpts = { axisKind: volume.axisKind, frameInterval: volume.frameInterval };
    const record = provenance({
      input: inputName,
      dims: volume.dims,
      axisKind: volume.axisKind,
      settings: result.settings,
      details: result.details,
      diagnostics: result.diagnostics,
      seconds,
    });

    const stagedFiles = [];
    await mkdir(stageDir, { recursive: false });
    if (writeTiff) {
      const data = new Uint8Array(stackTiff(result.denoised, volume.dims, volume.spacingUm, exportOpts));
      await writeFile(join(stageDir, names.tiff), data);
      stagedFiles.push(names.tiff);
      if (writeResidual) {
        const resData = new Uint8Array(stackTiff(result.residual, volume.dims, volume.spacingUm, exportOpts));
        await writeFile(join(stageDir, names.residualTiff), resData);
        stagedFiles.push(names.residualTiff);
      }
    }
    if (writeNifti) {
      const niftiBuf = exportNiftiBuffer(result.denoised, volume);
      await writeFile(join(stageDir, names.nifti), gzipSync(new Uint8Array(niftiBuf)));
      stagedFiles.push(names.nifti);
      if (writeResidual) {
        const resBuf = exportNiftiBuffer(result.residual, volume);
        await writeFile(join(stageDir, names.residualNifti), gzipSync(new Uint8Array(resBuf)));
        stagedFiles.push(names.residualNifti);
      }
    }
    await writeFile(join(stageDir, names.provenance), `${JSON.stringify(record, null, 2)}\n`, "utf8");
    stagedFiles.push(names.provenance);

    // Re-check targets right before commit, then move all staged files into place together.
    await assertPublishableTargets(reservation.dir, stagedFiles, { overwrite });
    const written = [];
    for (const name of stagedFiles) {
      const finalPath = join(reservation.dir, name);
      await rename(join(stageDir, name), finalPath);
      written.push(finalPath);
    }
    published = true;

    return {
      outputDir: reservation.dir,
      outputs: written,
      primaryOutput: written[0],
      provenance: record,
      diagnostics: result.diagnostics,
      details: result.details,
      seconds,
    };
  } finally {
    await rm(stageDir, { recursive: true, force: true }).catch(() => {});
    await reservation.release({ removeIfEmpty: !published });
  }
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
