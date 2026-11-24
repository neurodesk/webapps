// MedSAM2 inference worker: downloads and checks the 4 ONNX models (image_encoder, mask_decoder,
// memory_encoder, memory_attention), caches slice embeddings, runs live 2D prompt decoding and
// bidirectional 3D memory-bank propagation matching SAM2VideoPredictor.
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

ort.env.wasm.wasmPaths = { wasm: wasmURL, mjs: wasmModuleURL };
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;

const MAX_CACHED_SLICES = 48;
const EMPTY_MASK_INPUT = new Float32Array(LOW_RES_SIZE * LOW_RES_SIZE);
const NO_MASK_INPUT = Float32Array.of(0);
const EMPTY_PTS = Float32Array.of(0, 0);
const EMPTY_LBL = Int32Array.of(-1);

let sessions = null;
let loadedBackend = null;
const embeddingCache = new Map();

const progress = (value, message) => self.postMessage({ type: "progress", value, message });
const log = (message) => self.postMessage({ type: "log", message });

function cacheEmbedding(key, value) {
  if (embeddingCache.has(key)) embeddingCache.delete(key);
  embeddingCache.set(key, value);
  while (embeddingCache.size > MAX_CACHED_SLICES) {
    const oldest = embeddingCache.keys().next().value;
    embeddingCache.delete(oldest);
  }
}

function download(asset, label, from, to) {
  return fetchModel({ url: asset.url, integrity: { bytes: asset.bytes, sha256: asset.sha256 } }, {
    onProgress: ({ fraction }) => progress(from + (to - from) * (fraction || 0), `Downloading ${label} · ${Math.floor(100 * (fraction || 0))} %`),
  });
}

async function createSession(bytes, backend) {
  return ort.InferenceSession.create(bytes, { executionProviders: [backend], graphOptimizationLevel: "all" });
}

async function ensureSessions(requestedBackend) {
  const desired = requestedBackend === "webgpu" ? "webgpu" : "wasm";
  if (sessions && loadedBackend === desired) return loadedBackend;
  if (sessions) {
    for (const s of Object.values(sessions)) await s.release();
    sessions = null;
  }
  let used = desired;
  progress(0, "Downloading MedSAM2 image encoder…");
  let encBytes = await download(MODEL.imageEncoder, "MedSAM2 image encoder", 0, 0.55);
  let imageEncoder;
  try {
    progress(0.56, `Initializing MedSAM2 image encoder on ${used === "webgpu" ? "WebGPU" : "WebAssembly"}…`);
    imageEncoder = await createSession(encBytes, used);
  } catch (error) {
    if (used !== "webgpu") throw error;
    log(`WebGPU initialization failed (${error.message}); falling back to WebAssembly CPU`);
    used = "wasm";
    imageEncoder = await createSession(encBytes, "wasm");
  }
  encBytes = null;

  progress(0.58, "Downloading MedSAM2 mask decoder…");
  let decBytes = await download(MODEL.maskDecoder, "MedSAM2 mask decoder", 0.58, 0.72);
  const maskDecoder = await createSession(decBytes, "wasm");
  decBytes = null;

  progress(0.73, "Downloading MedSAM2 memory encoder…");
  let memEncBytes = await download(MODEL.memoryEncoder, "MedSAM2 memory encoder", 0.73, 0.81);
  const memoryEncoder = await createSession(memEncBytes, "wasm");
  memEncBytes = null;

  progress(0.82, "Downloading MedSAM2 memory attention…");
  let memAttnBytes = await download(MODEL.memoryAttention, "MedSAM2 memory attention", 0.82, 0.96);
  const memoryAttention = await createSession(memAttnBytes, "wasm");
  memAttnBytes = null;

  sessions = { imageEncoder, maskDecoder, memoryEncoder, memoryAttention };
  loadedBackend = used;
  log(`MedSAM2 ready on ${used === "webgpu" ? "WebGPU" : `WebAssembly, ${ort.env.wasm.numThreads} threads`} (ONNX Runtime Web ${ort.env.versions?.web ?? ""})`);
  return used;
}

async function copyTensor(tensor) {
  const data = await tensor.getData();
  return data instanceof Float32Array ? Float32Array.from(data) : Float32Array.from(data);
}

async function encodeSlice(sliceKey, sliceUint8, width, height) {
  if (embeddingCache.has(sliceKey)) return embeddingCache.get(sliceKey);
  const inputData = sliceToEncoderTensor(sliceUint8, width, height);
  const input = new ort.Tensor("float32", inputData, [1, 3, IMAGE_SIZE, IMAGE_SIZE]);
  let out;
  try {
    out = await sessions.imageEncoder.run({ image: input });
    const entry = {
      highRes0: await copyTensor(out.high_res_0),
      highRes1: await copyTensor(out.high_res_1),
      visionFeats: await copyTensor(out.vision_feats),
      imageEmbedNoMem: await copyTensor(out.image_embed_no_mem),
    };
    cacheEmbedding(sliceKey, entry);
    return entry;
  } finally {
    input.dispose();
    if (out) for (const t of Object.values(out)) t.dispose();
  }
}

async function runDecoder(imageEmbed, enc, coords, labels, count, multimaskOutput) {
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
    out = await sessions.maskDecoder.run(feeds);
    const lowMasks = await copyTensor(out.low_res_masks);
    const ious = await copyTensor(out.iou_predictions);
    const objPtrs = await copyTensor(out.obj_ptrs);
    const objScore = (await copyTensor(out.object_score_logits))[0];
    const selected = selectMaskAndPtr(lowMasks, ious, objPtrs, multimaskOutput);
    return { ...selected, objScore };
  } finally {
    for (const t of Object.values(feeds)) t.dispose();
    if (out) for (const t of Object.values(out)) t.dispose();
  }
}

async function runMemoryEncoder(visionFeats, lowResLogits, objScore, isMaskFromPts) {
  const highResMask = bilinearResize2D(lowResLogits, LOW_RES_SIZE, LOW_RES_SIZE, IMAGE_SIZE, IMAGE_SIZE);
  const feeds = {
    pix_feat: new ort.Tensor("float32", visionFeats, [1, 256, 32, 32]),
    high_res_mask: new ort.Tensor("float32", highResMask, [1, 1, IMAGE_SIZE, IMAGE_SIZE]),
    object_score_logits: new ort.Tensor("float32", Float32Array.of(objScore), [1, 1]),
    is_mask_from_pts: new ort.Tensor("float32", Float32Array.of(isMaskFromPts ? 1 : 0), [1]),
  };
  let out;
  try {
    out = await sessions.memoryEncoder.run(feeds);
    return {
      mfeat: await copyTensor(out.maskmem_features),
      mpos: await copyTensor(out.maskmem_pos_enc),
    };
  } finally {
    for (const t of Object.values(feeds)) t.dispose();
    if (out) for (const t of Object.values(out)) t.dispose();
  }
}

async function runMemoryAttention(visionFeats, memFeatsList, memPosList, tposIdxList, ptrList, posNormList) {
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

  const feeds = {
    vision_feats: new ort.Tensor("float32", visionFeats, [1, 256, 32, 32]),
    maskmem_feats: new ort.Tensor("float32", mfeats, [nMem, 64, 32, 32]),
    maskmem_pos: new ort.Tensor("float32", mpos, [nMem, 64, 32, 32]),
    maskmem_tpos_idx: new ort.Tensor("int64", BigInt64Array.from(tposIdxList.map(BigInt)), [nMem]),
    obj_ptrs: new ort.Tensor("float32", ptrs, [nPtr, 1, 256]),
    obj_pos_norm: new ort.Tensor("float32", Float32Array.from(posNormList), [nPtr]),
  };
  let out;
  try {
    out = await sessions.memoryAttention.run(feeds);
    return await copyTensor(out.pix_feat_with_mem);
  } finally {
    for (const t of Object.values(feeds)) t.dispose();
    if (out) for (const t of Object.values(out)) t.dispose();
  }
}

async function handleDecodeSlice({ id, sliceKey, sliceUint8, prompt, width, height, backend }) {
  const used = await ensureSessions(backend);
  const started = performance.now();
  const enc = await encodeSlice(sliceKey, sliceUint8, width, height);
  const { coords, labels, count } = decoderInputs(prompt, width, height);
  const decoded = await runDecoder(enc.imageEmbedNoMem, enc, coords, labels, count, useMultimaskForPrompt(prompt));
  const resized = bilinearResize2D(decoded.lowResLogits, LOW_RES_SIZE, LOW_RES_SIZE, width, height);
  const mask = thresholdMask(resized);
  const seconds = (performance.now() - started) / 1000;
  self.postMessage({
    type: "decoded",
    id,
    backend: used,
    seconds,
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
}) {
  const used = await ensureSessions(backend);
  const started = performance.now();
  const numFrames = rangeMax - rangeMin + 1;
  const keyOffset = keySlice - rangeMin;
  const sliceKeyOf = (offset) => `${volumeId}:${axis}:${windowKey}:${rangeMin + offset}`;

  progress(0.05, `Encoding prompted slice ${keySlice + 1}…`);
  const keyEnc = await encodeSlice(sliceKeyOf(keyOffset), slicesUint8[keyOffset], width, height);
  const { coords, labels, count } = decoderInputs(prompt, width, height);
  const init = await runDecoder(keyEnc.imageEmbedNoMem, keyEnc, coords, labels, count, useMultimaskForPrompt(prompt));
  const condMem = await runMemoryEncoder(keyEnc.visionFeats, init.lowResLogits, init.objScore, true);

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
      const sliceIndex = rangeMin + frameIdx;
      tracked++;
      progress(0.05 + 0.94 * (tracked / totalToTrack), `Propagating · slice ${sliceIndex + 1} (${tracked}/${totalToTrack})`);

      const memFeatsList = [condMem.mfeat];
      const memPosList = [condMem.mpos];
      const tposIdxList = [numMaskmem - 1]; // t_pos=0 -> 6
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

      const fEnc = await encodeSlice(sliceKeyOf(frameIdx), slicesUint8[frameIdx], width, height);
      const pixMem = await runMemoryAttention(fEnc.visionFeats, memFeatsList, memPosList, tposIdxList, ptrList, posNormList);
      const decoded = await runDecoder(pixMem, fEnc, EMPTY_PTS, EMPTY_LBL, 1, true);
      const mem = await runMemoryEncoder(fEnc.visionFeats, decoded.lowResLogits, decoded.objScore, false);
      nonCond.set(frameIdx, { mfeat: mem.mfeat, mpos: mem.mpos, ptr: decoded.objPtr });
      // Drop spatial memories older than the recent attention window (numMaskmem - 1) and
      // evict object pointers older than (maxObjPtrs - 1) so propagation memory stays bounded.
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

  const seconds = (performance.now() - started) / 1000;
  log(`MedSAM2 3D propagation completed in ${seconds.toFixed(1)} s (${tracked + 1} slices)`);
  self.postMessage({ type: "propagated", id, backend: used, seconds, score: init.score, token: init.token });
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === "clearCache") {
      embeddingCache.clear();
      self.postMessage({ type: "cleared", id: data.id });
    } else if (data.type === "decode") {
      await handleDecodeSlice(data);
    } else if (data.type === "propagate") {
      await handlePropagate(data);
    }
  } catch (error) {
    self.postMessage({ type: "error", id: data.id, message: error.message || String(error) });
  }
};
