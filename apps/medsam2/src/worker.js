// MedSAM2 inference worker: downloads and checks the 4 ONNX models (image_encoder, mask_decoder,
// memory_encoder, memory_attention), lazily initializes 3D memory graphs on demand, pre-encodes
// viewed slices in the background, supports cooperative cancellation without discarding sessions
// or cached embeddings, and runs bidirectional 3D memory-bank propagation matching SAM2VideoPredictor.
import * as ort from "onnxruntime-web/webgpu";
import wasmURL from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import wasmModuleURL from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import { fetchModel } from "@neurodesk/webapp-components/worker";
import { MODEL } from "./config.js";
import {
  IMAGE_SIZE,
  LOW_RES_SIZE,
  bilinearResize2D,
  sliceToEncoderTensor,
} from "./volume.js";
import {
  decoderInputs,
  selectMaskAndPtr,
  thresholdMask,
  useMultimaskForPrompt,
} from "./segmentation.js";

const MAX_WASM_THREADS = 8;
const VERIFIED_ASSET_CACHE = "neurodesk-verified-assets-v1";
ort.env.wasm.wasmPaths = { wasm: wasmURL, mjs: wasmModuleURL };
ort.env.wasm.numThreads = self.crossOriginIsolated
  ? Math.max(1, Math.min(MAX_WASM_THREADS, (navigator.hardwareConcurrency || 2) - 1))
  : 1;

const MAX_CACHED_SLICES = 48;
const EMPTY_MASK_INPUT = new Float32Array(LOW_RES_SIZE * LOW_RES_SIZE);
const NO_MASK_INPUT = Float32Array.of(0);
const EMPTY_PTS = Float32Array.of(0, 0);
const EMPTY_LBL = Int32Array.of(-1);

let encoderSession = null;
let encoderBackend = null;
let maskDecoderSession = null;
let memoryEncoderSession = null;
let memoryAttentionSession = null;
let memoryAttentionBackend = null;

let webgpuEncoderFailed = false;
let webgpuMemoryAttentionFailed = false;

const embeddingCache = new Map();
const queuedItems = new Map();
const cancelledIds = new Set();
const inFlightControllers = new Map();
const bufferedLogs = [];
let runningId = null;
let pendingPriorityCount = 0;
let workerQueue = Promise.resolve();

function reportProgress(value, message, silent = false) {
  if (silent && pendingPriorityCount === 0) return;
  self.postMessage({ type: "progress", value, message });
}

function flushBufferedLogs() {
  while (bufferedLogs.length) {
    self.postMessage({ type: "log", message: bufferedLogs.shift() });
  }
}

function log(message, silent = false) {
  if (silent && pendingPriorityCount === 0) {
    bufferedLogs.push(message);
    if (bufferedLogs.length > 64) bufferedLogs.shift();
    return;
  }
  flushBufferedLogs();
  self.postMessage({ type: "log", message });
}

function isAbortError(error) {
  return error?.name === "AbortError";
}

// Yield to the worker macrotask queue so incoming cancel / priority messages are
// processed between back-to-back ONNX ops instead of waiting behind microtasks.
function yieldToMessages() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function cacheEmbedding(key, value, pinKey = null) {
  if (embeddingCache.has(key)) embeddingCache.delete(key);
  embeddingCache.set(key, value);
  while (embeddingCache.size > MAX_CACHED_SLICES) {
    let victim = null;
    for (const candidate of embeddingCache.keys()) {
      if (candidate !== pinKey && candidate !== key) {
        victim = candidate;
        break;
      }
    }
    if (victim === null) break;
    embeddingCache.delete(victim);
  }
}

async function hasCached2DModels() {
  if (encoderSession && maskDecoderSession) return true;
  const origin = self.location?.origin;
  if (!self.caches || !/^https?:\/\//.test(origin || "")) return false;
  try {
    const storage = await self.caches.open(VERIFIED_ASSET_CACHE);
    const encKey = new URL(`/__neurodesk_cache__/sha256/${MODEL.imageEncoder.sha256.toLowerCase()}`, origin).href;
    const decKey = new URL(`/__neurodesk_cache__/sha256/${MODEL.maskDecoder.sha256.toLowerCase()}`, origin).href;
    const [enc, dec] = await Promise.all([storage.match(encKey), storage.match(decKey)]);
    return Boolean(enc && dec);
  } catch {
    return false;
  }
}

async function downloadAssets(specs, from, to, { silent = false, signal = null } = {}) {
  if (!specs.length) return { buffers: [], downloadMs: 0 };
  signal?.throwIfAborted();
  const totalBytes = specs.reduce((sum, spec) => sum + (spec.asset.bytes || 1), 0);
  const loaded = new Float64Array(specs.length);
  const started = performance.now();

  // Link all sibling downloads to one batch AbortController so a failure or cancel
  // aborts every sibling immediately and awaits settlement before returning.
  const batchController = new AbortController();
  const onCallerAbort = () => batchController.abort(signal.reason ?? new DOMException("Cancelled", "AbortError"));
  signal?.addEventListener("abort", onCallerAbort, { once: true });

  const emit = (label) => {
    if (batchController.signal.aborted) return;
    let sum = 0;
    for (let i = 0; i < loaded.length; i++) sum += loaded[i];
    const fraction = Math.min(1, sum / totalBytes);
    reportProgress(from + (to - from) * fraction, `Downloading ${label} · ${Math.floor(100 * fraction)} %`, silent);
  };

  const promises = specs.map((spec, idx) => fetchModel(
    { url: spec.asset.url, integrity: { bytes: spec.asset.bytes, sha256: spec.asset.sha256 } },
    {
      signal: batchController.signal,
      onProgress: ({ fraction }) => {
        loaded[idx] = (spec.asset.bytes || 1) * (fraction || 0);
        emit(spec.label);
      },
    },
  ));

  try {
    const buffers = await Promise.all(promises);
    return { buffers, downloadMs: performance.now() - started };
  } catch (error) {
    batchController.abort(error);
    await Promise.allSettled(promises);
    throw error;
  } finally {
    signal?.removeEventListener("abort", onCallerAbort);
  }
}

async function createSession(bytes, backend) {
  return ort.InferenceSession.create(bytes, { executionProviders: [backend], graphOptimizationLevel: "all" });
}

function backendLabel(backend) {
  if (backend === "webgpu") return "WebGPU";
  const isolationNote = self.crossOriginIsolated ? "" : ", cross-origin isolation inactive";
  return `WebAssembly, ${ort.env.wasm.numThreads} ${ort.env.wasm.numThreads === 1 ? "thread" : "threads"}${isolationNote}`;
}

async function ensure2DSessions(requestedBackend, { silent = false, signal = null } = {}) {
  signal?.throwIfAborted();
  const desired = requestedBackend === "webgpu" && !webgpuEncoderFailed ? "webgpu" : "wasm";
  const needEncoder = !encoderSession || encoderBackend !== desired;
  const needDecoder = !maskDecoderSession;
  if (!needEncoder && !needDecoder) return encoderBackend;

  const specs = [];
  if (needEncoder) specs.push({ key: "encoder", asset: MODEL.imageEncoder, label: "MedSAM2 image encoder" });
  if (needDecoder) specs.push({ key: "decoder", asset: MODEL.maskDecoder, label: "MedSAM2 mask decoder" });

  reportProgress(0.02, "Downloading MedSAM2 2D models…", silent);
  const { buffers, downloadMs } = await downloadAssets(specs, 0.02, 0.72, { silent, signal });
  await yieldToMessages();
  signal?.throwIfAborted();

  let encCreateMs = 0;
  let decCreateMs = 0;
  let used = encoderBackend ?? desired;

  for (let i = 0; i < specs.length; i++) {
    await yieldToMessages();
    signal?.throwIfAborted();
    const spec = specs[i];
    let bytes = buffers[i];
    buffers[i] = null;

    if (spec.key === "encoder") {
      if (encoderSession) {
        await encoderSession.release();
        encoderSession = null;
        encoderBackend = null;
        await yieldToMessages();
        signal?.throwIfAborted();
      }
      used = desired;
      const t0 = performance.now();
      reportProgress(0.75, `Initializing MedSAM2 image encoder on ${used === "webgpu" ? "WebGPU" : "WebAssembly"}…`, silent);
      try {
        encoderSession = await createSession(bytes, used);
      } catch (error) {
        if (used !== "webgpu" || isAbortError(error) || signal?.aborted) throw error;
        webgpuEncoderFailed = true;
        log(`WebGPU image encoder initialization failed (${error.message}); falling back to WebAssembly CPU`, silent);
        used = "wasm";
        encoderSession = await createSession(bytes, "wasm");
      }
      encoderBackend = used;
      encCreateMs = performance.now() - t0;
    } else if (spec.key === "decoder") {
      const t0 = performance.now();
      reportProgress(0.9, "Initializing MedSAM2 mask decoder…", silent);
      maskDecoderSession = await createSession(bytes, "wasm");
      decCreateMs = performance.now() - t0;
    }
    bytes = null;
  }

  const parts = [`download ${downloadMs.toFixed(0)} ms`];
  if (needEncoder) parts.push(`encoder create ${encCreateMs.toFixed(0)} ms`);
  if (needDecoder) parts.push(`decoder create ${decCreateMs.toFixed(0)} ms`);
  log(`MedSAM2 2D ready on ${backendLabel(used)} (${parts.join(", ")}; ONNX Runtime Web ${ort.env.versions?.web ?? ""})`, silent);
  return used;
}

async function ensure3DSessions(encoderUsedBackend, { silent = false, signal = null } = {}) {
  signal?.throwIfAborted();
  const desiredMemAttn = encoderUsedBackend === "webgpu" && !webgpuMemoryAttentionFailed ? "webgpu" : "wasm";
  const needMemEnc = !memoryEncoderSession;
  const needMemAttn = !memoryAttentionSession || memoryAttentionBackend !== desiredMemAttn;
  if (!needMemEnc && !needMemAttn) return memoryAttentionBackend;

  const specs = [];
  if (needMemEnc) specs.push({ key: "memEnc", asset: MODEL.memoryEncoder, label: "MedSAM2 memory encoder" });
  if (needMemAttn) specs.push({ key: "memAttn", asset: MODEL.memoryAttention, label: "MedSAM2 memory attention" });

  reportProgress(0.01, "Downloading MedSAM2 3D memory models…", silent);
  const { buffers, downloadMs } = await downloadAssets(specs, 0.01, 0.04, { silent, signal });
  await yieldToMessages();
  signal?.throwIfAborted();

  let memEncCreateMs = 0;
  let memAttnCreateMs = 0;
  let usedMemAttn = memoryAttentionBackend ?? desiredMemAttn;

  for (let i = 0; i < specs.length; i++) {
    await yieldToMessages();
    signal?.throwIfAborted();
    const spec = specs[i];
    let bytes = buffers[i];
    buffers[i] = null;

    if (spec.key === "memEnc") {
      const t0 = performance.now();
      memoryEncoderSession = await createSession(bytes, "wasm");
      memEncCreateMs = performance.now() - t0;
    } else if (spec.key === "memAttn") {
      if (memoryAttentionSession) {
        await memoryAttentionSession.release();
        memoryAttentionSession = null;
        memoryAttentionBackend = null;
        await yieldToMessages();
        signal?.throwIfAborted();
      }
      usedMemAttn = desiredMemAttn;
      const t0 = performance.now();
      try {
        memoryAttentionSession = await createSession(bytes, usedMemAttn);
      } catch (error) {
        if (usedMemAttn !== "webgpu" || isAbortError(error) || signal?.aborted) throw error;
        webgpuMemoryAttentionFailed = true;
        log(`WebGPU memory attention initialization failed (${error.message}); falling back to WebAssembly CPU`, silent);
        usedMemAttn = "wasm";
        memoryAttentionSession = await createSession(bytes, "wasm");
      }
      memoryAttentionBackend = usedMemAttn;
      memAttnCreateMs = performance.now() - t0;
    }
    bytes = null;
  }

  const parts = [`download ${downloadMs.toFixed(0)} ms`];
  if (needMemEnc) parts.push(`mem_enc create ${memEncCreateMs.toFixed(0)} ms`);
  if (needMemAttn) parts.push(`mem_attn create ${memAttnCreateMs.toFixed(0)} ms`);
  log(`MedSAM2 3D ready (memory attention on ${backendLabel(usedMemAttn)}; ${parts.join(", ")})`, silent);
  return usedMemAttn;
}

async function copyTensor(tensor) {
  const data = await tensor.getData();
  return Float32Array.from(data);
}

async function encodeSlice(sliceKey, sliceUint8, width, height, { pinKey = null, silent = false, signal = null } = {}) {
  const cached = embeddingCache.get(sliceKey);
  if (cached) {
    embeddingCache.delete(sliceKey);
    embeddingCache.set(sliceKey, cached);
    return { entry: cached, cacheHit: true, encodeMs: 0 };
  }
  signal?.throwIfAborted();
  const started = performance.now();
  const inputData = sliceToEncoderTensor(sliceUint8, width, height);

  const runOnce = async () => {
    const input = new ort.Tensor("float32", inputData, [1, 3, IMAGE_SIZE, IMAGE_SIZE]);
    let out;
    try {
      out = await encoderSession.run({ image: input });
      return {
        highRes0: await copyTensor(out.high_res_0),
        highRes1: await copyTensor(out.high_res_1),
        visionFeats: await copyTensor(out.vision_feats),
        imageEmbedNoMem: await copyTensor(out.image_embed_no_mem),
      };
    } finally {
      input.dispose();
      if (out) for (const t of Object.values(out)) t.dispose();
    }
  };

  let entry;
  try {
    entry = await runOnce();
  } catch (error) {
    if (encoderBackend !== "webgpu" || isAbortError(error) || signal?.aborted) throw error;
    webgpuEncoderFailed = true;
    log(`WebGPU image encoder run failed (${error.message}); falling back to WebAssembly CPU`, silent);
    await ensure2DSessions("wasm", { silent, signal });
    entry = await runOnce();
  }

  const encodeMs = performance.now() - started;
  cacheEmbedding(sliceKey, entry, pinKey);
  return { entry, cacheHit: false, encodeMs };
}

async function runDecoder(imageEmbed, enc, coords, labels, count, multimaskOutput) {
  const started = performance.now();
  const feeds = {
    image_embed: new ort.Tensor("float32", imageEmbed, [1, 256, 32, 32]),
    high_res_0: new ort.Tensor("float32", enc.highRes0, [1, 32, 128, 128]),
    high_res_1: new ort.Tensor("float32", enc.highRes1, [1, 64, 64, 64]),
    point_coords: new ort.Tensor("float32", coords, [1, count, 2]),
    point_labels: new ort.Tensor("int32", labels, [1, count]),
    mask_input: new ort.Tensor("float32", EMPTY_MASK_INPUT, [1, 1, LOW_RES_SIZE, LOW_RES_SIZE]),
    has_mask_input: new ort.Tensor("float32", NO_MASK_INPUT, [1]),
  };
  let out;
  try {
    out = await maskDecoderSession.run(feeds);
    const lowMasks = await copyTensor(out.low_res_masks);
    const ious = await copyTensor(out.iou_predictions);
    const objPtrs = await copyTensor(out.obj_ptrs);
    const objScore = (await copyTensor(out.object_score_logits))[0];
    const selected = selectMaskAndPtr(lowMasks, ious, objPtrs, multimaskOutput);
    return { ...selected, objScore, decodeMs: performance.now() - started };
  } finally {
    for (const t of Object.values(feeds)) t.dispose();
    if (out) for (const t of Object.values(out)) t.dispose();
  }
}

async function runMemoryEncoder(visionFeats, lowResLogits, objScore, isMaskFromPts) {
  const started = performance.now();
  const highResMask = bilinearResize2D(lowResLogits, LOW_RES_SIZE, LOW_RES_SIZE, IMAGE_SIZE, IMAGE_SIZE);
  const feeds = {
    pix_feat: new ort.Tensor("float32", visionFeats, [1, 256, 32, 32]),
    high_res_mask: new ort.Tensor("float32", highResMask, [1, 1, IMAGE_SIZE, IMAGE_SIZE]),
    object_score_logits: new ort.Tensor("float32", Float32Array.of(objScore), [1, 1]),
    is_mask_from_pts: new ort.Tensor("float32", Float32Array.of(isMaskFromPts ? 1 : 0), [1]),
  };
  let out;
  try {
    out = await memoryEncoderSession.run(feeds);
    return {
      mfeat: await copyTensor(out.maskmem_features),
      mpos: await copyTensor(out.maskmem_pos_enc),
      memEncMs: performance.now() - started,
    };
  } finally {
    for (const t of Object.values(feeds)) t.dispose();
    if (out) for (const t of Object.values(out)) t.dispose();
  }
}

async function runMemoryAttention(visionFeats, memFeatsList, memPosList, tposIdxList, ptrList, posNormList, { signal = null } = {}) {
  const started = performance.now();
  const nMem = memFeatsList.length;
  const nPtr = ptrList.length;
  const memPlane = 64 * 32 * 32;
  const mfeats = new Float32Array(nMem * memPlane);
  const mpos = new Float32Array(nMem * memPlane);
  for (let i = 0; i < nMem; i++) {
    mfeats.set(memFeatsList[i], i * memPlane);
    mpos.set(memPosList[i], i * memPlane);
  }
  const ptrs = new Float32Array(nPtr * 256);
  for (let i = 0; i < nPtr; i++) ptrs.set(ptrList[i], i * 256);
  const tposBig = BigInt64Array.from(tposIdxList.map(BigInt));
  const posNormArr = Float32Array.from(posNormList);

  const runOnce = async () => {
    const feeds = {
      vision_feats: new ort.Tensor("float32", visionFeats, [1, 256, 32, 32]),
      maskmem_feats: new ort.Tensor("float32", mfeats, [nMem, 64, 32, 32]),
      maskmem_pos: new ort.Tensor("float32", mpos, [nMem, 64, 32, 32]),
      maskmem_tpos_idx: new ort.Tensor("int64", tposBig, [nMem]),
      obj_ptrs: new ort.Tensor("float32", ptrs, [nPtr, 1, 256]),
      obj_pos_norm: new ort.Tensor("float32", posNormArr, [nPtr]),
    };
    let out;
    try {
      out = await memoryAttentionSession.run(feeds);
      return await copyTensor(out.pix_feat_with_mem);
    } finally {
      for (const t of Object.values(feeds)) t.dispose();
      if (out) for (const t of Object.values(out)) t.dispose();
    }
  };

  let pixMem;
  try {
    pixMem = await runOnce();
  } catch (error) {
    if (memoryAttentionBackend !== "webgpu" || isAbortError(error) || signal?.aborted) throw error;
    webgpuMemoryAttentionFailed = true;
    log(`WebGPU memory attention run failed (${error.message}); falling back to WebAssembly CPU`);
    await ensure3DSessions("wasm", { silent: false, signal });
    pixMem = await runOnce();
  }
  return { pixMem, memAttnMs: performance.now() - started };
}

async function handlePreencode({ id, slices, width, height, backend, pinKey, onlyIfCached = true }, signal) {
  signal.throwIfAborted();
  if (pendingPriorityCount > 0) {
    self.postMessage({ type: "preencoded", id, encoded: 0, preempted: true });
    return;
  }
  if (onlyIfCached && !(await hasCached2DModels())) {
    self.postMessage({ type: "preencoded", id, encoded: 0, skipped: true });
    return;
  }
  // Do not pass the per-preencode signal into 2D session loading so scrolling or changing
  // slices never aborts an in-flight cache read or session compile.
  await ensure2DSessions(backend, { silent: true });
  let encoded = 0;
  for (let i = 0; i < slices.length; i++) {
    await yieldToMessages();
    signal.throwIfAborted();
    if (pendingPriorityCount > 0) {
      self.postMessage({ type: "preencoded", id, encoded, preempted: true });
      return;
    }
    const { sliceKey, sliceUint8 } = slices[i];
    const { cacheHit } = await encodeSlice(sliceKey, sliceUint8, width, height, {
      pinKey,
      silent: true,
      signal,
    });
    if (!cacheHit) encoded++;
  }
  self.postMessage({ type: "preencoded", id, encoded, preempted: false });
}

async function handleDecodeSlice({ id, sliceKey, sliceUint8, prompt, width, height, backend }, signal) {
  flushBufferedLogs();
  const used = await ensure2DSessions(backend, { silent: false, signal });
  await yieldToMessages();
  signal.throwIfAborted();
  const started = performance.now();
  const { entry: enc, cacheHit, encodeMs } = await encodeSlice(sliceKey, sliceUint8, width, height, {
    pinKey: sliceKey,
    silent: false,
    signal,
  });
  await yieldToMessages();
  signal.throwIfAborted();
  const { coords, labels, count } = decoderInputs(prompt, width, height);
  const decoded = await runDecoder(enc.imageEmbedNoMem, enc, coords, labels, count, useMultimaskForPrompt(prompt));
  await yieldToMessages();
  signal.throwIfAborted();
  const resized = bilinearResize2D(decoded.lowResLogits, LOW_RES_SIZE, LOW_RES_SIZE, width, height);
  const mask = thresholdMask(resized);
  const totalMs = performance.now() - started;
  const seconds = totalMs / 1000;
  const encodeNote = cacheHit ? "cache hit" : `encode ${encodeMs.toFixed(0)} ms`;
  log(`Slice decoded (${encodeNote}, decode ${decoded.decodeMs.toFixed(0)} ms, total ${totalMs.toFixed(0)} ms)`);
  self.postMessage({
    type: "decoded",
    id,
    backend: encoderBackend ?? used,
    seconds,
    cacheHit,
    timings: { encodeMs, decodeMs: decoded.decodeMs, totalMs },
    mask,
    score: decoded.score,
    token: decoded.token,
    objScore: decoded.objScore,
  }, [mask.buffer]);
}

async function handlePropagate({
  id,
  volumeId = 0,
  axis,
  windowKey,
  keySlice,
  rangeMin,
  rangeMax,
  slicesUint8,
  prompt,
  width,
  height,
  backend,
  stopOnEmpty = true,
}, signal) {
  flushBufferedLogs();
  const used = await ensure2DSessions(backend, { silent: false, signal });
  await yieldToMessages();
  signal.throwIfAborted();
  await ensure3DSessions(encoderBackend ?? used, { silent: false, signal });
  await yieldToMessages();
  signal.throwIfAborted();

  const started = performance.now();
  const numFrames = rangeMax - rangeMin + 1;
  const keyOffset = keySlice - rangeMin;
  const sliceKeyOf = (offset) => `${volumeId}:${axis}:${windowKey}:${rangeMin + offset}`;
  const pinKey = sliceKeyOf(keyOffset);

  let totalEncodeMs = 0;
  let totalMemAttnMs = 0;
  let totalDecodeMs = 0;
  let totalMemEncMs = 0;
  let cacheHits = 0;

  reportProgress(0.05, `Encoding prompted slice ${keySlice + 1}…`);
  const keyEncRes = await encodeSlice(pinKey, slicesUint8[keyOffset], width, height, { pinKey, signal });
  totalEncodeMs += keyEncRes.encodeMs;
  if (keyEncRes.cacheHit) cacheHits++;
  await yieldToMessages();
  signal.throwIfAborted();

  const keyEnc = keyEncRes.entry;
  const { coords, labels, count } = decoderInputs(prompt, width, height);
  const init = await runDecoder(keyEnc.imageEmbedNoMem, keyEnc, coords, labels, count, useMultimaskForPrompt(prompt));
  totalDecodeMs += init.decodeMs;
  await yieldToMessages();
  signal.throwIfAborted();

  const condMem = await runMemoryEncoder(keyEnc.visionFeats, init.lowResLogits, init.objScore, true);
  totalMemEncMs += condMem.memEncMs;
  await yieldToMessages();
  signal.throwIfAborted();

  const keyMask = thresholdMask(bilinearResize2D(init.lowResLogits, LOW_RES_SIZE, LOW_RES_SIZE, width, height));
  self.postMessage({ type: "sliceMask", id, slice: keySlice, mask: keyMask }, [keyMask.buffer]);

  const maxObjPtrs = Math.min(numFrames, MODEL.maxObjPtrs);
  const tDiffMax = Math.max(maxObjPtrs - 1, 1);
  const numMaskmem = MODEL.numMaskmem;
  const totalToTrack = Math.max(1, numFrames - 1);
  let tracked = 0;

  for (const reverse of [false, true]) {
    const nonCond = new Map();
    const step = reverse ? -1 : 1;
    let emptyStreak = 0;
    for (let frameIdx = keyOffset + step; frameIdx >= 0 && frameIdx < numFrames; frameIdx += step) {
      await yieldToMessages();
      signal.throwIfAborted();
      const sliceIndex = rangeMin + frameIdx;
      tracked++;
      reportProgress(0.05 + 0.94 * (tracked / totalToTrack), `Propagating · slice ${sliceIndex + 1} (${tracked}/${totalToTrack})`);

      const memFeatsList = [condMem.mfeat];
      const memPosList = [condMem.mpos];
      const tposIdxList = [numMaskmem - 1];
      for (let tPos = 1; tPos < numMaskmem; tPos++) {
        const tRel = numMaskmem - tPos;
        const prevIdx = reverse ? frameIdx + tRel : frameIdx - tRel;
        const prev = nonCond.get(prevIdx);
        if (prev) {
          memFeatsList.push(prev.mfeat);
          memPosList.push(prev.mpos);
          tposIdxList.push(numMaskmem - tPos - 1);
        }
      }

      const tposSign = reverse ? -1 : 1;
      const ptrList = [init.objPtr];
      const posNormList = [((frameIdx - keyOffset) * tposSign) / tDiffMax];
      for (let tDiff = 1; tDiff < maxObjPtrs; tDiff++) {
        const prevIdx = reverse ? frameIdx + tDiff : frameIdx - tDiff;
        if (prevIdx < 0 || prevIdx >= numFrames) break;
        const prev = nonCond.get(prevIdx);
        if (prev) {
          ptrList.push(prev.ptr);
          posNormList.push(tDiff / tDiffMax);
        }
      }

      const fEncRes = await encodeSlice(sliceKeyOf(frameIdx), slicesUint8[frameIdx], width, height, { pinKey, signal });
      totalEncodeMs += fEncRes.encodeMs;
      if (fEncRes.cacheHit) cacheHits++;
      await yieldToMessages();
      signal.throwIfAborted();

      const fEnc = fEncRes.entry;
      const attnRes = await runMemoryAttention(fEnc.visionFeats, memFeatsList, memPosList, tposIdxList, ptrList, posNormList, { signal });
      totalMemAttnMs += attnRes.memAttnMs;
      await yieldToMessages();
      signal.throwIfAborted();

      const decoded = await runDecoder(attnRes.pixMem, fEnc, EMPTY_PTS, EMPTY_LBL, 1, true);
      totalDecodeMs += decoded.decodeMs;
      await yieldToMessages();
      signal.throwIfAborted();

      const mem = await runMemoryEncoder(fEnc.visionFeats, decoded.lowResLogits, decoded.objScore, false);
      totalMemEncMs += mem.memEncMs;
      await yieldToMessages();
      signal.throwIfAborted();

      nonCond.set(frameIdx, { mfeat: mem.mfeat, mpos: mem.mpos, ptr: decoded.objPtr });
      const dropMemIdx = reverse ? frameIdx + numMaskmem : frameIdx - numMaskmem;
      const staleMem = nonCond.get(dropMemIdx);
      if (staleMem) {
        staleMem.mfeat = null;
        staleMem.mpos = null;
      }
      const evictIdx = reverse ? frameIdx + maxObjPtrs : frameIdx - maxObjPtrs;
      nonCond.delete(evictIdx);

      const mask = thresholdMask(bilinearResize2D(decoded.lowResLogits, LOW_RES_SIZE, LOW_RES_SIZE, width, height));
      const hasFg = mask.some(Boolean);
      self.postMessage({ type: "sliceMask", id, slice: sliceIndex, mask }, [mask.buffer]);

      if (stopOnEmpty) {
        if (!hasFg) {
          emptyStreak++;
          if (emptyStreak >= 2) {
            log(`Stopped ${reverse ? "backward" : "forward"} propagation at slice ${sliceIndex + 1} (object absent for 2 slices)`);
            break;
          }
        } else {
          emptyStreak = 0;
        }
      }
    }
  }

  const totalMs = performance.now() - started;
  const seconds = totalMs / 1000;
  const slicesDone = tracked + 1;
  log(
    `MedSAM2 3D propagation completed in ${seconds.toFixed(1)} s (${slicesDone} slices, ${cacheHits} cached · `
    + `encode ${totalEncodeMs.toFixed(0)} ms, mem_attn ${totalMemAttnMs.toFixed(0)} ms, `
    + `decode ${totalDecodeMs.toFixed(0)} ms, mem_enc ${totalMemEncMs.toFixed(0)} ms)`,
  );
  self.postMessage({
    type: "propagated",
    id,
    backend: encoderBackend ?? used,
    memoryAttentionBackend,
    seconds,
    timings: {
      encodeMs: totalEncodeMs,
      memAttnMs: totalMemAttnMs,
      decodeMs: totalDecodeMs,
      memEncMs: totalMemEncMs,
      totalMs,
      cacheHits,
      slicesDone,
    },
    score: init.score,
    token: init.token,
  });
}

self.onmessage = ({ data }) => {
  if (data.type === "cancel") {
    const targetId = data.targetId;
    const queued = queuedItems.get(targetId);
    if (queued) {
      queued.cancelled = true;
      queuedItems.delete(targetId);
      if (queued.isPriority) pendingPriorityCount = Math.max(0, pendingPriorityCount - 1);
      self.postMessage({ type: "cancelled", id: targetId });
      return;
    }
    if (runningId === targetId) {
      cancelledIds.add(targetId);
      inFlightControllers.get(targetId)?.abort(new DOMException("Cancelled", "AbortError"));
    }
    return;
  }

  const id = data.id;
  const isPriority = data.type === "decode" || data.type === "propagate";
  const queueEntry = { isPriority, cancelled: false };
  queuedItems.set(id, queueEntry);
  if (isPriority) pendingPriorityCount++;

  workerQueue = workerQueue.then(async () => {
    if (queueEntry.cancelled) return;
    queuedItems.delete(id);
    runningId = id;
    const controller = new AbortController();
    inFlightControllers.set(id, controller);
    if (cancelledIds.has(id)) {
      controller.abort(new DOMException("Cancelled", "AbortError"));
    }
    if (isPriority) self.postMessage({ type: "started", id });
    try {
      if (data.type === "clearCache") {
        embeddingCache.clear();
        self.postMessage({ type: "cleared", id });
      } else if (data.type === "preencode") {
        await handlePreencode(data, controller.signal);
      } else if (data.type === "decode") {
        await handleDecodeSlice(data, controller.signal);
      } else if (data.type === "propagate") {
        await handlePropagate(data, controller.signal);
      }
    } catch (error) {
      if (isAbortError(error) || controller.signal.aborted) {
        if (data.type === "propagate") {
          log("MedSAM2 3D propagation cancelled (sessions and cache preserved)");
        }
        self.postMessage({ type: "cancelled", id });
      } else {
        self.postMessage({ type: "error", id, message: error.message || String(error) });
      }
    } finally {
      if (runningId === id) runningId = null;
      inFlightControllers.delete(id);
      cancelledIds.delete(id);
      if (isPriority) pendingPriorityCount = Math.max(0, pendingPriorityCount - 1);
    }
  });
};
