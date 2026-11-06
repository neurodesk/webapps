// The GlioMODA worker: reads the images, downloads and checks the model, then runs
// segmentGlioma with ONNX Runtime Web on WebGPU, or on the CPU when WebGPU is missing or fails.
//   in:  { files: { role: File }, modelId, mirror, backend }
//   out: { type: 'progress', value, message } | { type: 'log', message }
//        | { type: 'result', labels, dims, affine, provenance } | { type: 'error', message }
import * as ort from "onnxruntime-web/webgpu";
import wasmURL from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import wasmModuleURL from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import { readVolume } from "@neurodesk/synthsr";
import { fetchModel } from "@neurodesk/webapp-components/worker";
import { checkAtlasGrid, segmentGlioma } from "@neurodesk/gliomoda";
import { modelById } from "@neurodesk/gliomoda/models";

ort.env.wasm.wasmPaths = { wasm: wasmURL, mjs: wasmModuleURL };
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(8, navigator.hardwareConcurrency || 1) : 1;

const progress = (value, message) => self.postMessage({ type: "progress", value, message });
const log = (message) => self.postMessage({ type: "log", message });

const DOWNLOAD = 0.15;

async function segment({ volumes, model, bytes, backend, mirror }) {
  log(`GlioMODA ${model.id} on ${backend === "webgpu" ? "WebGPU" : `WebAssembly, ${ort.env.wasm.numThreads} threads`}${mirror ? ", with mirroring" : ""}`);
  const session = await ort.InferenceSession.create(bytes, { executionProviders: [backend], graphOptimizationLevel: "all" });
  try {
    return await segmentGlioma({
      volumes,
      model,
      mirror,
      runPatch: async (tile) => {
        const input = new ort.Tensor("float32", tile, [1, model.channels.length, ...model.patch]);
        let outputs;
        try {
          outputs = await session.run({ [session.inputNames[0]]: input });
          return await outputs[session.outputNames[0]].getData();
        } finally {
          input.dispose();
          for (const output of Object.values(outputs || {})) output.dispose();
        }
      },
      onPatch: (n, total) => progress(DOWNLOAD + (1 - DOWNLOAD) * n / total, `Segmenting · pass ${n} of ${total}`),
    });
  } finally {
    await session.release();
  }
}

// A software adapter (SwiftShader in headless Chrome and on machines without a GPU driver) runs
// a 3D U-Net many times slower than WebAssembly, so only a hardware adapter selects WebGPU.
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
    const model = modelById(job.modelId);
    progress(0, "Reading the images…");
    const volumes = {};
    for (const role of model.channels) {
      volumes[role] = readVolume(await job.files[role].arrayBuffer());
      checkAtlasGrid(role, volumes[role]);
    }
    progress(0, "Downloading the GlioMODA model…");
    const bytes = await fetchModel({ url: model.url, integrity: { bytes: model.bytes, sha256: model.sha256 } }, {
      onProgress: ({ fraction }) => progress(DOWNLOAD * (fraction || 0), "Downloading the GlioMODA model…"),
    });
    const started = performance.now();
    let backend = job.backend === "auto" ? await gpuBackend() : "wasm";
    let result;
    try {
      result = await segment({ volumes, model, bytes, backend, mirror: job.mirror });
    } catch (error) {
      if (backend !== "webgpu") throw error;
      log(`WebGPU failed (${error.message}); continuing on the CPU`);
      backend = "wasm";
      result = await segment({ volumes, model, bytes, backend, mirror: job.mirror });
    }
    self.postMessage({
      type: "result",
      labels: result.labels,
      dims: result.dims,
      affine: result.affine,
      provenance: {
        model: { id: model.id, file: model.filename, sha256: model.sha256, network: model.network },
        weights: "GlioMODA weights v1.0.2 (Zenodo 15625233), fold_all",
        backend,
        mirroring: job.mirror,
        windows: result.windows,
        passes: result.passes,
        seconds: Math.round((performance.now() - started) / 100) / 10,
      },
    }, [result.labels.buffer]);
  } catch (error) {
    self.postMessage({ type: "error", message: error.message || String(error) });
  }
};
