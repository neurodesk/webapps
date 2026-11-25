// Node loader and command-line interface for @neurodesk/deconvolution.
// Runs the exact same WebAssembly Gibson-Lanni PSF and Richardson-Lucy / RL-TV solver
// and calibrated TIFF/NIfTI encoders as the Deconvolution web application.
import { randomBytes } from "node:crypto";
import { constants as fsConstants, readFileSync } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { createFloat32Nifti } from "@neurodesk/webapp-components/file-io";
import { InputTooLargeError } from "@neurodesk/webapp-components/file-io/input-limits";
import packageJson from "../package.json" with { type: "json" };
import { Deconvolver, gibsonLanniPsf, initSync, paddedDims } from "../wasm/deconvolution_wasm.js";
import {
  DEFAULT_OPTICS,
  checkPsfSpacing,
  outputNames,
  provenance,
  setNiftiSpacing,
  spacingComplete,
  stackNifti,
  stackTiff,
} from "./format.js";
import {
  MAX_ITERATIONS,
  MAX_PSF_SIDE,
  MAX_TV_WEIGHT,
  METHODS,
  autoPsfSize,
  checkSampling,
  memoryPlan,
  normaliseSum,
  opticsSettings,
  prepareImage,
  prepareMeasuredPsf,
  runSettings,
} from "./index.js";
import { MAX_INPUT_BYTES, readVolume } from "./input.js";

let loaded = null;

export function loadDeconvolution() {
  if (!loaded) {
    initSync({ module: readFileSync(new URL("../wasm/deconvolution_wasm_bg.wasm", import.meta.url)) });
    loaded = Object.freeze({ gibsonLanniPsf, paddedDims, Deconvolver });
  }
  return loaded;
}

export const MAX_CLI_INPUT_BYTES = MAX_INPUT_BYTES;
const CLI_METADATA_BYTES = 2 ** 26;
const LOCK_NAME = ".deconvolution-run.lock";

export const OPTIONS = Object.freeze({
  modality: {
    type: "string",
    enum: ["widefield", "confocal"],
    default: DEFAULT_OPTICS.modality,
    description: "Microscope modality for theoretical Gibson-Lanni PSF.",
  },
  method: {
    type: "string",
    enum: Object.keys(METHODS),
    default: "rl",
    description: "Deconvolution method: rl (Richardson-Lucy) or rltv (total variation).",
  },
  iterations: {
    type: "integer",
    minimum: 1,
    maximum: MAX_ITERATIONS,
    default: 20,
    description: "Richardson-Lucy iteration count.",
  },
  tvWeight: {
    type: "number",
    flag: "tv-weight",
    minimum: 0.0001,
    maximum: MAX_TV_WEIGHT,
    default: 0.002,
    description: "Total-variation weight lambda (rltv only).",
  },
  na: {
    type: "number",
    minimum: 0.05,
    maximum: 1.7,
    default: DEFAULT_OPTICS.na,
    description: "Objective numerical aperture (below immersion index).",
  },
  immersionIndex: {
    type: "number",
    flag: "immersion-index",
    minimum: 1,
    maximum: 2,
    default: DEFAULT_OPTICS.immersionIndex,
    description: "Immersion medium refractive index.",
  },
  sampleIndex: {
    type: "number",
    flag: "sample-index",
    minimum: 1,
    maximum: 2,
    default: DEFAULT_OPTICS.sampleIndex,
    description: "Sample refractive index (matters when depth > 0).",
  },
  emissionNm: {
    type: "number",
    flag: "emission-nm",
    minimum: 300,
    maximum: 1500,
    default: DEFAULT_OPTICS.emissionNm,
    description: "Emission wavelength in nanometres.",
  },
  excitationNm: {
    type: "number",
    flag: "excitation-nm",
    minimum: 300,
    maximum: 1500,
    default: DEFAULT_OPTICS.excitationNm,
    description: "Excitation wavelength in nanometres (confocal only).",
  },
  depthUm: {
    type: "number",
    flag: "depth-um",
    minimum: 0,
    maximum: 200,
    default: DEFAULT_OPTICS.depthUm,
    description: "Imaged depth below coverslip in micrometres.",
  },
  voxelXy: {
    type: "number",
    flag: "voxel-xy",
    minimum: 0.001,
    maximum: 100,
    description: "Lateral voxel size in micrometres (overrides file metadata).",
  },
  voxelZ: {
    type: "number",
    flag: "voxel-z",
    minimum: 0.001,
    maximum: 100,
    description: "Axial voxel size in micrometres (overrides file metadata).",
  },
  psfXy: {
    type: "integer",
    flag: "psf-xy",
    minimum: 1,
    maximum: MAX_PSF_SIDE,
    description: "Odd lateral PSF size in voxels (overrides automatic sizing).",
  },
  psfZ: {
    type: "integer",
    flag: "psf-z",
    minimum: 1,
    maximum: MAX_PSF_SIDE,
    description: "Odd axial PSF size in voxels (overrides automatic sizing).",
  },
  psf: {
    type: "string",
    description: "Path to a measured PSF stack (TIFF or NIfTI); replaces theoretical PSF.",
  },
  overwrite: {
    type: "boolean",
    default: false,
    description: "Allow writing into a non-empty output directory.",
  },
  offline: {
    type: "boolean",
    default: false,
    description: "Offline mode (deconvolution never uses the network).",
  },
});

export function optionName(key) {
  return OPTIONS[key]?.flag ?? key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

export function assertNonEmptyString(raw, flag) {
  if (raw === undefined) return undefined;
  const trimmed = String(raw).trim();
  if (!trimmed) throw new Error(`--${flag} requires a non-empty value.`);
  return trimmed;
}

export function rejectDisallowedFlags(values, allowed, command) {
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && !allowed.has(key)) {
      throw new Error(`--${key} is not allowed with ${command}.`);
    }
  }
}

function parseNumeric(raw, flag, { integer = false, min = -Infinity, max = Infinity } = {}) {
  if (raw === undefined) return undefined;
  const trimmed = assertNonEmptyString(raw, flag);
  const value = Number(trimmed);
  if (!Number.isFinite(value)) throw new Error(`--${flag} must be a finite number, got '${raw}'.`);
  if (integer && !Number.isInteger(value)) throw new Error(`--${flag} must be an integer, got '${raw}'.`);
  if (value < min || value > max) throw new Error(`--${flag} must be between ${min} and ${max}.`);
  return value;
}

export function parseCliOptions(values = {}) {
  const method = assertNonEmptyString(values.method, "method") ?? "rl";
  if (!Object.hasOwn(METHODS, method)) {
    throw new Error(`--method must be one of: ${Object.keys(METHODS).join(", ")}.`);
  }
  const modality = assertNonEmptyString(values.modality, "modality") ?? DEFAULT_OPTICS.modality;
  if (modality !== "widefield" && modality !== "confocal") {
    throw new Error("--modality must be one of: widefield, confocal.");
  }

  const iterations = parseNumeric(values.iterations, "iterations", { integer: true, min: 1, max: MAX_ITERATIONS }) ?? 20;
  const tvWeightRaw = parseNumeric(values["tv-weight"] ?? values.tvWeight, "tv-weight", { min: 0.0001, max: MAX_TV_WEIGHT });
  const settings = runSettings({ method, iterations, tvWeight: tvWeightRaw ?? 0.002 });

  const psfPath = assertNonEmptyString(values.psf, "psf");
  const na = parseNumeric(values.na, "na", { min: 0.05, max: 1.7 }) ?? DEFAULT_OPTICS.na;
  const immersionIndex = parseNumeric(values["immersion-index"] ?? values.immersionIndex, "immersion-index", { min: 1, max: 2 }) ?? DEFAULT_OPTICS.immersionIndex;
  const sampleIndex = parseNumeric(values["sample-index"] ?? values.sampleIndex, "sample-index", { min: 1, max: 2 }) ?? DEFAULT_OPTICS.sampleIndex;
  const emissionNm = parseNumeric(values["emission-nm"] ?? values.emissionNm, "emission-nm", { min: 300, max: 1500 }) ?? DEFAULT_OPTICS.emissionNm;
  const excitationNm = parseNumeric(values["excitation-nm"] ?? values.excitationNm, "excitation-nm", { min: 300, max: 1500 }) ?? DEFAULT_OPTICS.excitationNm;
  const depthUm = parseNumeric(values["depth-um"] ?? values.depthUm, "depth-um", { min: 0, max: 200 }) ?? DEFAULT_OPTICS.depthUm;

  const optics = psfPath
    ? null
    : opticsSettings({ modality, na, immersionIndex, sampleIndex, emissionNm, excitationNm, depthUm });

  const voxelXy = parseNumeric(values["voxel-xy"] ?? values.voxelXy, "voxel-xy", { min: 0.001, max: 100 });
  const voxelZ = parseNumeric(values["voxel-z"] ?? values.voxelZ, "voxel-z", { min: 0.001, max: 100 });
  const psfXy = parseNumeric(values["psf-xy"] ?? values.psfXy, "psf-xy", { integer: true, min: 1, max: MAX_PSF_SIDE });
  const psfZ = parseNumeric(values["psf-z"] ?? values.psfZ, "psf-z", { integer: true, min: 1, max: MAX_PSF_SIDE });
  if (psfXy !== undefined && psfXy % 2 === 0) throw new Error(`--psf-xy must be an odd integer from 1 to ${MAX_PSF_SIDE}.`);
  if (psfZ !== undefined && psfZ % 2 === 0) throw new Error(`--psf-z must be an odd integer from 1 to ${MAX_PSF_SIDE}.`);

  return {
    settings,
    optics,
    psfPath: psfPath ?? null,
    voxelXy,
    voxelZ,
    psfXy,
    psfZ,
    overwrite: Boolean(values.overwrite),
    offline: Boolean(values.offline),
  };
}

/** Bounded native gunzip with CRC32/ISIZE validation and strict maxOutputLength enforcement. */
export function gunzipBounded(bytes, maxOutputLength = MAX_CLI_INPUT_BYTES + CLI_METADATA_BYTES, subject = "Compressed file") {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  try {
    const out = gunzipSync(view, { maxOutputLength });
    return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
  } catch (error) {
    if (error?.code === "ERR_BUFFER_TOO_LARGE") {
      throw new InputTooLargeError(maxOutputLength + 1, maxOutputLength, { subject });
    }
    throw new Error(`${subject}: invalid gzip stream (${error.message}).`, { cause: error });
  }
}

async function readBoundedInputFile(filePath, maxFileBytes) {
  const resolved = resolve(filePath);
  const name = basename(resolved);
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0);
  const fh = await open(resolved, flags);
  try {
    const info = await fh.stat();
    if (!info.isFile()) throw new Error(`${name} is not a regular file.`);
    if (info.size === 0) throw new Error(`${name} is empty.`);
    if (info.size > maxFileBytes) {
      throw new InputTooLargeError(info.size, maxFileBytes, { subject: name });
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
        throw new InputTooLargeError(total, maxFileBytes, { subject: name });
      }
      chunks.push(bytesRead === buf.length ? buf : buf.subarray(0, bytesRead));
    }
    const combined = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, total);
    const bytes = new Uint8Array(combined.buffer, combined.byteOffset, combined.byteLength);
    return new File([bytes], name);
  } finally {
    await fh.close();
  }
}

async function mkdirTracking(targetDir) {
  const created = [];
  let cursor = resolve(targetDir);
  const toCreate = [];
  while (true) {
    try {
      const info = await stat(cursor);
      if (!info.isDirectory()) throw new Error(`Output path '${targetDir}' exists and is not a directory.`);
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = dirname(cursor);
      if (parent === cursor) break;
      toCreate.push(cursor);
      cursor = parent;
    }
  }
  for (let i = toCreate.length - 1; i >= 0; i -= 1) {
    try {
      await mkdir(toCreate[i]);
      created.push(toCreate[i]);
    } catch (error) {
      if (error.code === "EEXIST") {
        const info = await stat(toCreate[i]);
        if (!info.isDirectory()) throw new Error(`Output path '${targetDir}' exists and is not a directory.`);
      } else {
        for (let j = created.length - 1; j >= 0; j -= 1) await rmdir(created[j]).catch(() => {});
        throw error;
      }
    }
  }
  return created;
}

export async function claimOutputDir(outputDir, { overwrite = false, readdirFn = readdir } = {}) {
  if (!outputDir || !String(outputDir).trim()) throw new Error("Output directory path is required.");
  const dir = resolve(outputDir);
  const createdDirs = await mkdirTracking(dir);
  const cleanupCreated = async () => {
    for (let i = createdDirs.length - 1; i >= 0; i -= 1) {
      await rmdir(createdDirs[i]).catch(() => {});
    }
  };
  const lockPath = join(dir, LOCK_NAME);
  let lockHandle;
  try {
    lockHandle = await open(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  } catch (error) {
    await cleanupCreated();
    if (error.code === "EEXIST") {
      throw new Error(`Output directory '${outputDir}' is locked by another running deconvolution process (or contains ${LOCK_NAME}).`);
    }
    throw error;
  }
  let lockHeld = true;
  const release = async ({ removeCreated = false } = {}) => {
    if (lockHeld) {
      lockHeld = false;
      await unlink(lockPath).catch(() => {});
    }
    if (removeCreated) await cleanupCreated();
  };
  try {
    await lockHandle.writeFile(`${JSON.stringify({ pid: process.pid, host: hostname(), startedAt: Date.now() })}\n`, "utf8");
    await lockHandle.close();
    lockHandle = null;
    if (!overwrite) {
      const entries = (await readdirFn(dir)).filter((name) => name !== LOCK_NAME);
      if (entries.length > 0) {
        throw new Error(`Output directory '${outputDir}' is not empty. Choose a new directory or pass --overwrite.`);
      }
    }
  } catch (error) {
    if (lockHandle) await lockHandle.close().catch(() => {});
    await release({ removeCreated: true });
    throw error;
  }
  return { dir, createdDirs, release };
}

export async function commitOutputs(dir, files, { overwrite = false, renameFn = rename } = {}) {
  const token = randomBytes(6).toString("hex");
  for (const file of files) {
    const target = join(dir, file.name);
    try {
      const info = await lstat(target);
      if (info.isDirectory()) throw new Error(`Cannot write '${file.name}' because '${target}' is a directory.`);
      if (!overwrite) throw new Error(`Output file '${target}' already exists. Choose a new directory or pass --overwrite.`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  const staged = [];
  try {
    for (const file of files) {
      const partialPath = join(dir, `.${file.name}.${token}.partial`);
      await writeFile(partialPath, file.data, { flag: "wx" });
      staged.push({ name: file.name, partialPath, finalPath: join(dir, file.name) });
    }
  } catch (error) {
    for (const entry of staged) await rm(entry.partialPath, { force: true }).catch(() => {});
    throw error;
  }

  const backedUp = [];
  const committed = [];
  try {
    if (overwrite) {
      for (const entry of staged) {
        let exists = false;
        try {
          await lstat(entry.finalPath);
          exists = true;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        if (exists) {
          const backupPath = join(dir, `.${entry.name}.${token}.backup`);
          await renameFn(entry.finalPath, backupPath);
          backedUp.push({ finalPath: entry.finalPath, backupPath });
        }
      }
    }
    for (const entry of staged) {
      await renameFn(entry.partialPath, entry.finalPath);
      committed.push(entry);
    }
  } catch (error) {
    for (let i = committed.length - 1; i >= 0; i -= 1) {
      await unlink(committed[i].finalPath).catch(() => {});
    }
    for (let i = backedUp.length - 1; i >= 0; i -= 1) {
      await rename(backedUp[i].backupPath, backedUp[i].finalPath).catch(() => {});
    }
    for (const entry of staged) await rm(entry.partialPath, { force: true }).catch(() => {});
    throw error;
  }

  for (const backup of backedUp) await rm(backup.backupPath, { force: true }).catch(() => {});
  return committed.map((entry) => entry.finalPath);
}

/**
 * Deconvolves one TIFF/OME-TIFF/NIfTI stack on disk and writes calibrated TIFF, gzipped NIfTI,
 * PSF TIFF, and provenance JSON atomically into `outputDir`.
 */
export async function deconvolveFile({
  input,
  outputDir,
  options = {},
  onProgress,
  maxBytes = MAX_CLI_INPUT_BYTES,
  maxFileBytes = maxBytes + CLI_METADATA_BYTES,
  renameFn = rename,
  readdirFn = readdir,
} = {}) {
  const parsed = parseCliOptions(options);
  if (!input || !String(input).trim()) throw new Error("Input file path is required.");
  if (!outputDir || !String(outputDir).trim()) throw new Error("Output directory path is required.");

  const inputFile = await readBoundedInputFile(input, maxFileBytes);
  const volume = await readVolume(inputFile, { maxBytes, maxFileBytes, gunzip: gunzipBounded });
  const spacingUm = {
    x: parsed.voxelXy ?? volume.spacingUm.x,
    y: parsed.voxelXy ?? volume.spacingUm.y,
    z: parsed.voxelZ ?? volume.spacingUm.z,
  };
  if (!spacingComplete(spacingUm)) {
    throw new Error("Voxel size is incomplete; pass --voxel-xy and --voxel-z in micrometres.");
  }

  let measuredVolume = null;
  if (parsed.psfPath) {
    const psfFile = await readBoundedInputFile(parsed.psfPath, maxFileBytes);
    measuredVolume = await readVolume(psfFile, { maxBytes, maxFileBytes, gunzip: gunzipBounded });
  }

  const reservation = await claimOutputDir(outputDir, { overwrite: parsed.overwrite, readdirFn });
  let committed = false;
  try {
    const wasm = loadDeconvolution();
    const started = performance.now();
    onProgress?.(0.02, "Computing PSF…");

    let psf;
    if (measuredVolume) {
      checkPsfSpacing(measuredVolume.spacingUm, spacingUm, measuredVolume.name);
      const prepared = prepareMeasuredPsf(measuredVolume.data, measuredVolume.dims);
      const peak = prepared.data.reduce((max, v) => Math.max(max, v), 0);
      psf = {
        data: prepared.data.map((v) => v / peak),
        dims: prepared.dims,
        source: "measured",
        file: measuredVolume.name,
        background: prepared.background,
      };
    } else {
      checkSampling({ ...parsed.optics, spacingUm, dims: volume.dims });
      const auto = autoPsfSize({ ...parsed.optics, spacingUm, dims: volume.dims });
      const size = {
        xy: parsed.psfXy ?? auto.xy,
        z: volume.dims[0] === 1 ? 1 : (parsed.psfZ ?? auto.z),
      };
      const rawPsf = wasm.gibsonLanniPsf(
        parsed.optics.na,
        parsed.optics.ni,
        parsed.optics.ns,
        parsed.optics.emissionUm,
        parsed.optics.excitationUm,
        spacingUm.x,
        spacingUm.z,
        size.xy,
        size.z,
        parsed.optics.depthUm,
      );
      psf = { data: rawPsf, dims: [size.z, size.xy, size.xy], source: "theoretical" };
    }

    const plan = memoryPlan(volume.dims, psf.dims, { tv: parsed.settings.tvWeight > 0 });
    if (!plan.fits) {
      throw new Error(`This stack and PSF need about ${Math.round(plan.bytes / 2 ** 20)} MB; crop the stack or shrink the PSF.`);
    }

    const { data: image } = prepareImage(volume.data);
    const solver = new wasm.Deconvolver(
      image,
      Uint32Array.from(volume.dims),
      normaliseSum(psf.data),
      Uint32Array.from(psf.dims),
      parsed.settings.tvWeight,
    );
    let estimate;
    try {
      for (let i = 1; i <= parsed.settings.iterations; i += 1) {
        solver.iterate(1);
        onProgress?.(0.05 + (0.9 * i) / parsed.settings.iterations, `${METHODS[parsed.settings.method].label}: iteration ${i} of ${parsed.settings.iterations}`);
      }
      estimate = Float32Array.from(solver.estimate());
      for (let i = 0; i < estimate.length; i += 1) {
        if (!Number.isFinite(estimate[i])) {
          throw new Error(`Deconvolved output contains a non-finite float32 value at voxel ${i}.`);
        }
      }
    } finally {
      solver.free();
    }

    const seconds = Number(((performance.now() - started) / 1000).toFixed(2));
    const names = outputNames(volume.name);
    const provenanceName = names.tiff.replace(/_deconvolved\.tif$/, "_provenance.json");
    const tiffBytes = new Uint8Array(stackTiff(estimate, volume.dims, spacingUm));
    const niftiRaw = volume.format === "nifti"
      ? setNiftiSpacing(createFloat32Nifti(estimate, volume.niftiHeader), spacingUm)
      : stackNifti(estimate, volume.dims, spacingUm);
    const niftiGz = gzipSync(new Uint8Array(niftiRaw));
    const psfTiffBytes = new Uint8Array(stackTiff(Float32Array.from(psf.data), psf.dims, spacingUm));
    const record = provenance({
      input: volume.name,
      dims: volume.dims,
      spacingUm,
      optics: parsed.optics,
      psf,
      settings: parsed.settings,
      seconds,
    });

    const written = await commitOutputs(
      reservation.dir,
      [
        { name: names.tiff, data: tiffBytes },
        { name: names.nifti, data: niftiGz },
        { name: names.psfTiff, data: psfTiffBytes },
        { name: provenanceName, data: Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8") },
      ],
      { overwrite: parsed.overwrite, renameFn },
    );
    committed = true;

    return {
      outputDir: reservation.dir,
      outputs: written,
      primaryOutput: written[0],
      provenance: record,
      dims: volume.dims,
      psfDims: psf.dims,
      seconds,
    };
  } finally {
    await reservation.release({ removeCreated: !committed });
  }
}

/** Offline self-check: verifies WASM module loading, Gibson-Lanni PSF and RL solver on a tiny 3D phantom. */
export async function checkInstallation({ cacheDir } = {}) {
  const resolvedCache = cacheDir ? resolve(cacheDir) : undefined;
  const wasm = loadDeconvolution();
  const psf = wasm.gibsonLanniPsf(1.4, 1.518, 1.47, 0.52, 0.0, 0.1, 0.2, 5, 5, 0.0);
  if (psf.length !== 125 || !(psf[62] > 0)) {
    throw new Error("Self-check failed: Gibson-Lanni PSF did not peak at center.");
  }
  const image = new Float64Array(8 * 8 * 8);
  image[(4 * 8 + 4) * 8 + 4] = 100;
  const solver = new wasm.Deconvolver(image, Uint32Array.from([8, 8, 8]), normaliseSum(psf), Uint32Array.from([5, 5, 5]), 0);
  let out;
  try {
    solver.iterate(1);
    out = Float32Array.from(solver.estimate());
  } finally {
    solver.free();
  }
  if (out.length !== 512 || !Number.isFinite(out[0])) {
    throw new Error("Self-check failed: Richardson-Lucy solver returned invalid output.");
  }
  return {
    ok: true,
    package: packageJson.name,
    version: packageJson.version,
    executable: process.execPath,
    node: process.version,
    methods: Object.keys(METHODS),
    ...(resolvedCache ? { cacheDir: resolvedCache } : {}),
  };
}
