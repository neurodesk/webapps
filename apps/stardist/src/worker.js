// One StarDist run: download (or reuse) the checksummed ONNX model, predict on the WebAssembly
// backend tile by tile, then NMS, labels and measurements in src/stardist.js. The page starts a
// new worker per run and terminates it to cancel.
import * as ort from "onnxruntime-web/webgpu";
import wasmURL from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import wasmModuleURL from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import { fetchModel } from "@neurodesk/webapp-components/worker";
import { MODEL } from "./config.js";
import { segment } from "./stardist.js";

ort.env.wasm.wasmPaths = { wasm: wasmURL, mjs: wasmModuleURL };
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(8, navigator.hardwareConcurrency || 1) : 1;

const progress = (value, message) => self.postMessage({ type: "progress", value, message });
const log = (message) => self.postMessage({ type: "log", message });

self.onmessage = async ({ data: job }) => {
  try {
    progress(0, "Downloading the StarDist model…");
    const fetched = performance.now();
    const model = await fetchModel({ url: MODEL.url, integrity: { bytes: MODEL.bytes, sha256: MODEL.sha256 } }, {
      onProgress: ({ fraction }) => progress(0.1 * (fraction || 0), `Downloading the StarDist model · ${Math.floor(100 * (fraction || 0))} %`),
    });
    log(`Model ${MODEL.name} ready in ${((performance.now() - fetched) / 1000).toFixed(1)} s`);
    const session = await ort.InferenceSession.create(model, { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
    log(`ONNX Runtime ${ort.env.versions?.web ?? ""} on WebAssembly, ${ort.env.wasm.numThreads} threads`);
    const started = performance.now();
    const run = async (tile, height, width) => {
      const output = await session.run({ [MODEL.input]: new ort.Tensor("float32", tile, [1, height, width, 1]) });
      return { prob: output.prob.data, dist: output.dist.data };
    };
    try {
      const result = await segment(job.image, job.height, job.width, MODEL, {
        pmin: MODEL.normalization.pmin,
        pmax: MODEL.normalization.pmax,
        probThresh: job.probThresh,
        nmsThresh: job.nmsThresh,
        nTiles: job.nTiles,
        run,
        onTile: (done, total) => progress(0.1 + 0.8 * done / total, total > 1 ? `Predicting · tile ${done} of ${total}` : "Predicting"),
        onStage: (stage, count) => {
          if (stage === "nms") {
            log(`${count} candidate polygons above probability ${job.probThresh}`);
            progress(0.9, "Suppressing overlapping polygons…");
          } else {
            progress(0.97, `Drawing ${count} nuclei…`);
          }
        },
      });
      const seconds = (performance.now() - started) / 1000;
      self.postMessage({ type: "result", seconds, ...result }, [result.labels.buffer]);
    } finally {
      await session.release();
    }
  } catch (error) {
    self.postMessage({ type: "error", message: error.message || String(error) });
  }
};
