// Node command-line interface for @neurodesk/lightsheet-atlas.
// Runs the exact same Allen CCFv3 registration + cellfinder candidate detection pipeline
// as the Light-sheet atlas web application, using @neurodesk/greedy single-threaded WASM.
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { loadGreedySingleThread } from "@neurodesk/greedy/single";
import { resliceAffineGreedy } from "@neurodesk/greedy";
import { openMicroscopyStack } from "@neurodesk/webapp-components/file-io/microscopy-stack";
import { createNiftiFromData, createNiftiHeaderFromVolume, readNiftiImageData } from "@neurodesk/webapp-components/file-io/nifti";
import packageJson from "../package.json" with { type: "json" };
import { DETECTION_FIELDS, outputNames, runSettings } from "./config.js";
import { ATLAS_METADATA, defaultCacheDir, downloadModels, inspectModels, loadAtlas, offlineByDefault } from "./models.js";
import { resultFiles } from "./outputs.js";
import { runPipeline } from "./pipeline.js";
import { parseOrientation } from "./space.js";

export { defaultCacheDir, downloadModels, inspectModels, loadAtlas, offlineByDefault } from "./models.js";

const OUTPUT_LOCK_FILE = ".neurodesk-lightsheet-atlas.lock";
const MAX_INPUT_FILE_BYTES = 2 * 1024 ** 3;

function parsePositiveNumber(raw, label) {
  if (raw === undefined) return undefined;
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
  const register = values["no-register"] ? false : true;
  const detect = Boolean(values.detect);
  if (!register && !detect) {
    throw new Error("Choose atlas registration, cell detection (--detect), or both.");
  }

  const orientation = values.orientation === undefined ? "asr" : String(values.orientation).trim().toLowerCase();
  if (!orientation) throw new Error("Option --orientation requires a non-empty value.");
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

  return {
    register,
    detect,
    orientation,
    voxelSizeOverride: [voxelZ, voxelY, voxelX],
    detection,
    cacheDir,
    offline: Boolean(values.offline) || offlineByDefault(),
  };
}

/**
 * Exclusively claims `directory` with an O_EXCL lock file, cleaning up the lock AND any newly
 * created directory on ANY failure (including write/readdir errors or non-empty directory).
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
 * If any write or rename fails, removes all `.partial` files AND rolls back already-renamed outputs.
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

async function collectDirectoryFiles(rootDir, currentDir = rootDir, rootName = basename(rootDir)) {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectDirectoryFiles(rootDir, fullPath, rootName)));
    } else if (entry.isFile()) {
      const info = await stat(fullPath);
      if (info.size > MAX_INPUT_FILE_BYTES) {
        throw new Error(`Input file '${fullPath}' exceeds the 2 GiB safety limit.`);
      }
      const bytes = await readFile(fullPath);
      const rel = `${rootName}/${relative(rootDir, fullPath).replaceAll("\\", "/")}`;
      const file = new File([bytes], entry.name);
      Object.defineProperty(file, "_webkitRelativePath", { value: rel, enumerable: false });
      files.push(file);
    }
  }
  return files;
}

async function openInputStack(inputPath) {
  const resolved = resolve(inputPath);
  const info = await stat(resolved);
  if (info.isDirectory()) {
    const files = await collectDirectoryFiles(resolved);
    if (!files.length) throw new Error(`Input directory '${inputPath}' contains no files.`);
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

    const written = await writeStagedOutputs(claim.directory, outputs, { renameFn });
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

/** Verifies the private Node runtime, Greedy single-threaded WASM execution, and Allen atlas cache state. */
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
