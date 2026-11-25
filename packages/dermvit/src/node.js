// Node command-line adapter for @neurodesk/dermvit.
// Runs the exact same preprocessing, quantized ViT ONNX model, softmax statistics,
// optional 5x5 occlusion sensitivity, and output serializers as the DermViT web app.
import "./ort-env.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
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
  cacheDir = defaultCacheDir(),
  offline = offlineByDefault(),
  onProgress = () => {},
} = {}) {
  for (const asset of MODEL_ASSETS) {
    await loadAsset(asset, { cacheDir, offline, onProgress });
  }
  return {
    directory: resolve(cacheDir),
    count: MODEL_ASSETS.length,
    installedSha256: installedSha256(MODEL_ASSETS),
  };
}

export function resolveThreads(value = process.env.SLURM_CPUS_PER_TASK || availableParallelism()) {
  const threads = typeof value === "string" && /^[1-9]\d*$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(threads) || threads < 1) {
    throw new Error(`Threads must be a positive integer, not "${value}".`);
  }
  return threads;
}

async function assertOutputDir(directory, { overwrite = false } = {}) {
  let entries;
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (!overwrite && entries.length > 0) {
    throw new Error(`Output directory ${directory} is not empty. Choose a new directory or pass --overwrite.`);
  }
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

export async function checkInstallation() {
  const session = await ort.InferenceSession.create(IDENTITY_MODEL, { executionProviders: ["cpu"] });
  try {
    const { y } = await session.run({ x: new ort.Tensor("float32", Float32Array.of(42), [1]) });
    if (y.data[0] !== 42) throw new Error("ONNX Runtime CPU check failed.");
  } finally {
    await session.release();
  }
  const models = process.env.NEURODESK_DERMVIT_MODEL_DIR ? await downloadModels({ offline: true }) : null;
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
  cacheDir = defaultCacheDir(),
  offline = offlineByDefault(),
  overwrite = false,
  onProgress = () => {},
} = {}) {
  if (!input || !outputDir) {
    throw new Error("Provide an input JPEG/PNG image and an output directory.");
  }
  const started = performance.now();
  const intraOpNumThreads = resolveThreads(threads);
  const destination = resolve(outputDir);
  await assertOutputDir(destination, { overwrite });

  onProgress(0.05, "Decoding input image…");
  const decoded = await readRasterImageFile(resolve(input), { maxBytes: MAX_DECODED_BYTES });
  const normalized = normalizeInputRgba(decoded.rgba, decoded.width, decoded.height);

  onProgress(0.15, "Loading verified DermViT ONNX model…");
  const modelBytes = await loadAsset(MODEL_ASSETS[0], {
    cacheDir,
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
  await mkdir(destination, { recursive: true });
  const csvPath = join(destination, `${stem}_dermvit-predictions.csv`);
  const jsonPath = join(destination, `${stem}_dermvit-provenance.json`);
  const outputs = [csvPath, jsonPath];
  await writeAtomically(csvPath, Buffer.from(predictionsCsv(summary), "utf8"));
  await writeAtomically(jsonPath, Buffer.from(provenanceJson(record), "utf8"));
  if (saliencyPng) {
    const saliencyPath = join(destination, `${stem}_dermvit-saliency.png`);
    await writeAtomically(saliencyPath, saliencyPng);
    outputs.push(saliencyPath);
  }
  onProgress(1, "Classification complete");

  return {
    outputDir: destination,
    outputs,
    primaryOutput: csvPath,
    summary,
    provenance: record,
    seconds: totalSeconds,
  };
}
