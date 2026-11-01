import * as ort from "onnxruntime-web/webgpu";
import wasmURL from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import wasmModuleURL from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import { fetchModel } from "@neurodesk/webapp-components/worker";
import { IMG_SIZE } from "@neurodesk/brainqcnet/slices";
import { INPUT_NAME, MODEL, OUTPUT_NAME, readVolume, runBrainQCNet } from "@neurodesk/brainqcnet";

ort.env.wasm.wasmPaths = { wasm: wasmURL, mjs: wasmModuleURL };
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(8, navigator.hardwareConcurrency || 1) : 1;

const BATCH_SIZE = 4;
const BACKEND_LABELS = { webgpu: "WebGPU", wasm: "WebAssembly" };

const progress = (value, message) => self.postMessage({ type: "progress", value, message });
const log = (message) => self.postMessage({ type: "log", message });

async function classifyAll(model, backend, volume, { method, areas }) {
  const session = await ort.InferenceSession.create(model, { executionProviders: [backend], graphOptimizationLevel: "all" });
  log(`BrainQCNet on ${backend === "wasm" ? `WebAssembly, ${ort.env.wasm.numThreads} threads` : BACKEND_LABELS[backend]}`);
  const classify = async (data, count) => {
    const tensor = new ort.Tensor("float32", data, [count, 3, IMG_SIZE, IMG_SIZE]);
    const output = await session.run({ [INPUT_NAME]: tensor });
    return output[OUTPUT_NAME].data;
  };
  const started = performance.now();
  try {
    const result = await runBrainQCNet(volume, {
      classify,
      batchSize: BATCH_SIZE,
      method,
      areas,
      onProgress: (done, total) => progress(0.1 + 0.9 * done / total, `Classifying slices · ${done} of ${total}`),
    });
    return { ...result, seconds: (performance.now() - started) / 1000 };
  } finally {
    await session.release();
  }
}

self.onmessage = async ({ data: job }) => {
  try {
    progress(0, "Reading the T1-weighted image…");
    const volume = await readVolume(job.bytes);
    progress(0.01, "Downloading the BrainQCNet model…");
    const fetched = performance.now();
    const model = await fetchModel({ url: MODEL.url, integrity: { bytes: MODEL.bytes, sha256: MODEL.sha256 } }, {
      onProgress: ({ fraction }) => progress(0.01 + 0.09 * (fraction || 0), `Downloading the BrainQCNet model · ${Math.floor(100 * (fraction || 0))} %`),
    });
    log(`BrainQCNet model ready in ${((performance.now() - fetched) / 1000).toFixed(1)} s`);
    let backend = job.backend;
    let result;
    try {
      result = await classifyAll(model, backend, volume, job);
    } catch (error) {
      if (backend !== "webgpu") throw error;
      log(`WebGPU failed (${error.message}); continuing on the CPU`);
      backend = "wasm";
      result = await classifyAll(model, backend, volume, job);
    }
    self.postMessage({ type: "result", dims: volume.dims, backend, ...result });
  } catch (error) {
    self.postMessage({ type: "error", message: error.message || String(error) });
  }
};
