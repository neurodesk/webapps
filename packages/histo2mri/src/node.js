// Node command-line interface for @neurodesk/histo2mri.
// Registers 2D histology sections (TIFF, PNG, JPEG) to a 3D MRI volume (NIfTI) using the exact
// same Greedy NMI rigid, affine, plane search and deformable SVF pipeline as the Histo2MRI web app.
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { loadGreedySingleThread } from "@neurodesk/greedy/single";
import { registerAffineGreedy, registerRigidGreedy, registerSvfGreedy } from "@neurodesk/greedy";
import { readTiffImage } from "@neurodesk/webapp-components/file-io/tiff";
import { decode as decodePng } from "fast-png";
import jpeg from "jpeg-js";
import packageJson from "../package.json" with { type: "json" };
import { SECTION_OUTPUT_KINDS, outputNames, runSettings, runSummary } from "./config.js";
import { mriVolume, rgbaNifti } from "./core/nifti.js";
import { planeSform, registrationImages, registrationReport, sectionsInVolume, warpedSection, worldTransforms } from "./core/outputs.js";
import { axisPlanes } from "./core/plane.js";
import { DEFAULTS, preflightSection, registerSection } from "./core/register.js";
import { readStrictNiftiVolume } from "./nifti-io.js";

const OUTPUT_LOCK_FILE = ".neurodesk-histo2mri.lock";
const MAX_MRI_FILE_BYTES = 512 * 1024 * 1024;
const MAX_SECTION_FILE_BYTES = 256 * 1024 * 1024;
const MAX_SECTION_DECODED_BYTES = 256 * 1024 * 1024;
const ITERATIONS_RE = /^\d+x\d+x\d+$/;
const AXIS_MAP = Object.freeze({ 0: 0, 1: 1, 2: 2, i: 0, j: 1, k: 2 });

function parseFiniteOpt(raw, flag, { min = -Infinity, max = Infinity, exclusiveMin = false } = {}) {
  if (raw === undefined) return undefined;
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
  const axisRaw = values.axis === undefined ? "2" : String(values.axis).trim().toLowerCase();
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

  const contrast = values.contrast ?? DEFAULTS.contrast;
  if (!["auto", "haematoxylin", "eosin", "dab"].includes(contrast)) {
    throw new Error(`Option --contrast must be one of auto, haematoxylin, eosin, dab, got '${contrast}'.`);
  }
  const orientation = values.orientation ?? DEFAULTS.orientation;
  if (orientation !== "auto" && !/^[0-7]$/.test(String(orientation))) {
    throw new Error(`Option --orientation must be auto or 0..7, got '${orientation}'.`);
  }

  const linearIterations = values["linear-iterations"] ?? DEFAULTS.linearIterations;
  if (!ITERATIONS_RE.test(linearIterations)) {
    throw new Error(`Option --linear-iterations must be three x-separated integers (e.g. 100x50x10), got '${linearIterations}'.`);
  }
  const deformableIterations = values["deformable-iterations"] ?? DEFAULTS.deformableIterations;
  if (!ITERATIONS_RE.test(deformableIterations)) {
    throw new Error(`Option --deformable-iterations must be three x-separated integers (e.g. 0x0x200), got '${deformableIterations}'.`);
  }

  return {
    axis,
    sliceIndex,
    step,
    tiltA,
    tiltB,
    pixelSize,
    contrast,
    orientation,
    refinePlane: !values["no-refine-plane"],
    searchOffset,
    searchTilt,
    deformable: !values["no-deformable"],
    linearIterations,
    deformableIterations,
  };
}

/**
 * Exclusively claims `outputDir` with an O_EXCL lock file, cleaning up the lock AND any newly
 * created directory on ANY error (including write/readdir errors or non-empty directory).
 */
export async function claimOutputDirectory(outputDir) {
  if (typeof outputDir !== "string" || !outputDir.trim()) {
    throw new Error("Output directory must be a non-empty path.");
  }
  const directory = resolve(outputDir);
  let createdDir = false;
  try {
    const info = await stat(directory);
    if (!info.isDirectory()) {
      throw new Error(`Output path '${directory}' exists and is not a directory.`);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await mkdir(directory, { recursive: true });
    createdDir = true;
  }

  const lockPath = join(directory, OUTPUT_LOCK_FILE);
  let handle = null;
  let lockAcquired = false;
  try {
    handle = await open(lockPath, "wx");
    lockAcquired = true;
    await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`);
    await handle.close();
    handle = null;

    const entries = await readdir(directory);
    if (entries.length !== 1 || entries[0] !== OUTPUT_LOCK_FILE) {
      throw new Error(`Output directory ${directory} is not empty. Choose a new or empty directory.`);
    }
  } catch (error) {
    await handle?.close().catch(() => {});
    if (lockAcquired) {
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
      await rm(lockPath, { force: true }).catch(() => {});
      if (removeDirIfEmpty && createdDir) {
        await rmdir(directory).catch(() => {});
      }
    },
  };
}

/**
 * Stages every output file to a `.partial` path first, then renames all files into place.
 * Rolls back already-renamed outputs and removes all `.partial` files if any step fails.
 */
export async function writeStagedOutputs(directory, files, { renameFn = rename } = {}) {
  const runId = randomUUID().slice(0, 8);
  const staged = [];
  const renamed = [];
  try {
    for (const { name, bytes } of files) {
      const partialPath = join(directory, `.${name}.${runId}.partial`);
      const finalPath = join(directory, name);
      await writeFile(partialPath, bytes, { flag: "wx" });
      staged.push({ name, partialPath, finalPath });
    }
    for (const item of staged) {
      await renameFn(item.partialPath, item.finalPath);
      renamed.push(item.finalPath);
    }
    return staged.map((item) => item.name);
  } catch (error) {
    for (const item of staged) {
      await rm(item.partialPath, { force: true }).catch(() => {});
    }
    for (const finalPath of renamed) {
      await rm(finalPath, { force: true }).catch(() => {});
    }
    throw error;
  }
}

function unpackPngBits(data, width, height, depth) {
  if (depth >= 8) return data;
  const out = new Uint8Array(width * height);
  const rowBytes = Math.ceil((width * depth) / 8);
  const mask = (1 << depth) - 1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const bit = x * depth;
      out[y * width + x] = (data[y * rowBytes + (bit >> 3)] >> (8 - depth - (bit & 7))) & mask;
    }
  }
  return out;
}

/** Decodes a PNG buffer in pure Node into interleaved section pixels { width, height, channels, bitsPerSample, maxValue, data, pixelSize }. */
export function decodePngSection(bytes, name) {
  if (bytes.byteLength < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) {
    throw new Error(`${name} is not a valid PNG file.`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ihdrWidth = view.getUint32(16, false);
  const ihdrHeight = view.getUint32(20, false);
  const ihdrDepth = bytes[24];
  const estBytes = ihdrWidth * ihdrHeight * 4 * (ihdrDepth === 16 ? 2 : 1);
  if (estBytes > MAX_SECTION_DECODED_BYTES) {
    throw new Error(`${name} (${ihdrWidth} × ${ihdrHeight}) exceeds the 256 MiB section memory limit.`);
  }

  const image = decodePng(bytes);
  const { width, height, depth } = image;
  if (image.palette) {
    const indices = unpackPngBits(image.data, width, height, depth);
    const rgb = new Uint8Array(width * height * 3);
    for (let i = 0; i < indices.length; i++) {
      const entry = image.palette[indices[i]] ?? [0, 0, 0];
      rgb[i * 3] = entry[0];
      rgb[i * 3 + 1] = entry[1];
      rgb[i * 3 + 2] = entry[2];
    }
    return { width, height, channels: 3, bitsPerSample: 8, maxValue: 255, data: rgb, pixelSize: null };
  }
  const alpha = image.channels === 2 || image.channels === 4;
  const channels = alpha ? image.channels - 1 : image.channels;
  let data = image.channels === 1 ? unpackPngBits(image.data, width, height, depth) : image.data;
  if (alpha) {
    const Typed = depth === 16 ? Uint16Array : Uint8Array;
    const stripped = new Typed(width * height * channels);
    for (let i = 0, o = 0; i < data.length; i += image.channels) {
      for (let c = 0; c < channels; c++) stripped[o++] = data[i + c];
    }
    data = stripped;
  }
  const maxValue = depth === 16 ? 65535 : depth < 8 ? (1 << depth) - 1 : 255;
  return { width, height, channels, bitsPerSample: depth, maxValue, data, pixelSize: null };
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
  for (const [n, { name, image }] of sections.entries()) {
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
    const usedNames = new Set();

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

      let names = outputNames(name);
      if (usedNames.has(names.registration)) {
        const numbered = name.replace(/(\.[^.]+)$/, `_${n + 1}$1`);
        names = outputNames(numbered);
      }
      usedNames.add(names.registration);

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

    const written = await writeStagedOutputs(claim.directory, outputs, { renameFn });
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
