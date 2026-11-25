// Node command-line interface for @neurodesk/lightsheet-atlas.
// Runs the exact same Allen CCFv3 registration + cellfinder candidate detection pipeline
// as the Light-sheet atlas web application, using @neurodesk/greedy single-threaded WASM.
import { randomUUID } from "node:crypto";
import { rmdirSync, unlinkSync } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, rename, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { gzipSync } from "node:zlib";
import { loadGreedySingleThread } from "@neurodesk/greedy/single";
import { resliceAffineGreedy } from "@neurodesk/greedy";
import { openMicroscopyStack, openOmeZarrStore } from "@neurodesk/webapp-components/file-io/microscopy-stack";
import { createNiftiFromData, createNiftiHeaderFromVolume, readNiftiImageData } from "@neurodesk/webapp-components/file-io/nifti";
import packageJson from "../package.json" with { type: "json" };
import { DETECTION_FIELDS, outputNames, runSettings } from "./config.js";
import { ATLAS_METADATA, defaultCacheDir, downloadModels, inspectModels, loadAtlas, offlineByDefault } from "./models.js";
import { resultFiles } from "./outputs.js";
import { runPipeline } from "./pipeline.js";
import { parseOrientation } from "./space.js";

export { defaultCacheDir, downloadModels, inspectModels, loadAtlas, offlineByDefault } from "./models.js";

export const OUTPUT_LOCK_FILE = ".neurodesk-cli.lock";
const MAX_INPUT_FILE_BYTES = 2 * 1024 ** 3;
const ALLOWED_OPTION_KEYS = new Set([
  "orientation",
  "voxel-z",
  "voxel-y",
  "voxel-x",
  "no-register",
  "detect",
  "soma-diameter-um",
  "ball-xy-um",
  "ball-z-um",
  "ball-overlap-fraction",
  "sds-above-mean",
  "cache-dir",
  "offline",
]);

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

function parseBooleanOpt(raw, label) {
  if (raw === undefined) return false;
  if (typeof raw !== "boolean") {
    throw new Error(`Option --${label} must be a boolean, got ${typeof raw}.`);
  }
  return raw;
}

function parsePositiveNumber(raw, label) {
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" && typeof raw !== "string") {
    throw new Error(`Option --${label} must be a positive finite number, got ${typeof raw}.`);
  }
  const trimmed = String(raw).trim();
  if (!trimmed) throw new Error(`Option --${label} requires a non-empty value.`);
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Option --${label} must be a positive finite number, got '${raw}'.`);
  }
  return value;
}

/** Validates CLI flags before touching input files or output directories. */
export function parseCliOptions(values = {}) {
  assertPlainOptions(values);
  const noRegister = parseBooleanOpt(values["no-register"], "no-register");
  const register = !noRegister;
  const detect = parseBooleanOpt(values.detect, "detect");
  if (!register && !detect) {
    throw new Error("Choose atlas registration, cell detection (--detect), or both.");
  }

  let orientation = "asr";
  if (values.orientation !== undefined) {
    if (typeof values.orientation !== "string" || !values.orientation.trim()) {
      throw new Error("Option --orientation requires a non-empty string value.");
    }
    orientation = values.orientation.trim().toLowerCase();
  }
  parseOrientation(orientation);

  const voxelZ = parsePositiveNumber(values["voxel-z"], "voxel-z");
  const voxelY = parsePositiveNumber(values["voxel-y"], "voxel-y");
  const voxelX = parsePositiveNumber(values["voxel-x"], "voxel-x");

  const detection = {
    somaDiameterUm: parsePositiveNumber(values["soma-diameter-um"], "soma-diameter-um") ?? DETECTION_FIELDS.somaDiameterUm,
    ballXyUm: parsePositiveNumber(values["ball-xy-um"], "ball-xy-um") ?? DETECTION_FIELDS.ballXyUm,
    ballZUm: parsePositiveNumber(values["ball-z-um"], "ball-z-um") ?? DETECTION_FIELDS.ballZUm,
    ballOverlapFraction: parsePositiveNumber(values["ball-overlap-fraction"], "ball-overlap-fraction") ?? DETECTION_FIELDS.ballOverlapFraction,
    nSdsAboveMeanThresh: parsePositiveNumber(values["sds-above-mean"], "sds-above-mean") ?? DETECTION_FIELDS.nSdsAboveMeanThresh,
  };
  if (detection.ballOverlapFraction > 1) {
    throw new Error("Option --ball-overlap-fraction must be at most 1.");
  }

  let cacheDir;
  if (values["cache-dir"] !== undefined) {
    if (typeof values["cache-dir"] !== "string" || !values["cache-dir"].trim()) {
      throw new Error("Option --cache-dir requires a non-empty path.");
    }
    cacheDir = values["cache-dir"];
  }

  const offlineFlag = parseBooleanOpt(values.offline, "offline");

  return {
    register,
    detect,
    orientation,
    voxelSizeOverride: [voxelZ, voxelY, voxelX],
    detection,
    cacheDir,
    offline: offlineFlag || offlineByDefault(),
  };
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
      // ignore
    }
    if (createdDir) {
      try {
        rmdirSync(directory);
      } catch {
        // leave non-empty dir intact
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
 * Stages every output file to a `.partial` path first (registering each path BEFORE `writeFile`),
 * then renames all files into place. On error, unlinks `.partial` files and rolls back ONLY
 * final outputs this run created (verified by lstat + dev/ino).
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

/**
 * Lazy file-backed zarrita store for local OME-Zarr directories.
 * Reads metadata and ONLY the requested resolution level's chunks on demand via `readFile`,
 * never pre-loading or scanning unselected resolution levels into memory.
 */
export class FsZarrStore {
  constructor(rootDir, { onReadKey = null } = {}) {
    this.rootDir = resolve(rootDir);
    this.onReadKey = onReadKey;
  }

  async get(key) {
    const normalized = String(key).replace(/^\/+/, "");
    const target = resolve(this.rootDir, normalized);
    if (target !== this.rootDir && !target.startsWith(`${this.rootDir}${sep}`)) {
      return undefined;
    }
    try {
      const info = await stat(target);
      if (!info.isFile()) return undefined;
      if (info.size > MAX_INPUT_FILE_BYTES) {
        throw new Error(`Input Zarr chunk '${target}' exceeds the 2 GiB safety limit.`);
      }
      if (this.onReadKey) this.onReadKey(normalized);
      const bytes = await readFile(target);
      return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "EISDIR") {
        return undefined;
      }
      throw error;
    }
  }
}

async function isOmeZarrDirectory(rootDir) {
  for (const marker of ["zarr.json", ".zattrs", ".zgroup"]) {
    const info = await stat(join(rootDir, marker)).catch(() => null);
    if (info?.isFile()) return true;
  }
  return false;
}

/** Lazily wraps a local TIFF file without loading its bytes until read. */
function lazyFileHandle(fullPath, relPath, size) {
  return {
    name: basename(fullPath),
    size,
    _webkitRelativePath: relPath,
    async arrayBuffer() {
      const buf = await readFile(fullPath);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    },
    slice(start = 0, end = size) {
      return {
        async arrayBuffer() {
          const clampedStart = Math.max(0, start);
          const clampedEnd = Math.min(size, end);
          const length = Math.max(0, clampedEnd - clampedStart);
          const out = Buffer.alloc(length);
          if (length === 0) return out.buffer;
          const fh = await open(fullPath, "r");
          try {
            await fh.read(out, 0, length, clampedStart);
          } finally {
            await fh.close();
          }
          return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
        },
      };
    },
  };
}

async function collectTiffDirectoryFiles(rootDir, currentDir = rootDir, rootName = basename(rootDir)) {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectTiffDirectoryFiles(rootDir, fullPath, rootName)));
    } else if (entry.isFile() && /\.tiff?$/i.test(entry.name)) {
      const info = await stat(fullPath);
      if (info.size > MAX_INPUT_FILE_BYTES) {
        throw new Error(`Input file '${fullPath}' exceeds the 2 GiB safety limit.`);
      }
      const rel = `${rootName}/${relative(rootDir, fullPath).replaceAll("\\", "/")}`;
      files.push(lazyFileHandle(fullPath, rel, info.size));
    }
  }
  return files;
}

/** Opens a local TIFF file, TIFF plane folder, or OME-Zarr directory lazily without pre-loading chunks. */
export async function openInputStack(inputPath, { onReadKey = null } = {}) {
  const resolved = resolve(inputPath);
  const info = await stat(resolved);
  if (info.isDirectory()) {
    if (await isOmeZarrDirectory(resolved)) {
      const store = new FsZarrStore(resolved, { onReadKey });
      const stack = await openOmeZarrStore(store, { name: basename(resolved) });
      return { stack, inputName: basename(resolved) };
    }
    const files = await collectTiffDirectoryFiles(resolved);
    if (!files.length) throw new Error(`Input directory '${inputPath}' contains no supported TIFF or OME-Zarr files.`);
    const stack = await openMicroscopyStack(files);
    return { stack, inputName: basename(resolved) };
  }
  if (!info.isFile()) {
    throw new Error(`Input '${inputPath}' is neither a regular file nor a directory.`);
  }
  if (info.size === 0) {
    throw new Error(`Input file '${inputPath}' is empty.`);
  }
  if (info.size > MAX_INPUT_FILE_BYTES) {
    throw new Error(`Input file '${inputPath}' exceeds the 2 GiB safety limit.`);
  }
  const bytes = await readFile(resolved);
  const name = basename(resolved);
  const stack = await openMicroscopyStack([new File([bytes], name)]);
  return { stack, inputName: name };
}

/**
 * Runs light-sheet atlas registration and/or cell candidate detection on a TIFF stack or OME-Zarr folder.
 */
export async function runLightsheetAtlas({
  input,
  outputDir,
  options = {},
  onProgress = () => {},
  onLog = () => {},
  renameFn = rename,
  writeFileFn = writeFile,
} = {}) {
  if (typeof input !== "string" || !input.trim()) {
    throw new Error("Input path is required.");
  }
  const parsed = parseCliOptions(options);
  const { stack, inputName } = await openInputStack(input);

  const voxelSizeUm = [
    parsed.voxelSizeOverride[0] ?? stack.voxelSizeUm?.z,
    parsed.voxelSizeOverride[1] ?? stack.voxelSizeUm?.y,
    parsed.voxelSizeOverride[2] ?? stack.voxelSizeUm?.x,
  ];
  if (voxelSizeUm.some((value) => !(Number.isFinite(value) && value > 0))) {
    throw new Error("Voxel size (µm) is missing from the stack metadata; pass --voxel-z, --voxel-y and --voxel-x.");
  }

  const settings = runSettings({
    voxelSizeUm,
    orientation: parsed.orientation,
    register: parsed.register,
    detect: parsed.detect,
    detection: parsed.detection,
  });

  const claim = await claimOutputDirectory(outputDir);
  let succeeded = false;
  try {
    const started = performance.now();
    const greedy = settings.register ? await loadGreedySingleThread() : null;
    const atlasLoader = () => loadAtlas({
      cacheDir: parsed.cacheDir ?? defaultCacheDir(),
      offline: parsed.offline,
      onProgress: (message) => onLog(message),
    });

    const result = await runPipeline({
      stack,
      voxelSizeUm: settings.voxelSizeUm,
      orientation: settings.orientation,
      register: settings.register,
      detect: settings.detect,
      detectOptions: settings.detection,
      loadAtlas: atlasLoader,
      greedy,
      onProgress,
      onLog,
    });

    const packed = resultFiles(result, { register: settings.register, voxelSizeUm: settings.voxelSizeUm });
    const names = outputNames(inputName);
    const encoder = new TextEncoder();
    const outputs = [
      { name: names.sample, bytes: new Uint8Array(gzipSync(packed.files.sample)) },
    ];
    if (packed.files.registeredAtlas) {
      outputs.push({ name: names.registeredAtlas, bytes: new Uint8Array(gzipSync(packed.files.registeredAtlas)) });
    }
    if (packed.files.regions) {
      outputs.push({ name: names.regions, bytes: packed.files.regions });
    }
    if (result.matrix) {
      outputs.push({ name: names.matrix, bytes: encoder.encode(result.matrix) });
    }
    if (packed.files.candidates) {
      outputs.push({ name: names.candidates, bytes: packed.files.candidates });
    }
    if (packed.files.marks) {
      outputs.push({ name: names.marks, bytes: new Uint8Array(gzipSync(packed.files.marks)) });
    }

    const seconds = Number(((performance.now() - started) / 1000).toFixed(2));
    const provenance = {
      app: "lightsheet-atlas",
      version: packageJson.version,
      input: {
        name: inputName,
        kind: stack.kind,
        shape: stack.shape,
        dtype: stack.dtype,
      },
      settings,
      atlas: settings.register ? ATLAS_METADATA : null,
      gridShape: packed.gridShape,
      spacingUm: packed.spacingUm,
      candidateCount: packed.candidateCount,
      assignedCandidates: packed.assignedCandidates ?? null,
      regionRows: packed.regionRows ?? null,
      files: outputs.map((file) => file.name),
      seconds,
    };
    outputs.push({ name: names.provenance, bytes: encoder.encode(`${JSON.stringify(provenance, null, 2)}\n`) });

    const written = await writeStagedOutputs(claim.directory, outputs, { renameFn, writeFileFn });
    succeeded = true;
    return {
      outputDir: claim.directory,
      files: written,
      provenance,
    };
  } finally {
    await claim.release({ removeDirIfEmpty: !succeeded });
  }
}

/** Verifies the private Node runtime, Greedy single-threaded WASM, and Allen CCFv3 atlas cache. */
export async function checkInstallation({ cacheDir } = {}) {
  if (cacheDir !== undefined && (typeof cacheDir !== "string" || !cacheDir.trim())) {
    throw new Error("cacheDir must be a non-empty path.");
  }
  const api = await loadGreedySingleThread();
  const shape = [8, 8, 8];
  const data = new Float32Array(8 * 8 * 8);
  data[3 + 8 * (3 + 8 * 3)] = 100;
  const header = createNiftiHeaderFromVolume({
    hdr: {
      dims: [3, 8, 8, 8, 1, 1, 1, 1],
      pixDims: [1, 1, 1, 1, 1, 1, 1, 1],
      affine: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]],
    },
  });
  const nifti = new Uint8Array(createNiftiFromData(data, header, { dims: shape }));
  const identity = "1 0 0 0\n0 1 0 0\n0 0 1 0\n0 0 0 1\n";
  const resliced = resliceAffineGreedy({
    api,
    fixed: nifti,
    moving: nifti,
    matrix: identity,
    interpolation: "nearest",
    fill: 0,
  });
  const reslicedData = readNiftiImageData(resliced).data;
  if (reslicedData[3 + 8 * (3 + 8 * 3)] !== 100) {
    throw new Error("Greedy WebAssembly identity reslice check failed.");
  }

  const atlas = await inspectModels(cacheDir ?? defaultCacheDir());
  return {
    ok: true,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    executable: process.execPath,
    version: packageJson.version,
    greedy: "wasm-single",
    atlas: {
      directory: atlas.directory,
      ready: atlas.ready,
      count: atlas.count,
      assets: atlas.assets.map(({ id, filename, verified }) => ({ id, filename, verified })),
    },
  };
}
