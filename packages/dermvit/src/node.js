// Node command-line adapter for @neurodesk/dermvit.
// Runs the exact same preprocessing, quantized ViT ONNX model, softmax statistics,
// optional 5x5 occlusion sensitivity, and output serializers as the DermViT web app.
import "./ort-env.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, lstat, open, readFile, readdir, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { availableParallelism, homedir } from "node:os";
import { join, resolve } from "node:path";
import * as ort from "onnxruntime-node";
import manifest from "../model.manifest.json" with { type: "json" };
import packageJson from "../package.json" with { type: "json" };
import {
  MAX_DECODED_BYTES,
  MODEL,
  OCCLUSION_GRID,
  SALIENCY_EXPORT_MAX_SIDE,
  SALIENCY_EXPORT_OPACITY,
  buildProvenance,
  computeBoundedDimensions,
} from "./config.js";
import {
  computeOcclusionSensitivity,
  normalizeInputRgba,
  preprocessToTensor,
  resizeRgbaPillowBilinear,
  summarizePredictions,
  upsampleSaliency,
  validateLogits,
} from "./core/vit.js";
import { encodeSaliencyPng, outputStem, predictionsCsv, provenanceJson } from "./outputs.js";
import { readRasterImageFile } from "./raster.js";

export const MODEL_ASSETS = manifest.assets;

// A one-node ONNX graph (Identity, float32[1], opset 13) proves the native CPU runtime executes.
const IDENTITY_MODEL = Buffer.from("CAc6NwoQCgF4EgF5IghJZGVudGl0eRIBZ1oPCgF4EgoKCAgBEgQKAggBYg8KAXkSCgoICAESBAoCCAFCAhAN", "base64");

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const offlineByDefault = () => process.env.NEURODESK_OFFLINE === "1";

export function defaultCacheDir() {
  if (process.env.NEURODESK_DERMVIT_MODEL_DIR) return process.env.NEURODESK_DERMVIT_MODEL_DIR;
  const cache = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(cache, "neurodesk", "dermvit", manifest.revision);
}

function resolveCacheDir(cacheDir) {
  if (cacheDir === undefined) return defaultCacheDir();
  if (typeof cacheDir !== "string" || cacheDir.trim() === "") {
    throw new Error("--cache-dir requires a non-empty directory path.");
  }
  return cacheDir;
}

function installedSha256(assets) {
  const entries = assets.map(({ filename, sha256: digest }) => [filename, digest]).sort(([a], [b]) => (a < b ? -1 : 1));
  return sha256(JSON.stringify(Object.fromEntries(entries)));
}

async function writeAtomically(filePath, bytes) {
  const partial = `${filePath}.${randomUUID()}.partial`;
  try {
    await writeFile(partial, bytes, { flag: "wx" });
    await rename(partial, filePath);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}

export const SHARED_OUTPUT_LOCK = ".neurodesk-cli.lock";

export async function reserveOutputDir(outputDir, { overwrite = false, tool = "dermvit" } = {}) {
  const dir = resolve(outputDir);
  let createdDir = false;
  try {
    const info = await stat(dir);
    if (!info.isDirectory()) {
      throw new Error(`Output path ${dir} exists and is not a directory.`);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await mkdir(dir, { recursive: true });
    createdDir = true;
  }

  const lockName = SHARED_OUTPUT_LOCK;
  const lockPath = join(dir, lockName);
  let handle;
  try {
    handle = await open(lockPath, "wx");
  } catch (error) {
    if (createdDir) {
      await rmdir(dir).catch(() => {});
    }
    if (error.code === "EEXIST") {
      throw new Error(
        `Output directory ${dir} is locked by another Neurodesk CLI run (${lockName}). Wait for it to finish or remove a stale lock file.`,
      );
    }
    throw error;
  }

  let released = false;
  const release = async ({ removeIfEmpty = false } = {}) => {
    if (released) return;
    released = true;
    await rm(lockPath, { force: true }).catch(() => {});
    if (removeIfEmpty && createdDir) {
      const remaining = await readdir(dir).catch(() => null);
      if (remaining && remaining.length === 0) {
        await rmdir(dir).catch(() => {});
      }
    }
  };

  try {
    const meta = JSON.stringify({ pid: process.pid, tool, startedAt: new Date().toISOString() });
    await handle.writeFile(`${meta}\n`, "utf8");
    await handle.close();
    handle = null;

    const entries = await readdir(dir);
    const others = entries.filter((entry) => entry !== lockName);
    if (!overwrite && others.length > 0) {
      throw new Error(`Output directory ${dir} is not empty. Choose a new directory or pass --overwrite.`);
    }
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await release({ removeIfEmpty: true });
    throw error;
  }

  return { dir, lockPath, createdDir, release };
}

export async function publishOutputs(
  dir,
  files,
  { overwrite = false, writeFileImpl = writeFile, renameImpl = rename } = {},
) {
  const token = randomUUID();
  const staged = [];
  const backups = [];
  const committed = [];

  try {
    for (const { name, bytes } of files) {
      const target = join(dir, name);
      const partial = join(dir, `.${name}.${token}.partial`);
      const item = { name, target, partial, moved: false };
      staged.push(item);
      await writeFileImpl(partial, bytes, { flag: "wx" });
    }

    for (const item of staged) {
      let existingInfo = null;
      try {
        existingInfo = await lstat(item.target);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (existingInfo) {
        if (existingInfo.isDirectory()) {
          throw new Error(`Output file path ${item.target} is a directory.`);
        }
        if (!overwrite) {
          throw new Error(`Output file ${item.target} already exists. Pass --overwrite to replace it.`);
        }
        const backup = join(dir, `.${item.name}.${token}.backup`);
        await renameImpl(item.target, backup);
        backups.push({ target: item.target, backup });
      }
      await renameImpl(item.partial, item.target);
      item.moved = true;
      committed.push(item.target);
    }

    for (const { backup } of backups) {
      await rm(backup, { force: true }).catch(() => {});
    }
    return committed;
  } catch (error) {
    const backedUpTargets = new Set(backups.map((b) => b.target));
    for (const target of [...committed].reverse()) {
      if (!backedUpTargets.has(target)) {
        await rm(target, { force: true }).catch(() => {});
      }
    }
    for (const { target, backup } of [...backups].reverse()) {
      await renameImpl(backup, target).catch(() => {});
    }
    for (const item of staged) {
      if (!item.moved) {
        await rm(item.partial, { force: true }).catch(() => {});
      }
    }
    throw error;
  }
}

async function loadAsset(asset, { cacheDir, offline, onProgress }) {
  const filePath = join(cacheDir, asset.filename);
  const verified = (bytes) => bytes.length === asset.bytes && sha256(bytes) === asset.sha256;
  let bytes;
  try {
    bytes = await readFile(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (bytes) {
    if (!verified(bytes)) {
      throw new Error(`Cached ${asset.filename} failed checksum verification. Delete ${filePath} and download it again.`);
    }
    return bytes;
  }
  if (offline) {
    throw new Error(
      `${asset.filename} is missing from the offline model directory ${cacheDir}. Run "dermvit download-models" while online, or reinstall the complete release.`,
    );
  }
  onProgress?.(`Downloading ${asset.filename}…`);
  const response = await fetch(new URL(asset.filename, manifest.base_url));
  if (!response.ok) throw new Error(`Failed to download ${asset.filename}: HTTP ${response.status}`);
  bytes = Buffer.from(await response.arrayBuffer());
  if (!verified(bytes)) throw new Error(`${asset.filename} download failed checksum verification.`);
  await mkdir(cacheDir, { recursive: true });
  await writeAtomically(filePath, bytes);
  return bytes;
}

export async function downloadModels({
  cacheDir,
  offline = offlineByDefault(),
  onProgress = () => {},
} = {}) {
  const resolvedCache = resolveCacheDir(cacheDir);
  for (const asset of MODEL_ASSETS) {
    await loadAsset(asset, { cacheDir: resolvedCache, offline, onProgress });
  }
  return {
    directory: resolve(resolvedCache),
    count: MODEL_ASSETS.length,
    installedSha256: installedSha256(MODEL_ASSETS),
  };
}

export function resolveThreads(value = process.env.SLURM_CPUS_PER_TASK || availableParallelism()) {
  const threads = typeof value === "string" && /^[1-9]\d*$/.test(value.trim()) ? Number(value.trim()) : value;
  if (!Number.isSafeInteger(threads) || threads < 1) {
    throw new Error(`Threads must be a positive integer, not "${value}".`);
  }
  return threads;
}

async function runForward(session, tensor) {
  const inputTensor = new ort.Tensor("float32", tensor, [1, 3, MODEL.imageSize, MODEL.imageSize]);
  let outputs = null;
  try {
    outputs = await session.run({ [MODEL.input]: inputTensor });
    const logitsTensor = outputs[MODEL.output];
    if (!logitsTensor) throw new Error(`Model output "${MODEL.output}" not found.`);
    const data = logitsTensor.data;
    const copied = data instanceof Float32Array ? new Float32Array(data) : Float32Array.from(data);
    return validateLogits(copied, MODEL.classes.length);
  } finally {
    inputTensor.dispose?.();
    if (outputs) {
      for (const outputTensor of Object.values(outputs)) {
        outputTensor?.dispose?.();
      }
    }
  }
}

export async function checkInstallation({ cacheDir } = {}) {
  const checkDir = cacheDir !== undefined ? resolveCacheDir(cacheDir) : process.env.NEURODESK_DERMVIT_MODEL_DIR;
  const session = await ort.InferenceSession.create(IDENTITY_MODEL, { executionProviders: ["cpu"] });
  try {
    const { y } = await session.run({ x: new ort.Tensor("float32", Float32Array.of(42), [1]) });
    if (y.data[0] !== 42) throw new Error("ONNX Runtime CPU check failed.");
  } finally {
    await session.release();
  }
  const models = checkDir ? await downloadModels({ cacheDir: checkDir, offline: true }) : null;
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
    ...(models ? { models } : {}),
  };
}

export async function classifyFile({
  input,
  outputDir,
  colorConstancy = false,
  computeSaliency = false,
  threads,
  cacheDir,
  offline = offlineByDefault(),
  overwrite = false,
  onProgress = () => {},
} = {}) {
  if (!input || !outputDir || String(input).trim() === "" || String(outputDir).trim() === "") {
    throw new Error("Provide an input JPEG/PNG image and an output directory.");
  }
  const started = performance.now();
  const intraOpNumThreads = resolveThreads(threads);
  const resolvedCache = resolveCacheDir(cacheDir);
  const reservation = await reserveOutputDir(outputDir, { overwrite, tool: "dermvit" });
  let published = false;

  try {
    onProgress(0.05, "Decoding input image…");
    const decoded = await readRasterImageFile(resolve(input), { maxBytes: MAX_DECODED_BYTES });
    const normalized = normalizeInputRgba(decoded.rgba, decoded.width, decoded.height);

    onProgress(0.15, "Loading verified DermViT ONNX model…");
    const modelBytes = await loadAsset(MODEL_ASSETS[0], {
      cacheDir: resolvedCache,
      offline,
      onProgress: (message) => onProgress(0.2, message),
    });

    onProgress(0.35, "Preprocessing dermoscopy image (224 × 224)…");
    const { tensor, colorConstancyGains } = preprocessToTensor(normalized.rgba, decoded.width, decoded.height, {
      size: MODEL.imageSize,
      mean: MODEL.mean,
      std: MODEL.std,
      colorConstancy: Boolean(colorConstancy),
    });

    onProgress(0.45, "Initializing ONNX Runtime CPU session…");
    const inferStart = performance.now();
    const session = await ort.InferenceSession.create(new Uint8Array(modelBytes), {
      executionProviders: ["cpu"],
      graphOptimizationLevel: "all",
      intraOpNumThreads,
      interOpNumThreads: 1,
    });

    let summary;
    let saliency = null;
    let saliencyPng = null;
    try {
      onProgress(0.55, "Running Vision Transformer inference…");
      const logits = await runForward(session, tensor);
      summary = summarizePredictions(logits, MODEL.classes);

      if (computeSaliency) {
        const grid = OCCLUSION_GRID;
        const occlusion = await computeOcclusionSensitivity(
          tensor,
          summary,
          (occludedTensor) => runForward(session, occludedTensor),
          {
            size: MODEL.imageSize,
            grid,
            onProgress: (done, total) => {
              onProgress(0.6 + 0.32 * (done / total), `Computing occlusion sensitivity · ${done} / ${total}`);
            },
          },
        );
        const exportDims = computeBoundedDimensions(decoded.width, decoded.height, SALIENCY_EXPORT_MAX_SIDE);
        const exportRgba =
          exportDims.width === decoded.width && exportDims.height === decoded.height
            ? normalized.rgba
            : resizeRgbaPillowBilinear(normalized.rgba, decoded.width, decoded.height, exportDims.width, exportDims.height);
        const exportMap = upsampleSaliency(occlusion.normalized, grid, exportDims.width, exportDims.height);
        saliencyPng = encodeSaliencyPng(
          exportRgba,
          exportMap,
          exportDims.width,
          exportDims.height,
          SALIENCY_EXPORT_OPACITY,
        );
        saliency = {
          grid,
          raw: Array.from(occlusion.raw),
          normalized: Array.from(occlusion.normalized),
          maxDrop: occlusion.maxDrop,
          topClassCode: occlusion.topClassCode,
          topClassIndex: occlusion.topClassIndex,
          exportWidth: exportDims.width,
          exportHeight: exportDims.height,
          exportOpacity: SALIENCY_EXPORT_OPACITY,
        };
      }
    } finally {
      await session.release();
    }

    const inferenceSeconds = (performance.now() - inferStart) / 1000;
    const totalSeconds = (performance.now() - started) / 1000;
    const settings = {
      backend: "cpu",
      colorConstancy: Boolean(colorConstancy),
      computeSaliency: Boolean(computeSaliency),
    };
    const record = buildProvenance({
      file: { name: decoded.name, size: decoded.size },
      width: decoded.width,
      height: decoded.height,
      format: decoded.format,
      alphaComposited: normalized.hadTransparency,
      settings,
      result: {
        summary,
        backend: "cpu",
        threads: intraOpNumThreads,
        ortVersion: ort.env.versions.node,
        inferenceSeconds,
        colorConstancyGains,
        saliency,
      },
      seconds: totalSeconds,
    });

    const stem = outputStem(decoded.name);
    const filesToPublish = [
      {
        name: `${stem}_dermvit-predictions.csv`,
        bytes: Buffer.from(predictionsCsv(summary, decoded.name), "utf8"),
      },
      {
        name: `${stem}_dermvit-provenance.json`,
        bytes: Buffer.from(provenanceJson(record), "utf8"),
      },
    ];
    if (saliencyPng) {
      filesToPublish.push({
        name: `${stem}_dermvit-saliency.png`,
        bytes: saliencyPng,
      });
    }

    const outputs = await publishOutputs(reservation.dir, filesToPublish, { overwrite });
    published = true;

    onProgress(1, "Classification complete");
    return {
      outputDir: reservation.dir,
      outputs,
      primaryOutput: outputs[0],
      summary,
      provenance: record,
      seconds: totalSeconds,
    };
  } finally {
    await reservation.release({ removeIfEmpty: !published });
  }
}
