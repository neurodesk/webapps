// InstanSeg Web Worker: downloads & verifies the pinned ONNX backbone, runs brightfield_nuclei
// on WebGPU (when a hardware adapter is available) or threaded WASM CPU, decodes instances, and
// returns the 16/32-bit label map + per-nucleus morphometry rows.
import * as ort from "onnxruntime-web/webgpu";
import wasmURL from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import wasmModuleURL from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import { fetchModel } from "@neurodesk/webapp-components/worker";
import { segmentBrightfieldNuclei } from "@neurodesk/instanseg";
import { DEFAULT_MODEL_ID, modelById } from "@neurodesk/instanseg/models";
import { measureNuclei } from "@neurodesk/instanseg/results";

ort.env.wasm.wasmPaths = { wasm: wasmURL, mjs: wasmModuleURL };
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(8, navigator.hardwareConcurrency || 1) : 1;

const progress = (value, message) => self.postMessage({ type: "progress", value, message });
const log = (message) => self.postMessage({ type: "log", message });

const DOWNLOAD = 0.2;

async function gpuBackend() {
  const adapter = await navigator.gpu?.requestAdapter().catch(() => null);
  if (!adapter) {
    log("No WebGPU adapter; running on the CPU");
    return "wasm";
  }
  if (adapter.info?.isFallbackAdapter) {
    log(`WebGPU offers only a software adapter (${adapter.info.description || adapter.info.vendor || "fallback"}); running on the CPU`);
    return "wasm";
  }
  return "webgpu";
}

async function runInference({ rgbChw, width, height, model, bytes, backend, settings }) {
  log(`InstanSeg ${model.id} on ${backend === "webgpu" ? "WebGPU" : `WebAssembly, ${ort.env.wasm.numThreads} threads`} (${width} × ${height}, pixelSize=${settings.pixelSize ? `${settings.pixelSize.toFixed(3)} µm` : "native 0.5 µm"}, tileSize=${settings.tileSize})`);
  const session = await ort.InferenceSession.create(bytes, { executionProviders: [backend], graphOptimizationLevel: "all" });
  try {
    return await segmentBrightfieldNuclei({
      rgbChw,
      width,
      height,
      pixelSize: settings.pixelSize,
      seedThreshold: settings.seedThreshold,
      maskThreshold: settings.maskThreshold,
      overlapThreshold: settings.overlapThreshold,
      tileSize: settings.tileSize,
      classifier: model.pixelClassifier,
      runFcn: async (padded, paddedH, paddedW) => {
        const input = new ort.Tensor("float32", padded, [1, 3, paddedH, paddedW]);
        let outputs;
        try {
          outputs = await session.run({ [session.inputNames[0]]: input });
          return await outputs[session.outputNames[0]].getData();
        } finally {
          input.dispose();
          for (const output of Object.values(outputs || {})) output.dispose();
        }
      },
      onTile: (n, total) => progress(DOWNLOAD + (1 - DOWNLOAD) * (n / total), total > 1 ? `Segmenting · tile ${n} of ${total}` : "Decoding nuclei…"),
    });
  } finally {
    await session.release();
  }
}

self.onmessage = async ({ data: job }) => {
  try {
    const model = modelById(job.modelId || DEFAULT_MODEL_ID);
    progress(0, "Downloading the InstanSeg model…");
    const bytes = await fetchModel(
      { url: model.url, integrity: { bytes: model.bytes, sha256: model.sha256 } },
      { onProgress: ({ fraction }) => progress(DOWNLOAD * (fraction || 0), "Downloading the InstanSeg model…") },
    );
    const started = performance.now();
    let backend = job.settings.backend === "auto" ? await gpuBackend() : "wasm";
    let result;
    try {
      result = await runInference({
        rgbChw: job.rgbChw,
        width: job.width,
        height: job.height,
        model,
        bytes,
        backend,
        settings: job.settings,
      });
    } catch (error) {
      if (backend !== "webgpu") throw error;
      log(`WebGPU failed (${error.message}); continuing on the CPU`);
      backend = "wasm";
      result = await runInference({
        rgbChw: job.rgbChw,
        width: job.width,
        height: job.height,
        model,
        bytes,
        backend,
        settings: job.settings,
      });
    }
    const nuclei = measureNuclei(result.labels, result.width, result.height, job.settings.pixelSize);
    self.postMessage(
      {
        type: "result",
        labels: result.labels,
        width: result.width,
        height: result.height,
        nuclei,
        provenance: {
          model: { id: model.id, file: model.filename, sha256: model.sha256, pixelSize: model.pixel_size },
          backend,
          tiles: result.tiles,
          rescaled: result.rescaled,
          scaledDims: [result.scaledWidth, result.scaledHeight],
          settings: job.settings,
          nucleiCount: nuclei.length,
          seconds: Math.round((performance.now() - started) / 100) / 10,
        },
      },
      [result.labels.buffer],
    );
  } catch (error) {
    self.postMessage({ type: "error", message: error.message || String(error) });
  }
};
