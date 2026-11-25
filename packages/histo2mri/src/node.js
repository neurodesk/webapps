// Node command-line interface for @neurodesk/histo2mri.
// Registers 2D histology sections (TIFF, PNG, JPEG) to a 3D MRI volume (NIfTI) using the exact
// same Greedy NMI rigid, affine, plane search and deformable SVF pipeline as the Histo2MRI web app.
import { randomUUID } from "node:crypto";
import { rmdirSync, unlinkSync } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, rename, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { loadGreedySingleThread } from "@neurodesk/greedy/single";
import { registerAffineGreedy, registerRigidGreedy, registerSvfGreedy } from "@neurodesk/greedy";
import { readTiffImage } from "@neurodesk/webapp-components/file-io/tiff";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import packageJson from "../package.json" with { type: "json" };
import { SECTION_OUTPUT_KINDS, outputNames, runSettings, runSummary } from "./config.js";
import { mriVolume, rgbaNifti } from "./core/nifti.js";
import { planeSform, registrationImages, registrationReport, sectionsInVolume, warpedSection, worldTransforms } from "./core/outputs.js";
import { axisPlanes } from "./core/plane.js";
import { DEFAULTS, preflightSection, registerSection } from "./core/register.js";
import { readStrictNiftiVolume } from "./nifti-io.js";

export const OUTPUT_LOCK_FILE = ".neurodesk-cli.lock";
const MAX_MRI_FILE_BYTES = 512 * 1024 * 1024;
const MAX_SECTION_FILE_BYTES = 256 * 1024 * 1024;
const MAX_SECTION_DECODED_BYTES = 256 * 1024 * 1024;
const ITERATIONS_RE = /^\d+x\d+x\d+$/;
const AXIS_MAP = Object.freeze({ 0: 0, 1: 1, 2: 2, i: 0, j: 1, k: 2 });
const CONTRAST_SET = new Set(["auto", "haematoxylin", "eosin", "dab"]);
const ALLOWED_OPTION_KEYS = new Set([
  "axis",
  "slice",
  "step",
  "tilt-a",
  "tilt-b",
  "pixel-size",
  "contrast",
  "orientation",
  "no-refine-plane",
  "search-offset",
  "search-tilt",
  "no-deformable",
  "linear-iterations",
  "deformable-iterations",
  "offline",
]);

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC32_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function assertPlainOptions(values) {
  if (values === null || typeof values !== "object" || Array.isArray(values)) {
    throw new TypeError("Options must be a plain object.");
  }
  for (const key of Object.keys(values)) {
    if (!ALLOWED_OPTION_KEYS.has(key)) {
      throw new Error(`Unknown option '--${key}'.`);
    }
  }
}

function parseBooleanOpt(raw, flag) {
  if (raw === undefined) return false;
  if (typeof raw !== "boolean") {
    throw new Error(`Option --${flag} must be a boolean, got ${typeof raw}.`);
  }
  return raw;
}

function parseStringOpt(raw, flag) {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error(`Option --${flag} requires a non-empty string value.`);
  }
  return raw.trim();
}

function parseFiniteOpt(raw, flag, { min = -Infinity, max = Infinity, exclusiveMin = false } = {}) {
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" && typeof raw !== "string") {
    throw new Error(`Option --${flag} must be a finite number, got ${typeof raw}.`);
  }
  const trimmed = String(raw).trim();
  if (!trimmed) throw new Error(`Option --${flag} requires a non-empty value.`);
  const value = Number(trimmed);
  const low = exclusiveMin ? value <= min : value < min;
  if (!Number.isFinite(value) || low || value > max) {
    throw new Error(`Option --${flag} must be a finite number ${exclusiveMin ? ">" : ">="} ${min}${Number.isFinite(max) ? ` and <= ${max}` : ""}, got '${raw}'.`);
  }
  return value;
}

/** Validates CLI flags before touching input files or claiming OUTPUT_DIR. */
export function parseCliOptions(values = {}) {
  assertPlainOptions(values);

  let axisRaw = "2";
  if (values.axis !== undefined) {
    if (typeof values.axis !== "string" && typeof values.axis !== "number") {
      throw new Error(`Option --axis must be one of 0, 1, 2, i, j, k, got ${typeof values.axis}.`);
    }
    axisRaw = String(values.axis).trim().toLowerCase();
  }
  if (!Object.hasOwn(AXIS_MAP, axisRaw)) {
    throw new Error(`Option --axis must be one of 0, 1, 2, i, j, k, got '${values.axis}'.`);
  }
  const axis = AXIS_MAP[axisRaw];

  const sliceIndex = parseFiniteOpt(values.slice, "slice", { min: 0 });
  const step = parseFiniteOpt(values.step, "step", { min: -10000, max: 10000 }) ?? 1;
  const tiltA = parseFiniteOpt(values["tilt-a"], "tilt-a", { min: -30, max: 30 }) ?? 0;
  const tiltB = parseFiniteOpt(values["tilt-b"], "tilt-b", { min: -30, max: 30 }) ?? 0;
  const pixelSize = parseFiniteOpt(values["pixel-size"], "pixel-size", { min: 0, exclusiveMin: true });
  const searchOffset = parseFiniteOpt(values["search-offset"], "search-offset", { min: 0, max: 10 }) ?? DEFAULTS.searchOffset;
  const searchTilt = parseFiniteOpt(values["search-tilt"], "search-tilt", { min: 0, max: 10 }) ?? DEFAULTS.searchTilt;

  const contrast = parseStringOpt(values.contrast, "contrast") ?? DEFAULTS.contrast;
  if (!CONTRAST_SET.has(contrast)) {
    throw new Error(`Option --contrast must be one of auto, haematoxylin, eosin, dab, got '${contrast}'.`);
  }

  let orientation = DEFAULTS.orientation;
  if (values.orientation !== undefined) {
    if (typeof values.orientation !== "string" && typeof values.orientation !== "number") {
      throw new Error(`Option --orientation must be auto or 0..7, got ${typeof values.orientation}.`);
    }
    const rawOrientation = String(values.orientation).trim();
    if (rawOrientation !== "auto" && !/^[0-7]$/.test(rawOrientation)) {
      throw new Error(`Option --orientation must be auto or 0..7, got '${values.orientation}'.`);
    }
    orientation = rawOrientation;
  }

  const linearIterations = parseStringOpt(values["linear-iterations"], "linear-iterations") ?? DEFAULTS.linearIterations;
  if (!ITERATIONS_RE.test(linearIterations)) {
    throw new Error(`Option --linear-iterations must be three x-separated integers (e.g. 100x50x10), got '${linearIterations}'.`);
  }
  const deformableIterations = parseStringOpt(values["deformable-iterations"], "deformable-iterations") ?? DEFAULTS.deformableIterations;
  if (!ITERATIONS_RE.test(deformableIterations)) {
    throw new Error(`Option --deformable-iterations must be three x-separated integers (e.g. 0x0x200), got '${deformableIterations}'.`);
  }

  const noRefinePlane = parseBooleanOpt(values["no-refine-plane"], "no-refine-plane");
  const noDeformable = parseBooleanOpt(values["no-deformable"], "no-deformable");
  parseBooleanOpt(values.offline, "offline");

  return {
    axis,
    sliceIndex,
    step,
    tiltA,
    tiltB,
    pixelSize,
    contrast,
    orientation,
    refinePlane: !noRefinePlane,
    searchOffset,
    searchTilt,
    deformable: !noDeformable,
    linearIterations,
    deformableIterations,
  };
}

/**
 * Allocates case-insensitive, collision-free output filename sets for all input sections BEFORE
 * claiming OUTPUT_DIR or running Greedy registration.
 */
export function allocateUniqueOutputNames(sectionNames) {
  const usedLower = new Set(["sections_in_mri.nii.gz"]);
  const allocated = [];
  for (const rawName of sectionNames) {
    const baseStem = outputNames(rawName).registration.replace(/_registration\.json$/, "");
    let candidateStem = baseStem;
    let suffix = 2;
    for (;;) {
      const candidateNames = outputNames(`${candidateStem}.png`);
      const lowerList = Object.values(candidateNames).map((entry) => entry.toLowerCase());
      if (lowerList.every((lower) => !usedLower.has(lower))) {
        for (const lower of lowerList) usedLower.add(lower);
        allocated.push(candidateNames);
        break;
      }
      candidateStem = `${baseStem}_${suffix++}`;
    }
  }
  return allocated;
}

/**
 * Exclusively claims `outputDir` with the shared `.neurodesk-cli.lock` O_EXCL lock file,
 * rejecting directory symlinks, registering SIGINT/SIGTERM cleanup handlers while held, and
 * cleaning up the lock and any newly created directory on error or release.
 */
export async function claimOutputDirectory(outputDir) {
  if (typeof outputDir !== "string" || !outputDir.trim()) {
    throw new Error("Output directory must be a non-empty path.");
  }
  const directory = resolve(outputDir);
  let createdDir = false;
  try {
    const info = await lstat(directory);
    if (info.isSymbolicLink()) {
      throw new Error(`Output path '${directory}' must not be a symbolic link.`);
    }
    if (!info.isDirectory()) {
      throw new Error(`Output path '${directory}' exists and is not a directory.`);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await mkdir(directory, { recursive: true });
    createdDir = true;
    const createdInfo = await lstat(directory);
    if (createdInfo.isSymbolicLink() || !createdInfo.isDirectory()) {
      throw new Error(`Output path '${directory}' is not a regular directory.`);
    }
  }

  const lockPath = join(directory, OUTPUT_LOCK_FILE);
  let handle = null;
  let lockActive = false;
  let signalsRegistered = false;

  const cleanupSync = () => {
    if (!lockActive) return;
    lockActive = false;
    try {
      unlinkSync(lockPath);
    } catch {
      // ignore already-removed lock
    }
    if (createdDir) {
      try {
        rmdirSync(directory);
      } catch {
        // leave directory intact if non-empty
      }
    }
  };

  const unregisterSignals = () => {
    if (!signalsRegistered) return;
    signalsRegistered = false;
    process.off("SIGINT", onSigInt);
    process.off("SIGTERM", onSigTerm);
  };

  const handleSignal = (signal) => {
    unregisterSignals();
    cleanupSync();
    if (process.platform === "win32") {
      process.exit(signal === "SIGINT" ? 130 : 143);
    }
    process.kill(process.pid, signal);
  };
  const onSigInt = () => handleSignal("SIGINT");
  const onSigTerm = () => handleSignal("SIGTERM");

  try {
    handle = await open(lockPath, "wx");
    lockActive = true;
    process.on("SIGINT", onSigInt);
    process.on("SIGTERM", onSigTerm);
    signalsRegistered = true;

    await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`);
    await handle.close();
    handle = null;

    const entries = await readdir(directory);
    if (entries.length !== 1 || entries[0] !== OUTPUT_LOCK_FILE) {
      throw new Error(`Output directory ${directory} is not empty. Choose a new or empty directory.`);
    }
  } catch (error) {
    unregisterSignals();
    await handle?.close().catch(() => {});
    if (lockActive) {
      lockActive = false;
      await rm(lockPath, { force: true }).catch(() => {});
    }
    if (createdDir) {
      await rmdir(directory).catch(() => {});
    }
    if (error.code === "EEXIST") {
      throw new Error(`Output directory ${directory} is already in use by another run or not empty. Choose a new or empty directory.`);
    }
    throw error;
  }

  return {
    directory,
    createdDir,
    async release({ removeDirIfEmpty = false } = {}) {
      unregisterSignals();
      if (lockActive) {
        lockActive = false;
        await rm(lockPath, { force: true }).catch(() => {});
      }
      if (removeDirIfEmpty && createdDir) {
        await rmdir(directory).catch(() => {});
      }
    },
  };
}

/**
 * Stages every output file to a `.partial` path first (recording each `.partial` BEFORE calling
 * `writeFile` so failed/short writes are always cleaned up), then renames all files into place.
 * On error, rolls back ONLY files this run created (verified via lstat + dev/ino, never deleting
 * directories, symlinks, or unrelated replacements).
 */
export async function writeStagedOutputs(directory, files, { renameFn = rename, writeFileFn = writeFile } = {}) {
  const runId = randomUUID().slice(0, 8);
  const staged = [];
  const renamed = [];
  const seenNames = new Set();
  try {
    for (const { name, bytes } of files) {
      if (typeof name !== "string" || !name || name.includes("/") || name.includes("\\") || name === "." || name === "..") {
        throw new Error(`Invalid output filename '${name}'.`);
      }
      const lower = name.toLowerCase();
      if (seenNames.has(lower)) {
        throw new Error(`Duplicate output filename '${name}'.`);
      }
      seenNames.add(lower);

      const partialPath = join(directory, `.${name}.${runId}.partial`);
      const finalPath = join(directory, name);
      const item = { name, partialPath, finalPath };
      // Register BEFORE writeFile so partial/failed writes (e.g. EFBIG/ENOSPC) are cleaned up.
      staged.push(item);
      await writeFileFn(partialPath, bytes, { flag: "wx" });
    }
    for (const item of staged) {
      const existing = await lstat(item.finalPath).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (existing) {
        throw new Error(`Refusing to overwrite existing output '${item.name}'.`);
      }
      const stagedInfo = await lstat(item.partialPath);
      await renameFn(item.partialPath, item.finalPath);
      renamed.push({ finalPath: item.finalPath, dev: stagedInfo.dev, ino: stagedInfo.ino });
    }
    return staged.map((item) => item.name);
  } catch (error) {
    for (const item of staged) {
      const info = await lstat(item.partialPath).catch(() => null);
      if (info && info.isFile() && !info.isSymbolicLink()) {
        await unlink(item.partialPath).catch(() => {});
      }
    }
    for (const { finalPath, dev, ino } of renamed) {
      const info = await lstat(finalPath).catch(() => null);
      if (info && info.isFile() && !info.isSymbolicLink() && info.dev === dev && info.ino === ino) {
        await unlink(finalPath).catch(() => {});
      }
    }
    throw error;
  }
}

/** Verifies PNG signature, chunk layout, every chunk's IEEE CRC32, IHDR bounds, and IEND presence. */
function verifyPngStructure(bytes, name) {
  if (bytes.byteLength < 33 || !PNG_SIGNATURE.every((b, i) => bytes[i] === b)) {
    throw new Error(`${name} is not a valid PNG file.`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let sawIhdr = false;
  let sawIend = false;
  let width = 0;
  let height = 0;
  let bitDepth = 8;

  while (offset < bytes.byteLength) {
    if (offset + 12 > bytes.byteLength) {
      throw new Error(`${name}: truncated PNG chunk header.`);
    }
    const length = view.getUint32(offset, false);
    const chunkEnd = offset + 12 + length;
    if (chunkEnd > bytes.byteLength) {
      throw new Error(`${name}: truncated PNG chunk payload.`);
    }
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    const expectedCrc = view.getUint32(offset + 8 + length, false);
    const actualCrc = crc32(bytes.subarray(offset + 4, offset + 8 + length));
    if (actualCrc !== expectedCrc) {
      throw new Error(`${name}: PNG chunk '${type}' failed CRC32 verification.`);
    }
    if (offset === 8) {
      if (type !== "IHDR" || length !== 13) {
        throw new Error(`${name}: PNG does not begin with a valid IHDR chunk.`);
      }
      sawIhdr = true;
      width = view.getUint32(offset + 8, false);
      height = view.getUint32(offset + 12, false);
      bitDepth = bytes[offset + 16];
      if (!width || !height) {
        throw new Error(`${name}: PNG has zero width or height.`);
      }
      const estBytes = width * height * 4 * (bitDepth === 16 ? 2 : 1);
      if (estBytes > MAX_SECTION_DECODED_BYTES) {
        throw new Error(`${name} (${width} × ${height}) exceeds the 256 MiB section memory limit.`);
      }
    }
    offset = chunkEnd;
    if (type === "IEND") {
      sawIend = true;
      break;
    }
  }
  if (!sawIhdr || !sawIend) {
    throw new Error(`${name}: PNG is missing required IHDR or IEND chunk.`);
  }
  return { width, height, bitDepth };
}

/**
 * Decodes a PNG buffer in pure Node using pngjs@7.0.0 with strict chunk CRC32 verification
 * and Chromium webapp parity (zeros RGB on fully transparent alpha === 0 pixels, including tRNS).
 */
export function decodePngSection(bytes, name) {
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const { width: ihdrWidth, height: ihdrHeight } = verifyPngStructure(input, name);
  const decoded = PNG.sync.read(Buffer.from(input.buffer, input.byteOffset, input.byteLength), {
    checkCRC: true,
    skipRescale: false,
  });
  if (decoded.width !== ihdrWidth || decoded.height !== ihdrHeight) {
    throw new Error(`${name}: decoded PNG dimensions (${decoded.width} × ${decoded.height}) do not match IHDR (${ihdrWidth} × ${ihdrHeight}).`);
  }
  const pixels = decoded.width * decoded.height;
  const rgb = new Uint8Array(pixels * 3);
  for (let i = 0; i < pixels; i++) {
    const a = decoded.data[i * 4 + 3];
    if (a === 0) {
      rgb[i * 3] = 0;
      rgb[i * 3 + 1] = 0;
      rgb[i * 3 + 2] = 0;
    } else {
      rgb[i * 3] = decoded.data[i * 4];
      rgb[i * 3 + 1] = decoded.data[i * 4 + 1];
      rgb[i * 3 + 2] = decoded.data[i * 4 + 2];
    }
  }
  return {
    width: decoded.width,
    height: decoded.height,
    channels: 3,
    bitsPerSample: 8,
    maxValue: 255,
    data: rgb,
    pixelSize: null,
  };
}

/** Decodes a JPEG buffer in pure Node into interleaved RGB pixels. */
export function decodeJpegSection(bytes, name) {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error(`${name} is not a valid JPEG file.`);
  }
  const decoded = jpeg.decode(bytes, {
    useTArray: true,
    formatAsRGBA: false,
    maxMemoryUsageInMB: Math.floor(MAX_SECTION_DECODED_BYTES / (1024 * 1024)),
  });
  return {
    width: decoded.width,
    height: decoded.height,
    channels: 3,
    bitsPerSample: 8,
    maxValue: 255,
    data: decoded.data,
    pixelSize: null,
  };
}

async function readSectionFile(sectionPath) {
  const resolved = resolve(sectionPath);
  const info = await stat(resolved);
  if (!info.isFile()) throw new Error(`Section '${sectionPath}' is not a regular file.`);
  if (info.size === 0) throw new Error(`Section '${sectionPath}' is empty.`);
  if (info.size > MAX_SECTION_FILE_BYTES) {
    throw new Error(`Section '${sectionPath}' exceeds the 256 MiB file size limit.`);
  }
  const name = basename(resolved);
  const bytes = await readFile(resolved);
  if (/\.tiff?$/i.test(name)) {
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const image = await readTiffImage(buffer, { maxBytes: MAX_SECTION_DECODED_BYTES });
    return { name, image };
  }
  if (/\.png$/i.test(name)) {
    return { name, image: decodePngSection(bytes, name) };
  }
  if (/\.jpe?g$/i.test(name)) {
    return { name, image: decodeJpegSection(bytes, name) };
  }
  throw new Error(`${name} is not a TIFF, PNG or JPEG section.`);
}

async function readMriFile(mriPath) {
  const resolved = resolve(mriPath);
  const info = await stat(resolved);
  if (!info.isFile()) throw new Error(`MRI '${mriPath}' is not a regular file.`);
  if (info.size === 0) throw new Error(`MRI '${mriPath}' is empty.`);
  if (info.size > MAX_MRI_FILE_BYTES) {
    throw new Error(`MRI '${mriPath}' exceeds the 512 MiB file size limit.`);
  }
  const name = basename(resolved);
  if (!/\.nii(\.gz)?$/i.test(name)) {
    throw new Error(`${name} is not a NIfTI (.nii or .nii.gz) volume.`);
  }
  const bytes = await readFile(resolved);
  const parsed = readStrictNiftiVolume(bytes);
  return { name, volume: mriVolume(parsed, name) };
}

function inferSquareOmePixelSize(sections) {
  const sizes = sections.map(({ image }) => (image.metadata?.kind === "ome" ? image.pixelSize : null));
  const [first] = sizes;
  if (!first || !(first.x > 0) || !(first.y > 0)) return null;
  const same = (value) => Math.abs(value - first.x) <= 1e-6 * first.x;
  return sizes.every((size) => size && same(size.x) && same(size.y)) ? first.x : null;
}

async function createNodeGreedy() {
  const api = await loadGreedySingleThread();
  return {
    api,
    rigid: async (args) => registerRigidGreedy({ api, ...args }),
    affine: async (args) => registerAffineGreedy({ api, ...args }),
    svf: async (args) => registerSvfGreedy({ api, ...args }),
  };
}

/** Registers one or more 2D histology sections to a 3D NIfTI MRI volume. */
export async function runHisto2Mri({
  mriPath,
  sectionPaths,
  outputDir,
  options = {},
  onLog = () => {},
  renameFn = rename,
  writeFileFn = writeFile,
} = {}) {
  if (typeof mriPath !== "string" || !mriPath.trim()) {
    throw new Error("MRI NIfTI path is required.");
  }
  if (!Array.isArray(sectionPaths) || sectionPaths.length === 0) {
    throw new Error("At least one histology section (TIFF, PNG or JPEG) is required.");
  }
  const parsed = parseCliOptions(options);
  const mri = await readMriFile(mriPath);
  const sections = [];
  for (const path of sectionPaths) {
    sections.push(await readSectionFile(path));
  }

  // Allocate unique, case-insensitive collision-free output stems BEFORE registration.
  const sectionOutputNames = allocateUniqueOutputNames(sections.map(({ name }) => name));

  const defaultIndex = Math.floor(mri.volume.dims[parsed.axis] / 2);
  const pixelSize = parsed.pixelSize ?? inferSquareOmePixelSize(sections);
  const settings = runSettings(
    {
      axis: parsed.axis,
      index: parsed.sliceIndex ?? defaultIndex,
      step: parsed.step,
      tiltA: parsed.tiltA,
      tiltB: parsed.tiltB,
      pixelSize,
      contrast: parsed.contrast,
      orientation: parsed.orientation,
      refinePlane: parsed.refinePlane,
      searchOffset: parsed.searchOffset,
      searchTilt: parsed.searchTilt,
      deformable: parsed.deformable,
      linearIterations: parsed.linearIterations,
      deformableIterations: parsed.deformableIterations,
    },
    mri.volume.dims,
    sections.length,
  );

  const planeOf = (n) => ({
    axis: settings.plane.axis,
    index: settings.plane.index + n * settings.plane.step,
    tilt: settings.plane.tilt,
  });

  // Preflight every section before claiming OUTPUT_DIR / running Greedy
  for (const [n, { image }] of sections.entries()) {
    preflightSection({ volume: mri.volume, section: image, plane: planeOf(n), options: settings.options });
  }

  const claim = await claimOutputDirectory(outputDir);
  let succeeded = false;
  try {
    const greedy = await createNodeGreedy();
    const axisName = axisPlanes(mri.volume.affine)[settings.plane.axis];
    const encoder = new TextEncoder();
    const outputs = [];
    const registered = [];
    const reports = [];

    for (const [n, { name, image }] of sections.entries()) {
      onLog(`Registering ${name} (slice ${planeOf(n).index}, axis ${axisName})…`);
      const result = await registerSection({
        volume: mri.volume,
        section: image,
        plane: planeOf(n),
        options: settings.options,
        greedy,
      });
      const warped = warpedSection(result, image);
      const transforms = worldTransforms(result);
      const images = registrationImages(result);
      const report = registrationReport(result, {
        name,
        version: packageJson.version,
        settings: { plane: settings.plane, options: settings.options },
        axisName,
      });
      reports.push(report);

      const names = sectionOutputNames[n];
      const bytesByKind = {
        warped: new Uint8Array(gzipSync(rgbaNifti(warped.rgba, [warped.nu, warped.nv, 1], planeSform(result.plane, warped.spacing)))),
        plane: new Uint8Array(gzipSync(images.plane)),
        section: new Uint8Array(gzipSync(images.section)),
        affine: encoder.encode(transforms.matrix),
        warp: result.warp ? new Uint8Array(gzipSync(transforms.warp)) : null,
        registration: encoder.encode(`${JSON.stringify(report, null, 2)}\n`),
      };
      for (const kind of SECTION_OUTPUT_KINDS) {
        if (bytesByKind[kind]) {
          outputs.push({ name: names[kind], bytes: bytesByKind[kind] });
        }
      }
      if (settings.volumeOutput) {
        registered.push({ result: { plane: result.plane }, warped });
      }
      onLog(`${name}: NMI ${result.nmi.initial.toFixed(3)} → ${result.nmi.final.toFixed(3)}`);
    }

    if (settings.volumeOutput && registered.length) {
      const { bytes } = sectionsInVolume(mri.volume, registered);
      outputs.push({ name: "sections_in_mri.nii.gz", bytes: new Uint8Array(gzipSync(bytes)) });
    }

    const written = await writeStagedOutputs(claim.directory, outputs, { renameFn, writeFileFn });
    succeeded = true;
    return {
      outputDir: claim.directory,
      files: written,
      summary: runSummary(reports, settings),
      reports,
    };
  } finally {
    await claim.release({ removeDirIfEmpty: !succeeded });
  }
}

/** Verifies the private Node runtime and Greedy single-threaded WASM registration. */
export async function checkInstallation({ cacheDir } = {}) {
  if (cacheDir !== undefined && (typeof cacheDir !== "string" || !cacheDir.trim())) {
    throw new Error("cacheDir must be a non-empty path.");
  }
  const greedy = await createNodeGreedy();
  const nu = 48;
  const nv = 48;
  const nz = 5;
  const slice = new Float32Array(nu * nv);
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const dx = (i - 24) / 1.2;
      const dy = j - 24;
      const r = Math.hypot(dx, dy);
      slice[j * nu + i] = r < 15 ? (r > 11 ? 600 : 950) : 0;
    }
  }
  const data = new Float32Array(nu * nv * nz);
  for (let k = 0; k < nz; k++) data.set(slice, k * nu * nv);
  const volume = {
    dims: [nu, nv, nz],
    affine: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]],
    data,
  };
  const rgb = new Uint8Array(nu * nv * 3);
  for (let i = 0; i < nu * nv; i++) {
    const v = Math.round((slice[i] / 1000) * 255);
    rgb[i * 3] = v;
    rgb[i * 3 + 1] = v;
    rgb[i * 3 + 2] = v;
  }
  const section = { width: nu, height: nv, channels: 3, bitsPerSample: 8, maxValue: 255, data: rgb, pixelSize: null };
  const res = await registerSection({
    volume,
    section,
    plane: { axis: 2, index: 2 },
    options: { orientation: 0, pixelSize: 1000, refinePlane: false, deformable: false, linearIterations: "20x10x0" },
    greedy,
  });
  if (!(res.nmi.final > 1.2)) {
    throw new Error(`Histo2MRI self-check failed: NMI ${res.nmi.final.toFixed(3)} too low.`);
  }
  return {
    ok: true,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    executable: process.execPath,
    version: packageJson.version,
    greedy: "wasm-single",
    ...(cacheDir !== undefined ? { cacheDir: resolve(cacheDir) } : {}),
    phantom: {
      nmiInitial: Number(res.nmi.initial.toFixed(4)),
      nmiFinal: Number(res.nmi.final.toFixed(4)),
    },
  };
}
