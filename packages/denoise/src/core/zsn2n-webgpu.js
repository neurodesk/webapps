// WebGPU compute-shader accelerator for Zero-Shot Noise2Noise (ZS-N2N).
// Implements the exact 2-layer residual CNN (Conv1 1->C 3x3 + LeakyReLU, Conv2 C->C 3x3 +
// LeakyReLU, Conv3 C->1 1x1), diagonal 2x2 pair downsampling, symmetric residual + consistency
// loss, exact analytic backpropagation (zero float atomics), global L2 gradient clipping + Adam,
// and seamless halo-tiled slice inference. Falls back cleanly to CPU when no hardware GPU is
// available or if device/shader execution fails.

import { assertFiniteVoxels, imageStats } from "./metrics.js";
import { createRng } from "./rng.js";
import { createZsN2nModel, denoiseZsN2n } from "./zsn2n.js";

const SOFTWARE_ADAPTER_RE =
  /swiftshader|llvmpipe|lavapipe|softpipe|software|basic render|microsoft basic|\bwarp\b|\bcpu\b/i;

const WG = 64;
const WG_REDUCE = 256;
const TRAIN_BATCH_SIZE = 10;
const INFER_HALO = 8;

/**
 * True when a WebGPU adapter info describes a CPU-emulated software rasteriser.
 * Matches `@neurodesk/runtime-support/mindgrab/backend`'s `isSoftwareAdapter`.
 */
export function isSoftwareAdapter(info = {}) {
  if (!info) return false;
  if (info.isFallbackAdapter) return true;
  return [info.vendor, info.architecture, info.device, info.description].some((field) =>
    SOFTWARE_ADAPTER_RE.test(field ?? ""),
  );
}

/** Formats a human-readable adapter label for console logs and provenance. */
export function formatAdapterName(info = {}) {
  return [info.vendor, info.architecture, info.device, info.description]
    .filter((value) => typeof value === "string" && value.trim())
    .join(" ") || "WebGPU adapter";
}

/**
 * Probes `navigator.gpu` for a usable WebGPU adapter. Rejects software-emulated adapters
 * unless `allowSoftwareAdapter` is explicitly true (used by automated parity tests).
 */
export async function probeWebGpuAdapter({ allowSoftwareAdapter = false } = {}) {
  const gpu = globalThis.navigator?.gpu;
  if (!gpu || typeof gpu.requestAdapter !== "function") {
    return { available: false, reason: "navigator.gpu unavailable" };
  }
  const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) {
    return { available: false, reason: "no WebGPU adapter" };
  }
  const rawInfo = adapter.info ?? {};
  const info = {
    vendor: rawInfo.vendor ?? "",
    architecture: rawInfo.architecture ?? "",
    device: rawInfo.device ?? "",
    description: rawInfo.description ?? "",
    isFallbackAdapter: Boolean(rawInfo.isFallbackAdapter ?? adapter.isFallbackAdapter),
  };
  const software = isSoftwareAdapter(info);
  if (software && !allowSoftwareAdapter) {
    return {
      available: false,
      software: true,
      info,
      reason: `software WebGPU adapter (${formatAdapterName(info)})`,
    };
  }
  return { available: true, software, adapter, info, name: formatAdapterName(info) };
}

const WGSL = /* wgsl */ `
const LEAKY_SLOPE: f32 = 0.2;

struct ModelMeta {
  C: u32,
  offW1: u32,
  offB1: u32,
  offW2: u32,
  offB2: u32,
  offW3: u32,
  offB3: u32,
  paramCount: u32,
}

struct StepParams {
  z: u32,
  y0: u32,
  x0: u32,
  ny: u32,
  nx: u32,
  ph: u32,
  pw: u32,
  stepIdx: u32,
  lr: f32,
  bc1: f32,
  bc2: f32,
  invN2: f32,
}

struct BranchParams {
  h: u32,
  w: u32,
  offIn: u32,
  offZ1: u32,
  offA1: u32,
  offZ2: u32,
  offA2: u32,
  offOut: u32,
  offDOut: u32,
  offDz2: u32,
  offDz1: u32,
  accumulate: u32,
}

struct LossOffsets {
  offPatch: u32,
  offY1: u32,
  offY2: u32,
  offOut1: u32,
  offOut2: u32,
  offOutFull: u32,
  offDG1: u32,
  offDG2: u32,
  offDGFull: u32,
  pad0: u32,
  pad1: u32,
  pad2: u32,
}

// Group 0: model buffers + metadata + current step uniform (dynamic offset).
@group(0) @binding(0) var<uniform> modelMeta: ModelMeta;
@group(0) @binding(1) var<uniform> stepU: StepParams;
@group(0) @binding(2) var<storage, read_write> params: array<f32>;
@group(0) @binding(3) var<storage, read_write> grads: array<f32>;
@group(0) @binding(4) var<storage, read_write> work: array<f32>;

// Group 1 (extract): normalized volume + loss offsets.
@group(1) @binding(0) var<storage, read> volume: array<f32>;
@group(1) @binding(1) var<uniform> lossOff: LossOffsets;

@compute @workgroup_size(${WG})
fn extract_crop(@builtin(global_invocation_id) gid: vec3<u32>) {
  let p = gid.x;
  let total = stepU.ph * stepU.pw;
  if (p >= total) { return; }
  let r = p / stepU.pw;
  let c = p % stepU.pw;
  let src = (stepU.z * stepU.ny + stepU.y0 + r) * stepU.nx + (stepU.x0 + c);
  work[lossOff.offPatch + p] = volume[src];
}

@compute @workgroup_size(${WG})
fn pair_downsample(@builtin(global_invocation_id) gid: vec3<u32>) {
  let h2 = stepU.ph >> 1u;
  let w2 = stepU.pw >> 1u;
  let idx = gid.x;
  if (idx >= h2 * w2) { return; }
  let r = idx / w2;
  let c = idx % w2;
  let r0 = lossOff.offPatch + 2u * r * stepU.pw;
  let r1 = r0 + stepU.pw;
  let c0 = 2u * c;
  work[lossOff.offY1 + idx] = 0.5 * (work[r0 + c0 + 1u] + work[r1 + c0]);
  work[lossOff.offY2 + idx] = 0.5 * (work[r0 + c0] + work[r1 + c0 + 1u]);
}

// Group 1 (branch): branch shape & offsets inside workBuf.
@group(1) @binding(0) var<uniform> br: BranchParams;

@compute @workgroup_size(${WG})
fn conv1_fwd(@builtin(global_invocation_id) gid: vec3<u32>) {
  let C = modelMeta.C;
  let idx = gid.x;
  let total = br.h * br.w * C;
  if (idx >= total) { return; }
  let p = idx / C;
  let co = idx % C;
  let y = i32(p / br.w);
  let x = i32(p % br.w);
  let h = i32(br.h);
  let w = i32(br.w);
  var acc = params[modelMeta.offB1 + co];
  let wBase = modelMeta.offW1 + co * 9u;
  for (var ky: i32 = -1; ky <= 1; ky = ky + 1) {
    let ny = y + ky;
    if (ny < 0 || ny >= h) { continue; }
    let row = br.offIn + u32(ny) * br.w;
    for (var kx: i32 = -1; kx <= 1; kx = kx + 1) {
      let nx = x + kx;
      if (nx < 0 || nx >= w) { continue; }
      let k = u32((ky + 1) * 3 + (kx + 1));
      acc = acc + params[wBase + k] * work[row + u32(nx)];
    }
  }
  work[br.offZ1 + idx] = acc;
  work[br.offA1 + idx] = select(LEAKY_SLOPE * acc, acc, acc > 0.0);
}

@compute @workgroup_size(${WG})
fn conv2_fwd(@builtin(global_invocation_id) gid: vec3<u32>) {
  let C = modelMeta.C;
  let idx = gid.x;
  let total = br.h * br.w * C;
  if (idx >= total) { return; }
  let p = idx / C;
  let co = idx % C;
  let y = i32(p / br.w);
  let x = i32(p % br.w);
  let h = i32(br.h);
  let w = i32(br.w);
  var acc = params[modelMeta.offB2 + co];
  let wCoBase = modelMeta.offW2 + co * 9u * C;
  for (var ky: i32 = -1; ky <= 1; ky = ky + 1) {
    let ny = y + ky;
    if (ny < 0 || ny >= h) { continue; }
    let rowBase = u32(ny) * br.w;
    for (var kx: i32 = -1; kx <= 1; kx = kx + 1) {
      let nx = x + kx;
      if (nx < 0 || nx >= w) { continue; }
      let k = u32((ky + 1) * 3 + (kx + 1));
      let aBase = br.offA1 + (rowBase + u32(nx)) * C;
      let wBase = wCoBase + k * C;
      for (var ci: u32 = 0u; ci < C; ci = ci + 1u) {
        acc = acc + params[wBase + ci] * work[aBase + ci];
      }
    }
  }
  work[br.offZ2 + idx] = acc;
  work[br.offA2 + idx] = select(LEAKY_SLOPE * acc, acc, acc > 0.0);
}

@compute @workgroup_size(${WG})
fn conv3_fwd(@builtin(global_invocation_id) gid: vec3<u32>) {
  let C = modelMeta.C;
  let p = gid.x;
  if (p >= br.h * br.w) { return; }
  var acc = params[modelMeta.offB3];
  let aBase = br.offA2 + p * C;
  for (var ci: u32 = 0u; ci < C; ci = ci + 1u) {
    acc = acc + params[modelMeta.offW3 + ci] * work[aBase + ci];
  }
  work[br.offOut + p] = acc;
}

@compute @workgroup_size(${WG})
fn conv3_bwd_dz2(@builtin(global_invocation_id) gid: vec3<u32>) {
  let C = modelMeta.C;
  let idx = gid.x;
  if (idx >= br.h * br.w * C) { return; }
  let p = idx / C;
  let ci = idx % C;
  let da2 = work[br.offDOut + p] * params[modelMeta.offW3 + ci];
  let z2 = work[br.offZ2 + idx];
  work[br.offDz2 + idx] = select(LEAKY_SLOPE * da2, da2, z2 > 0.0);
}

@compute @workgroup_size(${WG})
fn conv2_bwd_dz1(@builtin(global_invocation_id) gid: vec3<u32>) {
  let C = modelMeta.C;
  let idx = gid.x;
  if (idx >= br.h * br.w * C) { return; }
  let p = idx / C;
  let ci = idx % C;
  let y = i32(p / br.w);
  let x = i32(p % br.w);
  let h = i32(br.h);
  let w = i32(br.w);
  var acc = 0.0;
  for (var ky: i32 = -1; ky <= 1; ky = ky + 1) {
    let ny = y - ky;
    if (ny < 0 || ny >= h) { continue; }
    let rowBase = u32(ny) * br.w;
    for (var kx: i32 = -1; kx <= 1; kx = kx + 1) {
      let nx = x - kx;
      if (nx < 0 || nx >= w) { continue; }
      let k = u32((ky + 1) * 3 + (kx + 1));
      let dzBase = br.offDz2 + (rowBase + u32(nx)) * C;
      let wKBase = modelMeta.offW2 + k * C + ci;
      let strideCo = 9u * C;
      for (var co: u32 = 0u; co < C; co = co + 1u) {
        acc = acc + work[dzBase + co] * params[wKBase + co * strideCo];
      }
    }
  }
  let z1 = work[br.offZ1 + idx];
  work[br.offDz1 + idx] = select(LEAKY_SLOPE * acc, acc, z1 > 0.0);
}

var<workgroup> gradReduce: array<f32, ${WG}>;

@compute @workgroup_size(${WG})
fn grad_params(
  @builtin(workgroup_id) wid: vec3<u32>,
  @builtin(local_invocation_id) lidVec: vec3<u32>,
) {
  let paramIdx = wid.x;
  if (paramIdx >= modelMeta.paramCount) { return; }
  let lid = lidVec.x;
  let C = modelMeta.C;
  let hw = br.h * br.w;
  let h = i32(br.h);
  let w = i32(br.w);
  var sum = 0.0;

  if (paramIdx < modelMeta.offB1) {
    let rel = paramIdx - modelMeta.offW1;
    let co = rel / 9u;
    let k = rel % 9u;
    let ky = i32(k / 3u) - 1;
    let kx = i32(k % 3u) - 1;
    for (var p = lid; p < hw; p = p + ${WG}u) {
      let ny = i32(p / br.w) + ky;
      let nx = i32(p % br.w) + kx;
      if (ny >= 0 && ny < h && nx >= 0 && nx < w) {
        sum = sum + work[br.offDz1 + p * C + co] * work[br.offIn + u32(ny) * br.w + u32(nx)];
      }
    }
  } else if (paramIdx < modelMeta.offW2) {
    let co = paramIdx - modelMeta.offB1;
    for (var p = lid; p < hw; p = p + ${WG}u) {
      sum = sum + work[br.offDz1 + p * C + co];
    }
  } else if (paramIdx < modelMeta.offB2) {
    let rel = paramIdx - modelMeta.offW2;
    let ci = rel % C;
    let rem = rel / C;
    let k = rem % 9u;
    let co = rem / 9u;
    let ky = i32(k / 3u) - 1;
    let kx = i32(k % 3u) - 1;
    for (var p = lid; p < hw; p = p + ${WG}u) {
      let ny = i32(p / br.w) + ky;
      let nx = i32(p % br.w) + kx;
      if (ny >= 0 && ny < h && nx >= 0 && nx < w) {
        let aIdx = (u32(ny) * br.w + u32(nx)) * C + ci;
        sum = sum + work[br.offDz2 + p * C + co] * work[br.offA1 + aIdx];
      }
    }
  } else if (paramIdx < modelMeta.offW3) {
    let co = paramIdx - modelMeta.offB2;
    for (var p = lid; p < hw; p = p + ${WG}u) {
      sum = sum + work[br.offDz2 + p * C + co];
    }
  } else if (paramIdx < modelMeta.offB3) {
    let ci = paramIdx - modelMeta.offW3;
    for (var p = lid; p < hw; p = p + ${WG}u) {
      sum = sum + work[br.offDOut + p] * work[br.offA2 + p * C + ci];
    }
  } else {
    for (var p = lid; p < hw; p = p + ${WG}u) {
      sum = sum + work[br.offDOut + p];
    }
  }

  gradReduce[lid] = sum;
  workgroupBarrier();
  for (var s: u32 = ${WG / 2}u; s > 0u; s = s >> 1u) {
    if (lid < s) {
      gradReduce[lid] = gradReduce[lid] + gradReduce[lid + s];
    }
    workgroupBarrier();
  }
  if (lid == 0u) {
    if (br.accumulate == 0u) {
      grads[paramIdx] = gradReduce[0];
    } else {
      grads[paramIdx] = grads[paramIdx] + gradReduce[0];
    }
  }
}

// Group 1 (loss): lossBuf + lossOff uniform.
@group(1) @binding(0) var<storage, read_write> lossBuf: array<f32>;
@group(1) @binding(1) var<uniform> lossOff2: LossOffsets;

var<workgroup> lossReduce: array<f32, ${WG_REDUCE}>;

@compute @workgroup_size(${WG_REDUCE})
fn loss_and_dout(@builtin(local_invocation_id) lidVec: vec3<u32>) {
  let lid = lidVec.x;
  let h2 = stepU.ph >> 1u;
  let w2 = stepU.pw >> 1u;
  let n2 = h2 * w2;
  let invN2 = stepU.invN2;
  var localLoss = 0.0;

  for (var i = lid; i < n2; i = i + ${WG_REDUCE}u) {
    let r = i / w2;
    let c = i % w2;
    let r0 = 2u * r * stepU.pw;
    let r1 = r0 + stepU.pw;
    let c0 = 2u * c;

    let p00 = work[lossOff2.offPatch + r0 + c0] - work[lossOff2.offOutFull + r0 + c0];
    let p01 = work[lossOff2.offPatch + r0 + c0 + 1u] - work[lossOff2.offOutFull + r0 + c0 + 1u];
    let p10 = work[lossOff2.offPatch + r1 + c0] - work[lossOff2.offOutFull + r1 + c0];
    let p11 = work[lossOff2.offPatch + r1 + c0 + 1u] - work[lossOff2.offOutFull + r1 + c0 + 1u];
    let yh1 = 0.5 * (p01 + p10);
    let yh2 = 0.5 * (p00 + p11);

    let y1v = work[lossOff2.offY1 + i];
    let y2v = work[lossOff2.offY2 + i];
    let pred1 = y1v - work[lossOff2.offOut1 + i];
    let pred2 = y2v - work[lossOff2.offOut2 + i];

    let r1v = pred1 - y2v;
    let r2v = pred2 - y1v;
    let q1v = pred1 - yh1;
    let q2v = pred2 - yh2;
    localLoss = localLoss + r1v * r1v + r2v * r2v + q1v * q1v + q2v * q2v;

    work[lossOff2.offDG1 + i] = -invN2 * (r1v + q1v);
    work[lossOff2.offDG2 + i] = -invN2 * (r2v + q2v);

    let g1 = 0.5 * invN2 * q1v;
    let g2 = 0.5 * invN2 * q2v;
    work[lossOff2.offDGFull + r0 + c0 + 1u] = g1;
    work[lossOff2.offDGFull + r1 + c0] = g1;
    work[lossOff2.offDGFull + r0 + c0] = g2;
    work[lossOff2.offDGFull + r1 + c0 + 1u] = g2;
  }

  lossReduce[lid] = localLoss;
  workgroupBarrier();
  for (var s: u32 = ${WG_REDUCE / 2}u; s > 0u; s = s >> 1u) {
    if (lid < s) {
      lossReduce[lid] = lossReduce[lid] + lossReduce[lid + s];
    }
    workgroupBarrier();
  }
  if (lid == 0u) {
    lossBuf[stepU.stepIdx] = 0.5 * invN2 * lossReduce[0];
  }
}

// Group 1 (adam): Adam first and second moments.
@group(1) @binding(0) var<storage, read_write> adamM: array<f32>;
@group(1) @binding(1) var<storage, read_write> adamV: array<f32>;

var<workgroup> normReduce: array<f32, ${WG_REDUCE}>;

@compute @workgroup_size(${WG_REDUCE})
fn adam_clip_step(@builtin(local_invocation_id) lidVec: vec3<u32>) {
  let lid = lidVec.x;
  let count = modelMeta.paramCount;
  var localSq = 0.0;
  for (var i = lid; i < count; i = i + ${WG_REDUCE}u) {
    let g = grads[i];
    localSq = localSq + g * g;
  }
  normReduce[lid] = localSq;
  workgroupBarrier();
  for (var s: u32 = ${WG_REDUCE / 2}u; s > 0u; s = s >> 1u) {
    if (lid < s) {
      normReduce[lid] = normReduce[lid] + normReduce[lid + s];
    }
    workgroupBarrier();
  }
  let gradNorm = sqrt(normReduce[0]);
  let clip = select(1.0, 5.0 / gradNorm, gradNorm > 5.0);
  let lr = stepU.lr;
  let bc1 = stepU.bc1;
  let bc2 = stepU.bc2;

  for (var i = lid; i < count; i = i + ${WG_REDUCE}u) {
    let gi = grads[i] * clip;
    let mi = 0.9 * adamM[i] + 0.1 * gi;
    let vi = 0.999 * adamV[i] + 0.001 * gi * gi;
    adamM[i] = mi;
    adamV[i] = vi;
    params[i] = params[i] - (lr * (mi / bc1)) / (sqrt(vi / bc2) + 1e-8);
  }
}
`;

function alignUp(value, alignment) {
  return Math.ceil(value / alignment) * alignment;
}

function packModelParams(model) {
  const total = model.params.reduce((acc, arr) => acc + arr.length, 0);
  const packed = new Float32Array(total);
  let offset = 0;
  for (const arr of model.params) {
    packed.set(arr, offset);
    offset += arr.length;
  }
  return packed;
}

function writeBranchUniform(buffer, device, fields) {
  const arr = new Uint32Array([
    fields.h,
    fields.w,
    fields.offIn,
    fields.offZ1,
    fields.offA1,
    fields.offZ2,
    fields.offA2,
    fields.offOut,
    fields.offDOut,
    fields.offDz2,
    fields.offDz1,
    fields.accumulate,
  ]);
  device.queue.writeBuffer(buffer, 0, arr);
}

async function readFloat32Buffer(device, srcBuf, byteOffset, byteLength) {
  const staging = device.createBuffer({
    size: byteLength,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  try {
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(srcBuf, byteOffset, staging, 0, byteLength);
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const out = new Float32Array(staging.getMappedRange().slice(0));
    staging.unmap();
    return out;
  } finally {
    staging.destroy();
  }
}

/**
 * Runs Zero-Shot Noise2Noise on WebGPU compute shaders with exact architectural parity to
 * `denoiseZsN2n`. Throws if no acceptable WebGPU adapter is available or GPU execution fails.
 *
 * @param {Float32Array} data
 * @param {[number, number, number]} dims `[nz, ny, nx]`
 * @param {{
 *   iterations?: number,
 *   channels?: number,
 *   patchSize?: number,
 *   learningRate?: number,
 *   seed?: number,
 *   allowSoftwareAdapter?: boolean,
 *   onProgress?: (fraction: number, stage: string) => void
 * }} [options]
 */
export async function denoiseZsN2nWebGpu(data, dims, options = {}) {
  const {
    iterations = 200,
    channels = 16,
    patchSize = 48,
    learningRate = 2e-3,
    seed = 42,
    allowSoftwareAdapter = false,
    onProgress,
  } = options;

  const [nz, ny, nx] = dims;
  const plane = ny * nx;
  const stats = imageStats(data);
  if (!(stats.std > 1e-12) || ny < 4 || nx < 4) {
    onProgress?.(1, "Image too small or constant — returned unchanged");
    return {
      denoised: Float32Array.from(data),
      details: {
        backend: "cpu",
        channels,
        iterations: 0,
        parameterCount: 0,
        initialLoss: 0,
        finalLoss: 0,
      },
    };
  }

  const probe = await probeWebGpuAdapter({ allowSoftwareAdapter });
  if (!probe.available) {
    throw new Error(`WebGPU unavailable: ${probe.reason}`);
  }

  const device = await probe.adapter.requestDevice();
  device.pushErrorScope("validation");
  device.pushErrorScope("out-of-memory");
  const buffers = [];
  const track = (buf) => {
    buffers.push(buf);
    return buf;
  };

  try {
    const invStd = 1 / stats.std;
    const norm = new Float32Array(data.length);
    for (let i = 0; i < data.length; i += 1) {
      const v = data[i];
      norm[i] = Number.isFinite(v) ? (v - stats.mean) * invStd : 0;
    }

    const maxBinding = device.limits.maxStorageBufferBindingSize;
    if (norm.byteLength > maxBinding) {
      throw new Error(`Volume (${norm.byteLength} B) exceeds WebGPU storage buffer binding limit (${maxBinding} B).`);
    }

    const ph = Math.max(4, Math.min(patchSize, ny) & ~1);
    const pw = Math.max(4, Math.min(patchSize, nx) & ~1);
    const h2 = ph >> 1;
    const w2 = pw >> 1;
    const nFull = ph * pw;
    const n2 = h2 * w2;

    const model = createZsN2nModel(channels, seed);
    const packedParams = packModelParams(model);
    const paramCount = packedParams.length;
    const offW1 = 0;
    const offB1 = offW1 + channels * 9;
    const offW2 = offB1 + channels;
    const offB2 = offW2 + channels * channels * 9;
    const offW3 = offB2 + channels;
    const offB3 = offW3 + channels;

    // Choose inference tile size so activation buffers comfortably fit inside maxBinding.
    let inferTile = 256;
    while (inferTile > 64) {
      const side = inferTile + 2 * INFER_HALO;
      const floatsNeeded = side * side * (3 * channels + 2);
      if (floatsNeeded * 4 <= Math.floor(maxBinding * 0.5)) break;
      inferTile >>= 1;
    }
    const maxInferSide = Math.min(Math.max(ny, nx), inferTile + 2 * INFER_HALO);
    const inferFloats = maxInferSide * maxInferSide * (3 * channels + 2);

    // Lay out training scratch inside workBuf so every shader stays <= 5 storage bindings.
    let cursor = 0;
    const alloc = (len) => {
      const start = cursor;
      cursor += len;
      return start;
    };
    const offPatch = alloc(nFull);
    const offY1 = alloc(n2);
    const offY2 = alloc(n2);
    const offOut1 = alloc(n2);
    const offOut2 = alloc(n2);
    const offOutFull = alloc(nFull);
    const offDG1 = alloc(n2);
    const offDG2 = alloc(n2);
    const offDGFull = alloc(nFull);

    const offZ1_1 = alloc(n2 * channels);
    const offA1_1 = alloc(n2 * channels);
    const offZ2_1 = alloc(n2 * channels);
    const offA2_1 = alloc(n2 * channels);

    const offZ1_2 = alloc(n2 * channels);
    const offA1_2 = alloc(n2 * channels);
    const offZ2_2 = alloc(n2 * channels);
    const offA2_2 = alloc(n2 * channels);

    const offZ1_F = alloc(nFull * channels);
    const offA1_F = alloc(nFull * channels);
    const offZ2_F = alloc(nFull * channels);
    const offA2_F = alloc(nFull * channels);

    // dz2 and dz1 are reused sequentially across c1, c2, cFull.
    const offDz2 = alloc(nFull * channels);
    const offDz1 = alloc(nFull * channels);
    const trainWorkFloats = cursor;

    const workFloats = Math.max(trainWorkFloats, inferFloats);
    if (workFloats * 4 > maxBinding) {
      throw new Error(`Workspace (${workFloats * 4} B) exceeds WebGPU storage buffer binding limit (${maxBinding} B).`);
    }

    const module = device.createShaderModule({ code: WGSL, label: "zs-n2n-webgpu" });
    const compilation = await module.getCompilationInfo();
    const shaderErrors = compilation.messages.filter((m) => m.type === "error");
    if (shaderErrors.length) {
      throw new Error(`WGSL compilation failed: ${shaderErrors.map((m) => m.message).join("; ")}`);
    }

    const g0Layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", hasDynamicOffset: true } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      ],
    });
    const g1ExtractLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
      ],
    });
    const g1BranchLayout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } }],
    });
    const g1LossLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
      ],
    });
    const g1AdamLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      ],
    });

    const makePipeline = (entryPoint, g1Layout) =>
      device.createComputePipelineAsync({
        layout: device.createPipelineLayout({ bindGroupLayouts: [g0Layout, g1Layout] }),
        compute: { module, entryPoint },
        label: `zs-n2n:${entryPoint}`,
      });

    const [
      pExtract,
      pDownsample,
      pConv1Fwd,
      pConv2Fwd,
      pConv3Fwd,
      pLoss,
      pConv3Bwd,
      pConv2Bwd,
      pGradParams,
      pAdam,
    ] = await Promise.all([
      makePipeline("extract_crop", g1ExtractLayout),
      makePipeline("pair_downsample", g1ExtractLayout),
      makePipeline("conv1_fwd", g1BranchLayout),
      makePipeline("conv2_fwd", g1BranchLayout),
      makePipeline("conv3_fwd", g1BranchLayout),
      makePipeline("loss_and_dout", g1LossLayout),
      makePipeline("conv3_bwd_dz2", g1BranchLayout),
      makePipeline("conv2_bwd_dz1", g1BranchLayout),
      makePipeline("grad_params", g1BranchLayout),
      makePipeline("adam_clip_step", g1AdamLayout),
    ]);

    const metaBuf = track(device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    }));
    device.queue.writeBuffer(
      metaBuf,
      0,
      new Uint32Array([channels, offW1, offB1, offW2, offB2, offW3, offB3, paramCount]),
    );

    const stepStride = alignUp(48, Math.max(256, device.limits.minUniformBufferOffsetAlignment));
    const stepUniformBytes = new ArrayBuffer(iterations * stepStride);
    const rng = createRng(seed ^ 0x27d4eb2d);
    const maxY0 = ny - ph;
    const maxX0 = nx - pw;
    for (let iter = 1; iter <= iterations; iter += 1) {
      const z = nz > 1 ? Math.floor(rng() * nz) : 0;
      const y0 = maxY0 > 0 ? Math.floor(rng() * (maxY0 + 1)) : 0;
      const x0 = maxX0 > 0 ? Math.floor(rng() * (maxX0 + 1)) : 0;
      const progressFrac = (iter - 1) / Math.max(1, iterations - 1);
      const lr = learningRate * (0.1 + 0.45 * (1 + Math.cos(Math.PI * progressFrac)));
      const bc1 = 1 - 0.9 ** iter;
      const bc2 = 1 - 0.999 ** iter;
      const base = (iter - 1) * stepStride;
      const u32 = new Uint32Array(stepUniformBytes, base, 8);
      const f32 = new Float32Array(stepUniformBytes, base + 32, 4);
      u32.set([z, y0, x0, ny, nx, ph, pw, iter - 1]);
      f32.set([lr, bc1, bc2, 1 / n2]);
    }
    const stepUniformBuf = track(device.createBuffer({
      size: stepUniformBytes.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    }));
    device.queue.writeBuffer(stepUniformBuf, 0, stepUniformBytes);

    const paramsBuf = track(device.createBuffer({
      size: paramCount * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    }));
    device.queue.writeBuffer(paramsBuf, 0, packedParams);

    const gradsBuf = track(device.createBuffer({
      size: paramCount * 4,
      usage: GPUBufferUsage.STORAGE,
    }));
    const adamMBuf = track(device.createBuffer({
      size: paramCount * 4,
      usage: GPUBufferUsage.STORAGE,
    }));
    const adamVBuf = track(device.createBuffer({
      size: paramCount * 4,
      usage: GPUBufferUsage.STORAGE,
    }));
    const workBuf = track(device.createBuffer({
      size: workFloats * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    }));
    const volumeBuf = track(device.createBuffer({
      size: norm.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    }));
    device.queue.writeBuffer(volumeBuf, 0, norm);

    const lossBuf = track(device.createBuffer({
      size: iterations * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    }));
    const lossOffBuf = track(device.createBuffer({
      size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    }));
    device.queue.writeBuffer(
      lossOffBuf,
      0,
      new Uint32Array([offPatch, offY1, offY2, offOut1, offOut2, offOutFull, offDG1, offDG2, offDGFull, 0, 0, 0]),
    );

    const makeBranchBuf = (fields) => {
      const buf = track(device.createBuffer({
        size: 48,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      }));
      writeBranchUniform(buf, device, fields);
      return buf;
    };

    const br1Buf = makeBranchBuf({
      h: h2, w: w2,
      offIn: offY1, offZ1: offZ1_1, offA1: offA1_1, offZ2: offZ2_1, offA2: offA2_1,
      offOut: offOut1, offDOut: offDG1, offDz2, offDz1, accumulate: 0,
    });
    const br2Buf = makeBranchBuf({
      h: h2, w: w2,
      offIn: offY2, offZ1: offZ1_2, offA1: offA1_2, offZ2: offZ2_2, offA2: offA2_2,
      offOut: offOut2, offDOut: offDG2, offDz2, offDz1, accumulate: 1,
    });
    const brFullBuf = makeBranchBuf({
      h: ph, w: pw,
      offIn: offPatch, offZ1: offZ1_F, offA1: offA1_F, offZ2: offZ2_F, offA2: offA2_F,
      offOut: offOutFull, offDOut: offDGFull, offDz2, offDz1, accumulate: 1,
    });
    const brInferBuf = track(device.createBuffer({
      size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    }));

    const g0 = device.createBindGroup({
      layout: g0Layout,
      entries: [
        { binding: 0, resource: { buffer: metaBuf } },
        { binding: 1, resource: { buffer: stepUniformBuf, size: 48 } },
        { binding: 2, resource: { buffer: paramsBuf } },
        { binding: 3, resource: { buffer: gradsBuf } },
        { binding: 4, resource: { buffer: workBuf } },
      ],
    });
    const g1Extract = device.createBindGroup({
      layout: g1ExtractLayout,
      entries: [
        { binding: 0, resource: { buffer: volumeBuf } },
        { binding: 1, resource: { buffer: lossOffBuf } },
      ],
    });
    const g1Loss = device.createBindGroup({
      layout: g1LossLayout,
      entries: [
        { binding: 0, resource: { buffer: lossBuf } },
        { binding: 1, resource: { buffer: lossOffBuf } },
      ],
    });
    const g1Adam = device.createBindGroup({
      layout: g1AdamLayout,
      entries: [
        { binding: 0, resource: { buffer: adamMBuf } },
        { binding: 1, resource: { buffer: adamVBuf } },
      ],
    });
    const makeBranchGroup = (buf) =>
      device.createBindGroup({
        layout: g1BranchLayout,
        entries: [{ binding: 0, resource: { buffer: buf } }],
      });
    const g1Br1 = makeBranchGroup(br1Buf);
    const g1Br2 = makeBranchGroup(br2Buf);
    const g1BrFull = makeBranchGroup(brFullBuf);
    const g1BrInfer = makeBranchGroup(brInferBuf);

    const groups = (n) => Math.ceil(n / WG);
    const encodeForward = (pass, g1, dynOffset, hw) => {
      pass.setBindGroup(0, g0, [dynOffset]);
      pass.setBindGroup(1, g1);
      pass.setPipeline(pConv1Fwd);
      pass.dispatchWorkgroups(groups(hw * channels));
      pass.setPipeline(pConv2Fwd);
      pass.dispatchWorkgroups(groups(hw * channels));
      pass.setPipeline(pConv3Fwd);
      pass.dispatchWorkgroups(groups(hw));
    };
    const encodeBackward = (pass, g1, dynOffset, hw) => {
      pass.setBindGroup(0, g0, [dynOffset]);
      pass.setBindGroup(1, g1);
      pass.setPipeline(pConv3Bwd);
      pass.dispatchWorkgroups(groups(hw * channels));
      pass.setPipeline(pConv2Bwd);
      pass.dispatchWorkgroups(groups(hw * channels));
      pass.setPipeline(pGradParams);
      pass.dispatchWorkgroups(paramCount);
    };

    // Train in batches of TRAIN_BATCH_SIZE steps to amortize queue submission overhead
    // while still reporting responsive progress to the UI.
    for (let start = 0; start < iterations; start += TRAIN_BATCH_SIZE) {
      const end = Math.min(iterations, start + TRAIN_BATCH_SIZE);
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      for (let stepIdx = start; stepIdx < end; stepIdx += 1) {
        const dyn = stepIdx * stepStride;
        pass.setBindGroup(0, g0, [dyn]);
        pass.setBindGroup(1, g1Extract);
        pass.setPipeline(pExtract);
        pass.dispatchWorkgroups(groups(nFull));
        pass.setPipeline(pDownsample);
        pass.dispatchWorkgroups(groups(n2));

        encodeForward(pass, g1Br1, dyn, n2);
        encodeForward(pass, g1Br2, dyn, n2);
        encodeForward(pass, g1BrFull, dyn, nFull);

        pass.setBindGroup(0, g0, [dyn]);
        pass.setBindGroup(1, g1Loss);
        pass.setPipeline(pLoss);
        pass.dispatchWorkgroups(1);

        encodeBackward(pass, g1Br1, dyn, n2);
        encodeBackward(pass, g1Br2, dyn, n2);
        encodeBackward(pass, g1BrFull, dyn, nFull);

        pass.setBindGroup(0, g0, [dyn]);
        pass.setBindGroup(1, g1Adam);
        pass.setPipeline(pAdam);
        pass.dispatchWorkgroups(1);
      }
      pass.end();
      device.queue.submit([encoder.finish()]);
      await device.queue.onSubmittedWorkDone();
      onProgress?.(0.75 * (end / iterations), `Training ZS-N2N (WebGPU): step ${end} of ${iterations}…`);
    }

    const losses = await readFloat32Buffer(device, lossBuf, 0, iterations * 4);
    const initialLoss = losses[0] ?? 0;
    const finalLoss = losses[iterations - 1] ?? 0;
    if (!Number.isFinite(initialLoss) || !Number.isFinite(finalLoss)) {
      throw new Error("WebGPU training produced a non-finite loss.");
    }

    // Seamless halo-tiled inference on GPU reusing conv1_fwd, conv2_fwd, conv3_fwd.
    const denoised = new Float32Array(data.length);
    const mean = stats.mean;
    const std = stats.std;

    for (let z = 0; z < nz; z += 1) {
      const slice = norm.subarray(z * plane, (z + 1) * plane);
      const base = z * plane;

      for (let y0 = 0; y0 < ny; y0 += inferTile) {
        const y1 = Math.min(ny, y0 + inferTile);
        const py0 = Math.max(0, y0 - INFER_HALO);
        const py1 = Math.min(ny, y1 + INFER_HALO);
        const th = py1 - py0;

        for (let x0 = 0; x0 < nx; x0 += inferTile) {
          const x1 = Math.min(nx, x0 + inferTile);
          const px0 = Math.max(0, x0 - INFER_HALO);
          const px1 = Math.min(nx, x1 + INFER_HALO);
          const tw = px1 - px0;
          const hw = th * tw;

          const tile = new Float32Array(hw);
          for (let r = 0; r < th; r += 1) {
            const src = (py0 + r) * nx + px0;
            tile.set(slice.subarray(src, src + tw), r * tw);
          }

          // Inference layout inside workBuf: [in(hw), scratchZ(hw*C), a1(hw*C), a2(hw*C), out(hw)].
          const offIn = 0;
          const offZ = hw;
          const offA1 = offZ + hw * channels;
          const offA2 = offA1 + hw * channels;
          const offOut = offA2 + hw * channels;

          device.queue.writeBuffer(workBuf, 0, tile);
          writeBranchUniform(brInferBuf, device, {
            h: th, w: tw,
            offIn, offZ1: offZ, offA1, offZ2: offZ, offA2, offOut,
            offDOut: 0, offDz2: 0, offDz1: 0, accumulate: 0,
          });

          const encoder = device.createCommandEncoder();
          const pass = encoder.beginComputePass();
          encodeForward(pass, g1BrInfer, 0, hw);
          pass.end();
          device.queue.submit([encoder.finish()]);

          const out = await readFloat32Buffer(device, workBuf, offOut * 4, hw * 4);
          for (let y = y0; y < y1; y += 1) {
            const tr = y - py0;
            const dstRow = base + y * nx;
            const srcRow = tr * tw;
            for (let x = x0; x < x1; x += 1) {
              const tc = x - px0;
              denoised[dstRow + x] = (tile[srcRow + tc] - out[srcRow + tc]) * std + mean;
            }
          }
        }
      }
      onProgress?.(0.75 + 0.25 * ((z + 1) / nz), `Denoising slice ${z + 1} of ${nz} (WebGPU)…`);
    }

    const oomErr = await device.popErrorScope();
    const valErr = await device.popErrorScope();
    if (oomErr || valErr) {
      throw new Error(`WebGPU error: ${(oomErr ?? valErr).message}`);
    }

    assertFiniteVoxels(denoised, "WebGPU ZS-N2N output");
    onProgress?.(1, "Done");
    return {
      denoised,
      details: {
        backend: "webgpu",
        adapter: probe.name,
        channels,
        iterations,
        patchShape: [ph, pw],
        parameterCount: paramCount,
        initialLoss: Number(initialLoss.toPrecision(4)),
        finalLoss: Number(finalLoss.toPrecision(4)),
      },
    };
  } finally {
    for (const buf of buffers) buf.destroy();
    device.destroy();
  }
}

/**
 * Runs Zero-Shot Noise2Noise on hardware WebGPU when available, falling back seamlessly to
 * CPU `denoiseZsN2n` whenever WebGPU is unavailable, software-emulated, or throws at runtime.
 */
export async function denoiseZsN2nAuto(data, dims, options = {}) {
  const { preferWebGpu = true, allowSoftwareAdapter = false, onProgress, ...rest } = options;
  if (preferWebGpu) {
    try {
      return await denoiseZsN2nWebGpu(data, dims, { ...rest, allowSoftwareAdapter, onProgress });
    } catch {
      // Fall through cleanly to CPU execution when WebGPU is unavailable, software-emulated, or errors.
    }
  }
  const cpuOutcome = denoiseZsN2n(data, dims, { ...rest, onProgress });
  return {
    denoised: cpuOutcome.denoised,
    details: { backend: "cpu", ...cpuOutcome.details },
  };
}
