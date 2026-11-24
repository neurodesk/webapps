// TotalSegmentator Web Worker: reads the scan, downloads and verifies pinned ONNX models,
// and runs nnU-Net v2 sliding-window inference on WebGPU (falling back to threaded WASM CPU).
//   in:  { file: File, task, resolution, subset, backend }
//   out: { type: 'progress', value, message } | { type: 'log', message }
//        | { type: 'result', labels, imageData, dims, affine, provenance } | { type: 'error', message }
import * as ort from "onnxruntime-web/webgpu";
import wasmURL from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import wasmModuleURL from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import { readVolume } from "@neurodesk/synthsr";
import { fetchModel } from "@neurodesk/webapp-components/worker";
import { MAX_INPUT_VOXELS, segmentVolume } from "@neurodesk/totalsegmentator";
import { resolveTaskPlan } from "@neurodesk/totalsegmentator/models";

ort.env.wasm.wasmPaths = { wasm: wasmURL, mjs: wasmModuleURL };
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(8, navigator.hardwareConcurrency || 1) : 1;

const progress = (value, message) => self.postMessage({ type: "progress", value, message });
const log = (message) => self.postMessage({ type: "log", message });

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

async function runWithBackend({ volume, plan, backend, modelBytes }) {
  const label = backend === "webgpu" ? "WebGPU" : `WebAssembly (${ort.env.wasm.numThreads} threads)`;
  log(`TotalSegmentator ${plan.task.id} (${plan.resolution}${plan.subset !== "all" ? `, ${plan.subset}` : ""}) on ${label}`);
  const allModels = plan.cropModel ? [plan.cropModel, ...plan.models] : plan.models;
  const totalModels = allModels.length;

  return segmentVolume({
    volume,
    task: plan.task.id,
    models: plan.models,
    cropModel: plan.cropModel,
    runModel: async (model, fn) => {
      const partIdx = allModels.indexOf(model);
      const base = partIdx / totalModels;
      const span = 1 / totalModels;
      let bytes = modelBytes.get(model.id);
      if (!bytes) {
        progress(base, `Downloading ${model.id} (${partIdx + 1}/${totalModels})…`);
        bytes = await fetchModel(
          { url: model.url, integrity: { bytes: model.bytes, sha256: model.sha256 } },
          { onProgress: ({ fraction }) => progress(base + span * 0.2 * (fraction || 0), `Downloading ${model.id}…`) },
        );
        modelBytes.set(model.id, bytes);
      }
      const session = await ort.InferenceSession.create(bytes, {
        executionProviders: [backend],
        graphOptimizationLevel: "all",
      });
      try {
        return await fn(async (tile) => {
          const input = new ort.Tensor("float32", tile, [1, 1, ...model.patch]);
          let outputs;
          try {
            outputs = await session.run({ [session.inputNames[0]]: input });
            return await outputs[session.outputNames[0]].getData();
          } finally {
            input.dispose();
            for (const output of Object.values(outputs || {})) output.dispose();
          }
        });
      } finally {
        await session.release();
      }
    },
    onProgress: ({ stage, part, totalParts, patch, totalPatches }) => {
      const base = Math.max(0, part - 1) / totalParts;
      const span = 1 / totalParts;
      const frac = totalPatches > 0 ? patch / totalPatches : 0;
      const value = base + span * (0.2 + 0.8 * frac);
      const verb = stage === "crop" ? "Locating trunk" : "Segmenting";
      const suffix = totalParts > 1 ? ` · model ${part}/${totalParts} · patch ${patch}/${totalPatches}` : ` · patch ${patch}/${totalPatches}`;
      progress(value, `${verb}${suffix}`);
    },
  });
}

self.onmessage = async ({ data: job }) => {
  try {
    const plan = resolveTaskPlan({ task: job.task, resolution: job.resolution, subset: job.subset });
    progress(0, "Reading input volume…");
    const volume = readVolume(await job.file.arrayBuffer(), { maxVoxels: MAX_INPUT_VOXELS });
    log(`Loaded ${job.file.name} (${volume.dims.join(" × ")} voxels)`);

    const started = performance.now();
    const modelBytes = new Map();
    let backend = job.backend === "auto" ? await gpuBackend() : "wasm";
    let result;
    try {
      result = await runWithBackend({ volume, plan, backend, modelBytes });
    } catch (error) {
      if (backend !== "webgpu") throw error;
      log(`WebGPU failed (${error.message}); falling back to CPU`);
      backend = "wasm";
      result = await runWithBackend({ volume, plan, backend, modelBytes });
    }

    const usedModels = plan.cropModel ? [plan.cropModel, ...plan.models] : plan.models;
    const imageCopy = new Float32Array(volume.data);
    self.postMessage({
      type: "result",
      labels: result.labels,
      imageData: imageCopy,
      dims: result.dims,
      affine: result.affine,
      provenance: {
        task: plan.task.id,
        resolution: plan.resolution,
        subset: plan.subset,
        models: usedModels.map((m) => ({ id: m.id, file: m.filename, sha256: m.sha256 })),
        backend,
        resampledShape: result.resampledShape,
        windows: result.windows,
        seconds: Math.round((performance.now() - started) / 100) / 10,
      },
    }, [result.labels.buffer, imageCopy.buffer]);
  } catch (error) {
    self.postMessage({ type: "error", message: error.message || String(error) });
  }
};
