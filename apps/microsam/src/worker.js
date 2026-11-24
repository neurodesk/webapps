// One image/model session: download (or reuse) the checksummed encoder and decoder for the
// selected micro-sam model, compute and cache slice embeddings, then answer one decoder call per
// prompt change or 3D propagation step. The page terminates the worker to cancel an embedding.
//
// Messages in:  { type: "embed", id, modelId, slice, tensor, backend }
//               { type: "decode", id, slice, prompt, height, width }
// Messages out: progress, log, embedded { slice, modelId, backend, seconds, summary },
//               decoded { slice, mask, scores, token }, error
import * as ort from "onnxruntime-web/webgpu";
import wasmURL from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import wasmModuleURL from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import { fetchModel } from "@neurodesk/webapp-components/worker";
import { DEFAULT_MODEL_ID, modelById } from "./config.js";
import { chooseToken, decoderInputs, maskFromLogits } from "./segmentation.js";
import { embeddingSummary } from "./summary.js";

ort.env.wasm.wasmPaths = { wasm: wasmURL, mjs: wasmModuleURL };
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(8, navigator.hardwareConcurrency || 1) : 1;

const EMBEDDING_DIMS = [1, 256, 64, 64];
const MAX_CACHED_SLICES = 48;
let loadedModelId = null;
let encoderBytes = null;
let decoder = null;
const embeddings = new Map();

function storeEmbedding(slice, embedding) {
  if (embeddings.has(slice)) embeddings.delete(slice);
  embeddings.set(slice, embedding);
  const evicted = [];
  while (embeddings.size > MAX_CACHED_SLICES) {
    const oldest = embeddings.keys().next().value;
    embeddings.delete(oldest);
    evicted.push(oldest);
  }
  return evicted;
}

const progress = (value, message) => self.postMessage({ type: "progress", value, message });
const log = (message) => self.postMessage({ type: "log", message });

function download(asset, label, from, to) {
  return fetchModel({ url: asset.url, integrity: { bytes: asset.bytes, sha256: asset.sha256 } }, {
    onProgress: ({ fraction }) => progress(from + (to - from) * (fraction || 0), `Downloading the ${label} · ${Math.floor(100 * (fraction || 0))} %`),
  });
}

async function ensureModel(modelId) {
  if (loadedModelId === modelId && encoderBytes && decoder) return;
  const model = modelById(modelId);
  if (decoder) {
    await decoder.release();
    decoder = null;
  }
  encoderBytes = null;
  embeddings.clear();
  progress(0, `Downloading the micro-sam ${model.id} encoder…`);
  encoderBytes = await download(model.encoder, `micro-sam ${model.id} encoder`, 0, 0.45);
  progress(0.45, `Downloading the micro-sam ${model.id} decoder…`);
  const decoderBytes = await download(model.decoder, `micro-sam ${model.id} decoder`, 0.45, 0.7);
  decoder = await ort.InferenceSession.create(decoderBytes, { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
  loadedModelId = modelId;
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

async function embed({ id, modelId = DEFAULT_MODEL_ID, slice = 0, tensor, backend }) {
  await ensureModel(modelId);
  progress(0.7, slice ? `Computing slice ${slice + 1} embedding…` : "Computing the image embedding…");
  const started = performance.now();
  let used = backend;
  let embedding;
  try {
    embedding = await encode(encoderBytes, used, tensor);
  } catch (error) {
    if (used !== "webgpu") throw error;
    log(`WebGPU failed (${error.message}); computing the embedding on the CPU`);
    used = "wasm";
    embedding = await encode(encoderBytes, used, tensor);
  }
  const evicted = storeEmbedding(slice, embedding);
  const seconds = (performance.now() - started) / 1000;
  log(`Encoder (${modelId}, slice ${slice + 1}) on ${used === "webgpu" ? "WebGPU" : `WebAssembly, ${ort.env.wasm.numThreads} threads`} in ${seconds.toFixed(1)} s (ONNX Runtime Web ${ort.env.versions?.web ?? ""})`);
  self.postMessage({ type: "embedded", id, slice, modelId, backend: used, seconds, summary: embeddingSummary(embedding), evicted });
}

async function decode({ id, slice = 0, prompt, height, width }) {
  const embedding = embeddings.get(slice);
  if (!embedding || !decoder) throw new Error(`Compute the embedding for slice ${slice + 1} first.`);
  embeddings.delete(slice);
  embeddings.set(slice, embedding);
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
  self.postMessage({ type: "decoded", id, slice, mask, score: scores[chosen], token: chosen }, [mask.buffer]);
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === "embed") await embed(data);
    else await decode(data);
  } catch (error) {
    self.postMessage({ type: "error", id: data.id, message: error.message || String(error) });
  }
};
