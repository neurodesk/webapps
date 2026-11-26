// DermViT inference worker: downloads (or reuses from verified browser cache) the
// pinned HAM10000 quantized ViT ONNX model, caches the ONNX Runtime Web session across
// runs on the same backend, runs classification, optionally computes a 5x5 occlusion
// sensitivity map (Zeiler & Fergus, 2014), and encodes bounded-resolution saliency PNGs.
import * as ort from "onnxruntime-web/webgpu";
import wasmURL from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import wasmModuleURL from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import { fetchModel } from "@neurodesk/webapp-components/worker";
import {
  MODEL,
  OCCLUSION_GRID,
  SALIENCY_EXPORT_MAX_SIDE,
  SALIENCY_EXPORT_OPACITY,
  computeBoundedDimensions,
} from "./config.js";
import {
  computeOcclusionSensitivity,
  preprocessToTensor,
  resizeRgbaPillowBilinear,
  summarizePredictions,
  upsampleSaliency,
  validateLogits,
} from "@neurodesk/dermvit/core/vit";
import { encodeSaliencyPng } from "./outputs.js";

ort.env.wasm.wasmPaths = { wasm: wasmURL, mjs: wasmModuleURL };
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(8, navigator.hardwareConcurrency || 1) : 1;

let cachedModelBytes = null;
let cachedSession = null;
let cachedBackend = null;
let cachedAutoBackend = null;

const progress = (value, message) => self.postMessage({ type: "progress", value, message });
const log = (message) => self.postMessage({ type: "log", message });

async function ensureModelBytes(reportProgress) {
  if (cachedModelBytes) return cachedModelBytes;
  reportProgress(0, "Downloading DermViT model…");
  const started = performance.now();
  const bytes = await fetchModel(
    { url: MODEL.url, integrity: { bytes: MODEL.bytes, sha256: MODEL.sha256 } },
    {
      onProgress: ({ fraction }) => {
        const pct = Math.floor(100 * (fraction || 0));
        reportProgress(0.45 * (fraction || 0), `Downloading DermViT model · ${pct} %`);
      },
      requestFailureMessage: "Could not download the DermViT model. Check your connection and try again.",
    },
  );
  cachedModelBytes = bytes;
  const elapsed = ((performance.now() - started) / 1000).toFixed(1);
  log(`Model ${MODEL.filename} (${(bytes.byteLength / (1024 * 1024)).toFixed(1)} MB) verified in ${elapsed} s`);
  return cachedModelBytes;
}

async function hasWebGpu() {
  if (!navigator.gpu) return false;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    return Boolean(adapter);
  } catch {
    return false;
  }
}

async function ensureSession(backend, reportProgress, initProgress = 0.52) {
  if (cachedSession && cachedBackend === backend) return cachedSession;
  if (cachedSession) {
    try {
      await cachedSession.release();
    } catch {
      // Ignore release failures when switching backends.
    }
    cachedSession = null;
    cachedBackend = null;
  }
  const bytes = await ensureModelBytes(reportProgress);
  reportProgress(initProgress, `Initializing ${backend === "webgpu" ? "WebGPU" : "WebAssembly"} session…`);
  const session = await ort.InferenceSession.create(bytes, {
    executionProviders: [backend],
    graphOptimizationLevel: "all",
  });
  cachedSession = session;
  cachedBackend = backend;
  return session;
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

async function runWithBackendFallback(requestedBackend, tensor, reportProgress) {
  let target = requestedBackend;
  if (target === "auto") {
    if (cachedAutoBackend) {
      target = cachedAutoBackend;
    } else {
      target = (await hasWebGpu()) ? "webgpu" : "wasm";
      if (target === "wasm") {
        cachedAutoBackend = "wasm";
      }
    }
  }

  try {
    const session = await ensureSession(target, reportProgress, 0.52);
    reportProgress(0.6, "Running Vision Transformer inference…");
    const logits = await runForward(session, tensor);
    if (requestedBackend === "auto") {
      cachedAutoBackend = target;
    }
    return { session, backend: target, logits };
  } catch (error) {
    if (requestedBackend !== "auto" || target !== "webgpu") {
      throw error;
    }
    log(`WebGPU unavailable or unsupported for quantized ViT (${error.message}); falling back to WebAssembly`);
    cachedAutoBackend = "wasm";
    const session = await ensureSession("wasm", reportProgress, 0.55);
    reportProgress(0.6, "Running Vision Transformer inference…");
    const logits = await runForward(session, tensor);
    return { session, backend: "wasm", logits };
  }
}

async function handleClassify({ id, rgba, width, height, backend, colorConstancy, computeSaliency }) {
  let lastProgress = 0;
  const reportProgress = (value, message) => {
    const clamped = Math.max(lastProgress, Math.min(0.99, value));
    lastProgress = clamped;
    progress(clamped, message);
  };

  await ensureModelBytes(reportProgress);
  reportProgress(0.48, "Preprocessing dermoscopy image (224 × 224)…");
  const { tensor, colorConstancyGains } = preprocessToTensor(rgba, width, height, {
    size: MODEL.imageSize,
    mean: MODEL.mean,
    std: MODEL.std,
    colorConstancy,
  });

  const inferStart = performance.now();
  const { session, backend: actualBackend, logits } = await runWithBackendFallback(
    backend,
    tensor,
    reportProgress,
  );
  const summary = summarizePredictions(logits, MODEL.classes);
  const ortVersion = ort.env.versions?.web ?? "";
  const threads = actualBackend === "wasm" ? ort.env.wasm.numThreads : 1;

  let saliency = null;
  let saliencyMap = null;
  let saliencyPng = null;
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
          reportProgress(0.62 + 0.32 * (done / total), `Computing occlusion sensitivity · ${done} / ${total}`);
        },
      },
    );
    saliencyMap = upsampleSaliency(occlusion.normalized, grid, width, height);

    reportProgress(0.96, "Encoding saliency overlay PNG…");
    const exportDims = computeBoundedDimensions(width, height, SALIENCY_EXPORT_MAX_SIDE);
    const exportRgba =
      exportDims.width === width && exportDims.height === height
        ? rgba
        : resizeRgbaPillowBilinear(rgba, width, height, exportDims.width, exportDims.height);
    const exportMap =
      exportDims.width === width && exportDims.height === height
        ? saliencyMap
        : upsampleSaliency(occlusion.normalized, grid, exportDims.width, exportDims.height);
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

  const inferenceSeconds = (performance.now() - inferStart) / 1000;
  log(
    `Inference on ${actualBackend === "webgpu" ? "WebGPU" : `WebAssembly, ${threads} thread${threads === 1 ? "" : "s"}`} in ${inferenceSeconds.toFixed(2)} s (ONNX Runtime Web ${ortVersion})`,
  );

  const payload = {
    type: "result",
    id,
    result: {
      summary,
      backend: actualBackend,
      threads,
      ortVersion,
      inferenceSeconds,
      colorConstancyGains,
      saliency,
      saliencyMap,
      saliencyPng,
    },
  };
  const transfer = [];
  if (saliencyMap) transfer.push(saliencyMap.buffer);
  if (saliencyPng) transfer.push(saliencyPng.buffer);
  self.postMessage(payload, transfer);
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === "classify") {
      await handleClassify(data);
    } else {
      throw new Error(`Unknown worker message type: ${data.type}`);
    }
  } catch (error) {
    self.postMessage({ type: "error", id: data.id, message: error.message || String(error) });
  }
};
