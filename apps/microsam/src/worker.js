// One image session: download (or reuse) the checksummed encoder and decoder, compute the image
// embedding once, then answer one decoder call per prompt change. The page terminates the worker
// to cancel an embedding and starts a new one.
//
// Messages in:  { type: "embed", id, tensor, backend }  and  { type: "decode", id, prompt, height, width }
// Messages out: progress, log, embedded { summary }, decoded { mask, scores, token }, error
import * as ort from "onnxruntime-web/webgpu";
import wasmURL from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import wasmModuleURL from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import { fetchModel } from "@neurodesk/webapp-components/worker";
import { MODEL } from "./config.js";
import { chooseToken, decoderInputs, maskFromLogits } from "./segmentation.js";
import { embeddingSummary } from "./summary.js";

ort.env.wasm.wasmPaths = { wasm: wasmURL, mjs: wasmModuleURL };
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(8, navigator.hardwareConcurrency || 1) : 1;

const EMBEDDING_DIMS = [1, 256, 64, 64];
let decoder = null;
let embedding = null;

const progress = (value, message) => self.postMessage({ type: "progress", value, message });
const log = (message) => self.postMessage({ type: "log", message });

function download(asset, label, from, to) {
  return fetchModel({ url: asset.url, integrity: { bytes: asset.bytes, sha256: asset.sha256 } }, {
    onProgress: ({ fraction }) => progress(from + (to - from) * (fraction || 0), `Downloading the ${label} · ${Math.floor(100 * (fraction || 0))} %`),
  });
}

async function encode(bytes, backend, tensor) {
  const session = await ort.InferenceSession.create(bytes, { executionProviders: [backend], graphOptimizationLevel: "all" });
  try {
    const output = await session.run({ image: new ort.Tensor("float32", tensor, [1, 3, 1024, 1024]) });
    const data = output.image_embeddings.data;
    return data instanceof Float32Array ? data : Float32Array.from(data);
  } finally {
    await session.release();
  }
}

async function embed({ id, tensor, backend }) {
  progress(0, "Downloading the micro-sam encoder…");
  const encoderBytes = await download(MODEL.encoder, "micro-sam encoder", 0, 0.45);
  progress(0.45, "Downloading the micro-sam decoder…");
  const decoderBytes = await download(MODEL.decoder, "micro-sam decoder", 0.45, 0.7);
  decoder ??= await ort.InferenceSession.create(decoderBytes, { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
  progress(0.7, "Computing the image embedding…");
  const started = performance.now();
  let used = backend;
  try {
    embedding = await encode(encoderBytes, used, tensor);
  } catch (error) {
    if (used !== "webgpu") throw error;
    log(`WebGPU failed (${error.message}); computing the embedding on the CPU`);
    used = "wasm";
    embedding = await encode(encoderBytes, used, tensor);
  }
  const seconds = (performance.now() - started) / 1000;
  log(`Encoder on ${used === "webgpu" ? "WebGPU" : `WebAssembly, ${ort.env.wasm.numThreads} threads`} in ${seconds.toFixed(1)} s (ONNX Runtime Web ${ort.env.versions?.web ?? ""})`);
  self.postMessage({ type: "embedded", id, backend: used, seconds, summary: embeddingSummary(embedding) });
}

async function decode({ id, prompt, height, width }) {
  if (!embedding || !decoder) throw new Error("Compute the image embedding first.");
  const { coords, labels, count } = decoderInputs(prompt, height, width);
  const output = await decoder.run({
    image_embeddings: new ort.Tensor("float32", embedding, EMBEDDING_DIMS),
    point_coords: new ort.Tensor("float32", coords, [1, count, 2]),
    point_labels: new ort.Tensor("float32", labels, [1, count]),
    mask_input: new ort.Tensor("float32", new Float32Array(256 * 256), [1, 1, 256, 256]),
    has_mask_input: new ort.Tensor("float32", Float32Array.of(0), [1]),
    orig_im_size: new ort.Tensor("float32", Float32Array.of(height, width), [2]),
  });
  const scores = Array.from(output.iou_predictions.data);
  const chosen = chooseToken(prompt, scores);
  const mask = maskFromLogits(output.masks.data, chosen, height, width);
  self.postMessage({ type: "decoded", id, mask, score: scores[chosen], token: chosen }, [mask.buffer]);
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === "embed") await embed(data);
    else await decode(data);
  } catch (error) {
    self.postMessage({ type: "error", id: data.id, message: error.message || String(error) });
  }
};
