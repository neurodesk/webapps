// Node command-line interface for @neurodesk/cellpose.
// Runs the exact same Cellpose 3 2D/3D normalization, tiling, flow dynamics, mask clustering
// and TIFF/CSV writers as the Cellpose web application, on ONNX Runtime CPU.
import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, rename, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { availableParallelism, homedir, hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { InputTooLargeError } from "@neurodesk/webapp-components/file-io/input-limits";
import packageJson from "../package.json" with { type: "json" };
import { segment2D, segment3D } from "./cellpose.js";
import { MAX_DECODED_BYTES, cellsCsv, cellsCsv3D, readImage, writeLabelsTiff } from "./image-io.js";
import { DEFAULT_MODEL_ID, MODEL_ASSETS, MODEL_IDS, manifest, resolveModel } from "./models.js";
import { outputName, segmentationSettings } from "./settings.js";

// Disable ONNX Runtime telemetry before lazily importing onnxruntime-node.
process.env.ORT_DISABLE_TELEMETRY ??= "1";

let ortPromise = null;
async function loadOrt() {
  process.env.ORT_DISABLE_TELEMETRY ??= "1";
  ortPromise ??= import("onnxruntime-node");
  return ortPromise;
}

const IDENTITY_MODEL = Buffer.from("CAc6NwoQCgF4EgF5IghJZGVudGl0eRIBZ1oPCgF4EgoKCAgBEgQKAggBYg8KAXkSCgoICAESBAoCCAFCAhAN", "base64");

const LOCK_NAME = ".cellpose-run.lock";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const offlineByDefault = () => process.env.NEURODESK_OFFLINE === "1";

export const OPTIONS = Object.freeze({
  model: {
    type: "string",
    enum: [...MODEL_IDS],
    default: DEFAULT_MODEL_ID,
    description: "Pretrained Cellpose 3 model: cyto3 (cells/cytoplasm) or nuclei.",
  },
  channel: {
    type: "integer",
    minimum: 1,
    maximum: 256,
    default: 1,
    description: "1-based primary channel to segment.",
  },
  nuclearChannel: {
    type: "integer",
    flag: "nuclear-channel",
    minimum: 0,
    maximum: 256,
    default: 0,
    description: "Optional 1-based nuclear channel to guide cyto3 (0 means none).",
  },
  diameter: {
    type: "number",
    minimum: 5,
    maximum: 500,
    description: "Expected object diameter in pixels (default: 30 cyto3, 17 nuclei).",
  },
  flowThresh: {
    type: "number",
    flag: "flow-thresh",
    minimum: 0,
    maximum: 3,
    default: 0.4,
    description: "Maximum allowed flow error in 2D (0 disables flow filtering).",
  },
  cellprobThresh: {
    type: "number",
    flag: "cellprob-thresh",
    minimum: -6,
    maximum: 6,
    default: 0,
    description: "Cell probability logit threshold.",
  },
  minSize: {
    type: "integer",
    flag: "min-size",
    minimum: 1,
    maximum: 100000,
    default: 15,
    description: "Minimum mask area in pixels (2D) or volume in voxels (3D).",
  },
  do3D: {
    type: "boolean",
    flag: "do-3d",
    default: false,
    description: "Run 3D ortho-plane (YX, ZY, ZX) segmentation on a 3D multi-page stack.",
  },
  anisotropy: {
    type: "number",
    minimum: 0.1,
    maximum: 20,
    default: 1,
    description: "Ratio of Z spacing to XY pixel spacing for 3D segmentation.",
  },
  threads: {
    type: "integer",
    minimum: 1,
    description: "ONNX Runtime CPU threads (default: SLURM_CPUS_PER_TASK or all cores).",
  },
  cacheDir: {
    type: "string",
    flag: "cache-dir",
    description: "Model directory (default: NEURODESK_CELLPOSE_MODEL_DIR or ~/.cache/neurodesk/cellpose/<rev>).",
  },
  offline: {
    type: "boolean",
    default: false,
    description: "Never download models; fail if a required model file is missing.",
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

export function resolveThreads(raw = process.env.SLURM_CPUS_PER_TASK || availableParallelism()) {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!/^[1-9]\d*$/.test(trimmed)) throw new Error(`--threads must be a positive integer, got '${raw}'.`);
    const parsed = Number(trimmed);
    if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`--threads must be a positive integer, got '${raw}'.`);
    return parsed;
  }
  if (!Number.isSafeInteger(raw) || raw < 1) throw new Error(`--threads must be a positive integer, got '${raw}'.`);
  return raw;
}

export function defaultCacheDir() {
  if (process.env.NEURODESK_CELLPOSE_MODEL_DIR) return process.env.NEURODESK_CELLPOSE_MODEL_DIR;
  const cache = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(cache, "neurodesk", "cellpose", manifest.revision.slice(0, 12));
}

export function parseCliOptions(values = {}) {
  const modelId = assertNonEmptyString(values.model, "model") ?? DEFAULT_MODEL_ID;
  const model = resolveModel(modelId);

  const channel = parseNumeric(values.channel, "channel", { integer: true, min: 1, max: 256 });
  const nuclearChannel = parseNumeric(values["nuclear-channel"] ?? values.nuclearChannel, "nuclear-channel", { integer: true, min: 0, max: 256 });
  const diameter = parseNumeric(values.diameter, "diameter", { min: 5, max: 500 });
  const flowThresh = parseNumeric(values["flow-thresh"] ?? values.flowThresh, "flow-thresh", { min: 0, max: 3 });
  const cellprobThresh = parseNumeric(values["cellprob-thresh"] ?? values.cellprobThresh, "cellprob-thresh", { min: -6, max: 6 });
  const minSize = parseNumeric(values["min-size"] ?? values.minSize, "min-size", { integer: true, min: 1, max: 100000 });
  const anisotropy = parseNumeric(values.anisotropy, "anisotropy", { min: 0.1, max: 20 });
  const do3D = Boolean(values["do-3d"] ?? values.do3D);
  const threadsRaw = values.threads !== undefined ? assertNonEmptyString(values.threads, "threads") : undefined;
  const threads = resolveThreads(threadsRaw);
  const cacheDir = assertNonEmptyString(values["cache-dir"] ?? values.cacheDir, "cache-dir") ?? defaultCacheDir();

  const settings = segmentationSettings(
    { model: model.name, channel, nuclearChannel, diameter, flowThresh, cellprobThresh, minSize, do3D, anisotropy },
    model,
  );
  return {
    model,
    settings,
    threads,
    cacheDir,
    offline: values.offline !== undefined ? Boolean(values.offline) : offlineByDefault(),
    overwrite: Boolean(values.overwrite),
  };
}

function installedSha256(assets) {
  const entries = assets.map(({ filename, sha256: digest }) => [filename, digest]).sort(([a], [b]) => (a < b ? -1 : 1));
  return sha256(JSON.stringify(Object.fromEntries(entries)));
}

async function writeAtomically(filePath, bytes) {
  const partial = `${filePath}.${randomBytes(6).toString("hex")}.partial`;
  try {
    await writeFile(partial, bytes, { flag: "wx" });
    await rename(partial, filePath);
  } catch (error) {
    await rm(partial, { force: true }).catch(() => {});
    throw error;
  }
}

async function loadModelAsset(asset, { cacheDir, offline, onProgress }) {
  const path = join(cacheDir, asset.filename);
  const verified = (bytes) => bytes.byteLength === asset.bytes && sha256(bytes) === asset.sha256;
  let bytes;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (bytes) {
    if (!verified(bytes)) {
      throw new Error(`Cached ${asset.filename} failed checksum verification. Delete ${path} and download it again.`);
    }
    return bytes;
  }
  if (offline) {
    throw new Error(`${asset.filename} is missing from the offline model directory ${cacheDir}. Run "cellpose download-models" while online, or reinstall the complete release.`);
  }
  onProgress?.(`Downloading ${asset.filename}…`);
  const response = await fetch(asset.url);
  if (!response.ok) throw new Error(`Failed to download ${asset.filename}: HTTP ${response.status}`);
  bytes = Buffer.from(await response.arrayBuffer());
  if (!verified(bytes)) throw new Error(`${asset.filename} download failed checksum verification.`);
  await mkdir(cacheDir, { recursive: true });
  await writeAtomically(path, bytes);
  return bytes;
}

export async function downloadModels({
  cacheDir = defaultCacheDir(),
  offline = offlineByDefault(),
  onProgress = () => {},
} = {}) {
  for (const asset of MODEL_ASSETS) {
    await loadModelAsset(asset, { cacheDir, offline, onProgress });
  }
  return {
    directory: resolve(cacheDir),
    count: MODEL_ASSETS.length,
    installedSha256: installedSha256(MODEL_ASSETS),
  };
}

async function readBoundedInputFile(filePath, maxFileBytes = MAX_DECODED_BYTES) {
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
    return {
      name,
      buffer: combined.buffer.slice(combined.byteOffset, combined.byteOffset + combined.byteLength),
    };
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
    for (let i = createdDirs.length - 1; i >= 0; i -= 1) await rmdir(createdDirs[i]).catch(() => {});
  };
  const lockPath = join(dir, LOCK_NAME);
  let lockHandle;
  try {
    lockHandle = await open(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  } catch (error) {
    await cleanupCreated();
    if (error.code === "EEXIST") {
      throw new Error(`Output directory '${outputDir}' is locked by another running cellpose process (or contains ${LOCK_NAME}).`);
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
    for (let i = committed.length - 1; i >= 0; i -= 1) await unlink(committed[i].finalPath).catch(() => {});
    for (let i = backedUp.length - 1; i >= 0; i -= 1) await rename(backedUp[i].backupPath, backedUp[i].finalPath).catch(() => {});
    for (const entry of staged) await rm(entry.partialPath, { force: true }).catch(() => {});
    throw error;
  }

  for (const backup of backedUp) await rm(backup.backupPath, { force: true }).catch(() => {});
  return committed.map((entry) => entry.finalPath);
}

function exportSpacingFor(image, is3d, anisotropy) {
  const sp = image.spacing;
  const hasX = sp?.x > 0;
  const hasY = sp?.y > 0;
  if (!is3d) {
    if (hasX && hasY) return sp;
    if (hasX || hasY) {
      const xy = hasX ? sp.x : sp.y;
      return { x: xy, y: xy, z: sp.z ?? null, unit: sp.unit ?? "micron" };
    }
    return null;
  }
  if (hasX || hasY) {
    const x = hasX ? sp.x : sp.y;
    const y = hasY ? sp.y : sp.x;
    return { x, y, z: anisotropy * x, unit: sp.unit ?? "micron" };
  }
  return { x: null, y: null, z: anisotropy, unit: null };
}

function prepareInputForRun(image, name, model, settings) {
  if (settings.do3D) {
    if (!image.stack || image.stack.depth < 2) {
      throw new Error(`3D segmentation requires a multi-page 3D TIFF stack (at least 2 slices); ${name} has ${image.depth}.`);
    }
    const primary = image.stack.channels[settings.channel - 1];
    if (!primary) {
      throw new Error(`${name} has ${image.stack.channels.length} channels; channel ${settings.channel} does not exist.`);
    }
    const nuclear = model.supportsNuclearChannel && settings.nuclearChannel > 0
      ? image.stack.channels[settings.nuclearChannel - 1]
      : null;
    if (model.supportsNuclearChannel && settings.nuclearChannel > 0 && !nuclear) {
      throw new Error(`${name} has ${image.stack.channels.length} channels; nuclear channel ${settings.nuclearChannel} does not exist.`);
    }
    return {
      primary: primary.data,
      nuclear: nuclear ? nuclear.data : null,
      depth: image.stack.depth,
      channelLabel: nuclear ? `${primary.label} + ${nuclear.label}` : primary.label,
    };
  }
  const primary = image.planes[settings.channel - 1];
  if (!primary) {
    throw new Error(`${name} has ${image.planes.length} channels; channel ${settings.channel} does not exist.`);
  }
  const nuclear = model.supportsNuclearChannel && settings.nuclearChannel > 0
    ? image.planes[settings.nuclearChannel - 1]
    : null;
  if (model.supportsNuclearChannel && settings.nuclearChannel > 0 && !nuclear) {
    throw new Error(`${name} has ${image.planes.length} channels; nuclear channel ${settings.nuclearChannel} does not exist.`);
  }
  return {
    primary: primary.data,
    nuclear: nuclear ? nuclear.data : null,
    depth: 1,
    channelLabel: nuclear ? `${primary.label} + ${nuclear.label}` : primary.label,
  };
}

/**
 * Segments one 2D image or 3D TIFF stack with Cellpose 3 (`cyto3` or `nuclei`) and writes
 * label TIFF, per-cell CSV, and provenance JSON atomically into `outputDir`.
 */
export async function segmentFile({
  input,
  outputDir,
  options = {},
  onProgress,
  runBatch,
  renameFn = rename,
  readdirFn = readdir,
} = {}) {
  const parsed = parseCliOptions(options);
  if (!input || !String(input).trim()) throw new Error("Input file path is required.");
  if (!outputDir || !String(outputDir).trim()) throw new Error("Output directory path is required.");

  const { name, buffer } = await readBoundedInputFile(input);
  const image = await readImage(name, buffer);
  const prepared = prepareInputForRun(image, name, parsed.model, parsed.settings);

  const reservation = await claimOutputDir(outputDir, { overwrite: parsed.overwrite, readdirFn });
  let committed = false;
  try {
    const started = performance.now();
    let result;
    let ortVersion = null;

    if (runBatch) {
      result = parsed.settings.do3D
        ? await segment3D(prepared.primary, prepared.nuclear, prepared.depth, image.height, image.width, parsed.model, {
          diameter: parsed.settings.diameter,
          anisotropy: parsed.settings.anisotropy,
          cellprobThresh: parsed.settings.cellprobThresh,
          minSize: parsed.settings.minSize,
          runBatch,
        })
        : await segment2D(prepared.primary, prepared.nuclear, image.height, image.width, parsed.model, {
          diameter: parsed.settings.diameter,
          flowThresh: parsed.settings.flowThresh,
          cellprobThresh: parsed.settings.cellprobThresh,
          minSize: parsed.settings.minSize,
          runBatch,
        });
    } else {
      const asset = MODEL_ASSETS.find((item) => item.filename === parsed.model.filename);
      const modelBytes = await loadModelAsset(asset, {
        cacheDir: parsed.cacheDir,
        offline: parsed.offline,
        onProgress: (msg) => onProgress?.(0.05, msg),
      });
      const ort = await loadOrt();
      ortVersion = ort.env.versions.node;
      const session = await ort.InferenceSession.create(new Uint8Array(modelBytes), {
        executionProviders: ["cpu"],
        graphOptimizationLevel: "all",
        intraOpNumThreads: parsed.threads,
        interOpNumThreads: 1,
      });
      try {
        const execBatch = async (inputData, batchSize, height, width) => {
          const output = await session.run({
            [parsed.model.input]: new ort.Tensor("float32", inputData, [batchSize, parsed.model.channels, height, width]),
          });
          return output.flows.data;
        };
        if (parsed.settings.do3D) {
          result = await segment3D(prepared.primary, prepared.nuclear, prepared.depth, image.height, image.width, parsed.model, {
            diameter: parsed.settings.diameter,
            anisotropy: parsed.settings.anisotropy,
            cellprobThresh: parsed.settings.cellprobThresh,
            minSize: parsed.settings.minSize,
            runBatch: execBatch,
            onPlane: (done, total, axis) => onProgress?.(0.12 + 0.72 * (done / total), `Predicting 3D (${axis}) · ${done} of ${total} slices`),
            onStage: (stage) => onProgress?.(stage === "dynamics" ? 0.86 : 0.94, stage === "dynamics" ? "Following 3D flows…" : "Clustering 3D masks…"),
          });
        } else {
          result = await segment2D(prepared.primary, prepared.nuclear, image.height, image.width, parsed.model, {
            diameter: parsed.settings.diameter,
            flowThresh: parsed.settings.flowThresh,
            cellprobThresh: parsed.settings.cellprobThresh,
            minSize: parsed.settings.minSize,
            runBatch: execBatch,
            onTile: (done, total) => onProgress?.(0.12 + 0.7 * (done / total), total > 1 ? `Predicting · tile ${done} of ${total}` : "Predicting"),
            onStage: (stage) => onProgress?.(stage === "dynamics" ? 0.84 : stage === "masks" ? 0.92 : 0.96, `Stage: ${stage}`),
          });
        }
      } finally {
        await session.release();
      }
    }

    const seconds = Number(((performance.now() - started) / 1000).toFixed(2));
    const base = name.replace(/\.(ome\.)?(tiff?|png)$/i, "");
    const exportSpacing = exportSpacingFor(image, parsed.settings.do3D, parsed.settings.anisotropy);
    const labelsName = outputName(base, "labels.tif");
    const tableName = outputName(base, "cells.csv");
    const provName = outputName(base, "provenance.json");

    const labelsBytes = new Uint8Array(
      writeLabelsTiff(result.labels, image.width, image.height, prepared.depth, exportSpacing),
    );
    const csvText = parsed.settings.do3D ? cellsCsv3D(result.cells) : cellsCsv(result.cells);
    const provenance = {
      app: "cellpose",
      version: packageJson.version,
      input: name,
      model: parsed.model.name,
      do3D: parsed.settings.do3D,
      dimensions: parsed.settings.do3D
        ? { x: image.width, y: image.height, z: prepared.depth }
        : { x: image.width, y: image.height },
      channel: prepared.channelLabel,
      diameter: parsed.settings.diameter,
      flowThresh: parsed.settings.flowThresh,
      cellprobThresh: parsed.settings.cellprobThresh,
      minSize: parsed.settings.minSize,
      anisotropy: parsed.settings.anisotropy,
      count: result.count,
      onnxRuntime: ortVersion,
      threads: parsed.threads,
      seconds,
    };

    const written = await commitOutputs(
      reservation.dir,
      [
        { name: labelsName, data: labelsBytes },
        { name: tableName, data: Buffer.from(csvText, "utf8") },
        { name: provName, data: Buffer.from(`${JSON.stringify(provenance, null, 2)}\n`, "utf8") },
      ],
      { overwrite: parsed.overwrite, renameFn },
    );
    committed = true;

    return {
      outputDir: reservation.dir,
      outputs: written,
      primaryOutput: written[0],
      count: result.count,
      provenance,
      seconds,
    };
  } finally {
    await reservation.release({ removeCreated: !committed });
  }
}

export async function checkInstallation({ cacheDir } = {}) {
  const ort = await loadOrt();
  const session = await ort.InferenceSession.create(IDENTITY_MODEL, { executionProviders: ["cpu"] });
  let output;
  try {
    const { y } = await session.run({ x: new ort.Tensor("float32", Float32Array.of(42), [1]) });
    output = y.data[0];
  } finally {
    await session.release();
  }
  if (output !== 42) throw new Error("ONNX Runtime CPU check failed.");
  const explicitDir = cacheDir ?? process.env.NEURODESK_CELLPOSE_MODEL_DIR;
  const models = explicitDir ? await downloadModels({ cacheDir: explicitDir, offline: true }) : null;
  return {
    ok: true,
    package: packageJson.name,
    version: packageJson.version,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    executable: process.execPath,
    onnxRuntime: ort.env.versions.node,
    executionProvider: "cpu",
    modelIds: [...MODEL_IDS],
    ...(models ? { models } : {}),
  };
}
