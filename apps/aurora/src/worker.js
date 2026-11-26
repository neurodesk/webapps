// AURORA Web Worker: reads the prepared T1c NIfTI, downloads & verifies the pinned ONNX model,
// and runs segmentMetastasis on WebGPU (when a hardware adapter is available) or threaded WASM CPU.
import * as ort from "onnxruntime-web/webgpu";
import wasmURL from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import wasmModuleURL from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import { decodeNiftiBuffer, parseNiftiVolume } from "@neurodesk/webapp-components/file-io/nifti";
import { fetchModel } from "@neurodesk/webapp-components/worker";
import { checkPreparedGrid, segmentMetastasis } from "@neurodesk/aurora";
import { DEFAULT_MODEL_ID, modelById } from "@neurodesk/aurora/models";

ort.env.wasm.wasmPaths = { wasm: wasmURL, mjs: wasmModuleURL };
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(8, navigator.hardwareConcurrency || 1) : 1;

const progress = (value, message) => self.postMessage({ type: "progress", value, message });
const log = (message) => self.postMessage({ type: "log", message });

const DOWNLOAD = 0.15;

async function runInference({ volume, model, bytes, backend, threshold }) {
  log(`AURORA ${model.id} on ${backend === "webgpu" ? "WebGPU" : `WebAssembly, ${ort.env.wasm.numThreads} threads`} (threshold ${threshold.toFixed(2)}, tta=false)`);
  const session = await ort.InferenceSession.create(bytes, { executionProviders: [backend], graphOptimizationLevel: "all" });
  try {
    return await segmentMetastasis({
      volume,
      model,
      threshold,
      runPatch: async (tile) => {
        const input = new ort.Tensor("float32", tile, [1, 1, ...model.patch]);
        let outputs;
        try {
          outputs = await session.run({ [session.inputNames[0]]: input });
          return await outputs[session.outputNames[0]].getData();
        } finally {
          input.dispose();
          for (const output of Object.values(outputs || {})) output.dispose();
        }
      },
      onPatch: (n, total) => progress(DOWNLOAD + (1 - DOWNLOAD) * (n / total), `Segmenting · window ${n} of ${total}`),
    });
  } finally {
    await session.release();
  }
}

// Software adapters (SwiftShader) run 3D U-Nets much slower than threaded WASM, so only use hardware WebGPU.
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

self.onmessage = async ({ data: job }) => {
  try {
    const model = modelById(job.modelId || DEFAULT_MODEL_ID);
    progress(0, "Reading T1c image…");
    const parsed = parseNiftiVolume(await decodeNiftiBuffer(await job.file.arrayBuffer()));
    const volume = {
      data: parsed.imageData,
      dims: parsed.dims,
      affine: parsed.affine,
    };
    const { headerBytes } = parsed;
    checkPreparedGrid(volume, "T1c");
    progress(0, "Downloading the AURORA model…");
    const bytes = await fetchModel({ url: model.url, integrity: { bytes: model.bytes, sha256: model.sha256 } }, {
      onProgress: ({ fraction }) => progress(DOWNLOAD * (fraction || 0), "Downloading the AURORA model…"),
    });
    const started = performance.now();
    let backend = job.backend === "auto" ? await gpuBackend() : "wasm";
    let result;
    try {
      result = await runInference({ volume, model, bytes, backend, threshold: job.threshold });
    } catch (error) {
      if (backend !== "webgpu") throw error;
      log(`WebGPU failed (${error.message}); continuing on the CPU`);
      backend = "wasm";
      result = await runInference({ volume, model, bytes, backend, threshold: job.threshold });
    }
    self.postMessage(
      {
        type: "result",
        labels: result.labels,
        wholeMask: result.wholeMask,
        enhancingMask: result.enhancingMask,
        dims: result.dims,
        affine: result.affine,
        headerBytes,
        provenance: {
          model: { id: model.id, file: model.filename, sha256: model.sha256, network: model.network },
          weights: "BrainLesion AURORA weights v1.0.0 (Zenodo 10557069), t1c-o_best",
          backend,
          tta: false,
          threshold: job.threshold,
          windows: result.windows,
          seconds: Math.round((performance.now() - started) / 100) / 10,
        },
      },
      [result.labels.buffer, result.wholeMask.buffer, result.enhancingMask.buffer, headerBytes],
    );
  } catch (error) {
    self.postMessage({ type: "error", message: error.message || String(error) });
  }
};
