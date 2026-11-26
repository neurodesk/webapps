// One Cellpose run: download (or reuse) the checksummed ONNX model, run the U-Net on
// ONNX Runtime WebAssembly, then compute gradient flows, instance masks and measurements
// in src/cellpose.js. The page starts a new worker per run and terminates it to cancel.
import * as ort from "onnxruntime-web/webgpu";
import wasmURL from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import wasmModuleURL from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import { fetchModel } from "@neurodesk/webapp-components/worker";
import { resolveModel } from "./config.js";
import { segment2D, segment3D } from "./cellpose.js";

ort.env.wasm.wasmPaths = { wasm: wasmURL, mjs: wasmModuleURL };
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(8, navigator.hardwareConcurrency || 1) : 1;

const progress = (value, message) => self.postMessage({ type: "progress", value, message });
const log = (message) => self.postMessage({ type: "log", message });

self.onmessage = async ({ data: job }) => {
  try {
    const spec = resolveModel(job.model);
    progress(0, `Downloading Cellpose ${spec.name}…`);
    const fetched = performance.now();
    const model = await fetchModel({ url: spec.url, integrity: { bytes: spec.bytes, sha256: spec.sha256 } }, {
      onProgress: ({ fraction }) => progress(0.12 * (fraction || 0), `Downloading Cellpose ${spec.name} · ${Math.floor(100 * (fraction || 0))} %`),
    });
    log(`Model ${spec.name} ready in ${((performance.now() - fetched) / 1000).toFixed(1)} s`);
    const session = await ort.InferenceSession.create(model, { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
    log(`ONNX Runtime ${ort.env.versions?.web ?? ""} on WebAssembly, ${ort.env.wasm.numThreads} threads`);
    const started = performance.now();
    let result;
    try {
      const runBatch = async (inputData, batchSize, height, width) => {
        const output = await session.run({
          [spec.input]: new ort.Tensor("float32", inputData, [batchSize, spec.channels, height, width]),
        });
        return output.flows.data;
      };

      if (job.do3D) {
        result = await segment3D(job.primary, job.nuclear, job.depth, job.height, job.width, spec, {
          diameter: job.diameter,
          anisotropy: job.anisotropy,
          cellprobThresh: job.cellprobThresh,
          minSize: job.minSize,
          runBatch,
          onPlane: (done, total, axis) => progress(0.12 + 0.72 * (done / total), `Predicting 3D (${axis}) · ${done} of ${total} slices`),
          onStage: (stage, count) => {
            if (stage === "dynamics") progress(0.86, `Following 3D flows (${count} steps)…`);
            else if (stage === "masks") {
              log(`${count} foreground voxels above cell probability ${job.cellprobThresh}`);
              progress(0.94, "Clustering 3D masks…");
            }
          },
        });
      } else {
        result = await segment2D(job.primary, job.nuclear, job.height, job.width, spec, {
          diameter: job.diameter,
          flowThresh: job.flowThresh,
          cellprobThresh: job.cellprobThresh,
          minSize: job.minSize,
          runBatch,
          onTile: (done, total) => progress(0.12 + 0.7 * (done / total), total > 1 ? `Predicting · tile ${done} of ${total}` : "Predicting"),
          onStage: (stage, count) => {
            if (stage === "dynamics") progress(0.84, `Following flows (${count} steps)…`);
            else if (stage === "masks") {
              log(`${count} foreground pixels above cell probability ${job.cellprobThresh}`);
              progress(0.92, "Clustering cell masks…");
            } else if (stage === "qc") {
              progress(0.96, "Checking flow error…");
            }
          },
        });
      }
    } finally {
      await session.release();
    }
    const seconds = (performance.now() - started) / 1000;
    self.postMessage({ type: "result", seconds, ...result }, [result.labels.buffer]);
  } catch (error) {
    self.postMessage({ type: "error", message: error.message || String(error) });
  }
};
