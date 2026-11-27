// BLAST-CT Web Worker: reads the 3D head CT NIfTI, downloads & verifies the pinned DeepMedic ONNX
// model, and runs segmentHeadCt on hardware WebGPU (125^3 patches < 128 MiB) or threaded WASM CPU (155^3 patches).
import * as ort from "onnxruntime-web/webgpu";
import wasmURL from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import wasmModuleURL from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import { decodeNiftiBuffer, parseNiftiVolume } from "@neurodesk/webapp-components/file-io/nifti";
import { fetchModel } from "@neurodesk/webapp-components/worker";
import { CPU_OUTPUT_PATCH, WEBGPU_OUTPUT_PATCH, segmentHeadCt } from "@neurodesk/blastct";
import { DEFAULT_MODEL_ID, modelById } from "@neurodesk/blastct/models";

ort.env.wasm.wasmPaths = { wasm: wasmURL, mjs: wasmModuleURL };
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(8, navigator.hardwareConcurrency || 1) : 1;

const progress = (value, message) => self.postMessage({ type: "progress", value, message });
const log = (message) => self.postMessage({ type: "log", message });

const DOWNLOAD = 0.1;

async function runInference({ parsed, model, bytes, backend }) {
  const maxOutputPatch = backend === "webgpu" ? WEBGPU_OUTPUT_PATCH : CPU_OUTPUT_PATCH;
  log(`BLAST-CT ${model.id} on ${backend === "webgpu" ? "WebGPU (125³ patches)" : `WebAssembly, ${ort.env.wasm.numThreads} threads (155³ patches)`}`);
  const session = await ort.InferenceSession.create(bytes, {
    executionProviders: [backend],
    graphOptimizationLevel: "all",
  });
  try {
    return await segmentHeadCt({
      data: parsed.imageData,
      dimsXYZ: parsed.dims.slice(0, 3),
      rasAffine: parsed.affine,
      maxOutputPatch,
      runModel: async (patch, dims) => {
        const input = new ort.Tensor("float32", patch, dims);
        let outputs;
        try {
          outputs = await session.run({ [session.inputNames[0]]: input });
          return await outputs[session.outputNames[0]].getData();
        } finally {
          input.dispose();
          for (const output of Object.values(outputs || {})) output.dispose();
        }
      },
      onPatch: (n, total) => progress(DOWNLOAD + (1 - DOWNLOAD) * (n / total), `Segmenting · patch ${n} of ${total}`),
    });
  } finally {
    await session.release();
  }
}

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
    progress(0, "Reading head CT volume…");
    const parsed = parseNiftiVolume(await decodeNiftiBuffer(await job.file.arrayBuffer()));
    if (parsed.dims.length < 3 || (parsed.dims[3] ?? 1) > 1) {
      throw new Error("Expected a single 3D head CT volume (4D time series are not supported).");
    }
    progress(0, "Downloading the BLAST-CT model…");
    const bytes = await fetchModel({ url: model.url, integrity: { bytes: model.bytes, sha256: model.sha256 } }, {
      onProgress: ({ fraction }) => progress(DOWNLOAD * (fraction || 0), "Downloading the BLAST-CT model…"),
    });
    const started = performance.now();
    let backend = job.backend === "auto" ? await gpuBackend() : "wasm";
    let result;
    try {
      result = await runInference({ parsed, model, bytes, backend });
    } catch (error) {
      if (backend !== "webgpu") throw error;
      log(`WebGPU failed (${error.message}); continuing on the CPU`);
      backend = "wasm";
      result = await runInference({ parsed, model, bytes, backend });
    }
    const { headerBytes } = parsed;
    self.postMessage(
      {
        type: "result",
        labels: result.labels,
        dims: result.nativeGeom.size,
        spacing: result.nativeGeom.spacing,
        isoDims: result.isoGeom.size,
        affine: parsed.affine,
        headerBytes,
        provenance: {
          model: { id: model.id, file: model.filename, sha256: model.sha256, network: model.network },
          weights: "BLAST-CT v2.1.0 (biomedia-mira/blast-ct@613acbc1), v2 multi-centre model, checkpoint 1",
          backend,
          patches: result.patches,
          seconds: Math.round((performance.now() - started) / 100) / 10,
        },
      },
      [result.labels.buffer, headerBytes],
    );
  } catch (error) {
    self.postMessage({ type: "error", message: error.message || String(error) });
  }
};
