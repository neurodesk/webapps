/**
 * Browser WebGPU Boot/OPDT streamline tracker — a port of GPUStreamlines'
 * `cuslines/webgpu/` host code (wg_tractography.py + wg_propagate_seeds.py +
 * wg_direction_getters.py) to a browser `GPUDevice`.
 *
 * Two-pass, chunked over seeds (mirrors WebGPUSeedBatchPropagator):
 *   pass 1 `getNumStreamlinesBoot_k` → per-seed streamline counts
 *   → readback + exclusive prefix sum (CPU) → write back offsets
 *   pass 2 `genStreamlinesMergeBoot_k` → streamline coordinates + lengths
 *   → readback → assemble per-streamline point arrays.
 *
 * BROWSER-ONLY and not headlessly verifiable: requires WebGPU with the
 * `subgroups` feature and `maxStorageBuffersPerShaderStage >= 10` (the Boot
 * kernel binds 10 storage buffers across 3 groups after the repack). The host math feeding this
 * (sphere, gradients, OPDT H/R/delta_b/delta_q/sampling_matrix/b0s_mask) is
 * golden-tested in tracking.test.ts; this orchestration is verified in-browser.
 */

import {
  growChunkSize,
  isDeviceLost,
  isOomError,
  nextChunkSize,
  planBatchError,
} from './backoff'
import { BLOCK_Y, divUp, MAX_SLINE_LEN, REAL_SIZE } from './globals'
import { dispatchBootWindows, MAX_WORKGROUPS_PER_DISPATCH } from './dispatch'
import { BOOT_ENTRY_GEN, BOOT_ENTRY_GETNUM, bootShaderSource } from './shaders'

// Re-exported so the UI (main.ts) can classify a render OOM the same way.
export { isOomError }

/** Static per-dataset inputs uploaded once. `dataf` is the DWI signal in
 *  (x,y,z,t) C-contiguous order (t fastest); the OPDT matrices come straight
 *  from the Stage 3b host port (opdt.ts / sh.ts / gradients.ts). */
export interface TrackingInputs {
  dataf: Float32Array // dimx*dimy*dimz*dimt
  dims: [number, number, number, number] // dimx, dimy, dimz, dimt
  metricMap: Float32Array // stop map (FA), dimx*dimy*dimz
  sphereVertices: Float32Array // nverts*3
  sphereEdges: Int32Array // nedges*2
  // Boot/OPDT direction-getter matrices:
  H: Float32Array // (dimt-nb0) x (dimt-nb0)
  R: Float32Array // same
  deltaB: Float32Array // delta_nr x nCoeff
  deltaQ: Float32Array // delta_nr x nCoeff
  samplingMatrix: Float32Array // nverts x nCoeff
  b0sMask: Int32Array // dimt (1 where b0)
  samplmNr: number // sampling_matrix rows = nverts
  nedges: number // sphere_edges rows
  deltaNr: number // delta_b rows
  modelType: number // 0 = OPDT, 1 = CSA
}

export interface TrackingParams {
  maxAngle: number // radians (default radians(60))
  stepSize: number // voxels (default 0.5)
  tcThreshold: number // stop_threshold on metricMap (e.g. FA floor)
  relativePeakThresh: number // default 0.25
  minSeparationAngle: number // radians (default radians(45))
  minSignal: number // default 1
  rngSeed: number
  chunkSize: number // seeds per GPU batch (default 10000)
  minPts: number // discard streamlines shorter than this
  maxPts: number // discard streamlines longer than this
  maxWorkgroupsPerDispatch: number // physical GPU command size; output does not depend on it
}

export const DEFAULT_PARAMS: Omit<TrackingParams, 'tcThreshold'> = {
  maxAngle: (60 * Math.PI) / 180,
  stepSize: 0.5,
  relativePeakThresh: 0.25,
  minSeparationAngle: (45 * Math.PI) / 180,
  minSignal: 1,
  rngSeed: 0,
  // Each chunk reads its streamline buffer back to the host whole — sized at the
  // worst case of MAX_SLINE_LEN points × streamlines-in-chunk. Dense seeding on a
  // big brain can yield ~4 streamlines/seed, so 25k seeds/chunk was a ~1.3 GB
  // host ArrayBuffer that fails to allocate ("Array buffer allocation failed").
  // 10k keeps the peak readback ~0.5 GB; total streamlines are unaffected.
  chunkSize: 10000,
  minPts: 0,
  maxPts: Number.POSITIVE_INFINITY,
  maxWorkgroupsPerDispatch: MAX_WORKGROUPS_PER_DISPATCH,
}

/** The repacked Boot kernel binds 10 storage buffers across 3 groups (down
 *  from the reference's 17 — Dawn/Metal caps this at 10 in the browser). */
const REQUIRED_STORAGE_BUFFERS = 10

/** The Boot kernel's `var<workgroup>` arrays total ~20.8 KB; Dawn defaults the
 *  limit to the 16 KB spec minimum (wgpu-native defaults higher). */
const REQUIRED_WORKGROUP_STORAGE = 20800

/** Lanes per tidy row in the Boot kernel (THR_X_SL). Its reductions and ballots
 *  need exactly this subgroup; another size gives wrong streamlines or loses the device. */
const REQUIRED_SUBGROUP_SIZE = 32

function subgroupSizeError(detail: string): Error {
  return new Error(`tracking needs ${REQUIRED_SUBGROUP_SIZE}-lane GPU subgroups; this GPU ${detail}.`)
}

/**
 * Request a WebGPU device able to run the Boot tracker. Throws a *specific*
 * diagnostic (and logs the adapter's features + key limits to the console) so
 * we can tell apart the distinct failure causes — no WebGPU, missing
 * `subgroups`, or too few storage buffers / workgroup storage per stage
 * (Dawn/Metal may cap below what the repacked Boot kernel needs).
 */
export async function getTrackingDevice(): Promise<GPUDevice> {
  if (typeof navigator === 'undefined' || !navigator.gpu) {
    throw new Error('WebGPU is not available in this browser.')
  }
  const adapter = await navigator.gpu.requestAdapter({
    powerPreference: 'high-performance',
  })
  if (!adapter) throw new Error('No WebGPU adapter found.')

  const features = [...adapter.features]
  const maxSB = adapter.limits.maxStorageBuffersPerShaderStage
  // Ground truth for diagnosing capability gaps in the user's browser.
  console.info(
    '[dwi2trx] WebGPU adapter — features:',
    features,
    '| maxStorageBuffersPerShaderStage:',
    maxSB,
    '| maxBufferSize:',
    adapter.limits.maxBufferSize,
  )

  // The browser spec feature is "subgroups" (wgpu-native calls it "subgroup").
  const hasSubgroups = adapter.features.has('subgroups')
  if (!hasSubgroups) {
    throw new Error(
      `your GPU/browser doesn't expose the WebGPU "subgroups" feature ` +
        `(adapter features: ${features.join(', ') || 'none'}). On Chrome try ` +
        `enabling chrome://flags/#enable-unsafe-webgpu; Safari/Firefox may not ` +
        `support subgroups yet.`,
    )
  }
  // Chromium reports the range its compiler may choose from; the kernel checks the
  // size it actually got, since the range alone does not guarantee 32.
  const { subgroupMinSize, subgroupMaxSize } = adapter.info
  if (
    subgroupMinSize !== undefined &&
    subgroupMaxSize !== undefined &&
    (subgroupMinSize > REQUIRED_SUBGROUP_SIZE || subgroupMaxSize < REQUIRED_SUBGROUP_SIZE)
  ) {
    throw subgroupSizeError(
      `has ${subgroupMinSize === subgroupMaxSize ? subgroupMinSize : `${subgroupMinSize}-${subgroupMaxSize}`}-lane subgroups`,
    )
  }
  if (maxSB < REQUIRED_STORAGE_BUFFERS) {
    throw new Error(
      `your GPU exposes only ${maxSB} storage buffers per shader stage, but the ` +
        `tracker's Boot kernel needs ${REQUIRED_STORAGE_BUFFERS}.`,
    )
  }
  if (
    adapter.limits.maxComputeWorkgroupStorageSize < REQUIRED_WORKGROUP_STORAGE
  ) {
    throw new Error(
      `your GPU allows only ${adapter.limits.maxComputeWorkgroupStorageSize} bytes of ` +
        `compute workgroup storage, but the Boot kernel needs ${REQUIRED_WORKGROUP_STORAGE}.`,
    )
  }
  try {
    return await adapter.requestDevice({
      requiredFeatures: ['subgroups'] as GPUFeatureName[],
      requiredLimits: {
        maxStorageBuffersPerShaderStage: REQUIRED_STORAGE_BUFFERS,
        maxBindGroups: 4,
        maxBufferSize: adapter.limits.maxBufferSize,
        maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
        // Boot uses ~20.8 KB of workgroup storage; Dawn defaults the limit to
        // 16 KB (wgpu-native defaults higher, so the reference never set it).
        maxComputeWorkgroupStorageSize:
          adapter.limits.maxComputeWorkgroupStorageSize,
      },
    })
  } catch (err) {
    throw new Error(`WebGPU device request failed: ${(err as Error).message}`)
  }
}

// --- buffer helpers (browser has no createBufferWithData) ---

function storageFromData(
  device: GPUDevice,
  data: Float32Array | Int32Array,
  label: string,
): GPUBuffer {
  const buf = device.createBuffer({
    size: data.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    mappedAtCreation: true,
    label,
  })
  const Ctor = data instanceof Float32Array ? Float32Array : Int32Array
  new Ctor(buf.getMappedRange()).set(data as never)
  buf.unmap()
  return buf
}

function emptyStorage(
  device: GPUDevice,
  sizeBytes: number,
  label: string,
): GPUBuffer {
  return device.createBuffer({
    size: Math.max(sizeBytes, 4),
    usage:
      GPUBufferUsage.STORAGE |
      GPUBufferUsage.COPY_SRC |
      GPUBufferUsage.COPY_DST,
    label,
  })
}

/** Copy `byteLength` bytes from `buf` (starting at `srcOffset`) back to the CPU.
 *  `srcOffset` + `byteLength` must be multiples of 4. */
async function readback(
  device: GPUDevice,
  buf: GPUBuffer,
  byteLength: number,
  srcOffset = 0,
): Promise<ArrayBuffer> {
  const staging = device.createBuffer({
    size: byteLength,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  })
  const enc = device.createCommandEncoder()
  enc.copyBufferToBuffer(buf, srcOffset, staging, 0, byteLength)
  device.queue.submit([enc.finish()])
  try {
    await staging.mapAsync(GPUMapMode.READ)
    return staging.getMappedRange().slice(0)
  } finally {
    staging.destroy() // also frees it if mapAsync rejects (device loss)
  }
}

/** Offsets (in f32 elements) of each matrix within the packed modelData buffer
 *  [H | R | delta_b | delta_q | sampling_matrix | b0s_mask]. off_H is 0. */
interface ModelOffsets {
  offR: number
  offDeltaB: number
  offDeltaQ: number
  offSampling: number
  offB0s: number
}

function modelOffsets(inputs: TrackingInputs): ModelOffsets {
  const offR = inputs.H.length
  const offDeltaB = offR + inputs.R.length
  const offDeltaQ = offDeltaB + inputs.deltaB.length
  const offSampling = offDeltaQ + inputs.deltaQ.length
  const offB0s = offSampling + inputs.samplingMatrix.length
  return { offR, offDeltaB, offDeltaQ, offSampling, offB0s }
}

// --- params struct (must match BootTrackingParams in boot.wgsl) ---
// 6 f32 + 18 i32 = 96 bytes, little-endian. Five modelData offsets are followed
// by the physical dispatch's logical workgroup offset (initially zero).
// tc_threshold/step_size are zero on the getNum pass. rng_offset is the batch's first
// seed index in the whole run, so a seed's random stream does not depend on the batch size.
function packBootParams(
  inputs: TrackingInputs,
  off: ModelOffsets,
  p: TrackingParams,
  nseeds: number,
  firstSeed: number,
  forGen: boolean,
): ArrayBuffer {
  const buf = new ArrayBuffer(96)
  const dv = new DataView(buf)
  const seedLo = p.rngSeed & 0xffffffff
  const seedHi = Math.floor(p.rngSeed / 0x100000000) & 0xffffffff
  let o = 0
  const f32 = (v: number) => {
    dv.setFloat32(o, v, true)
    o += 4
  }
  const i32 = (v: number) => {
    dv.setInt32(o, v, true)
    o += 4
  }
  f32(p.maxAngle)
  f32(forGen ? p.tcThreshold : 0)
  f32(forGen ? p.stepSize : 0)
  f32(p.relativePeakThresh)
  f32(p.minSeparationAngle)
  f32(p.minSignal)
  i32(seedLo)
  i32(seedHi)
  i32(firstSeed)
  i32(nseeds)
  i32(inputs.dims[0])
  i32(inputs.dims[1])
  i32(inputs.dims[2])
  i32(inputs.dims[3])
  i32(inputs.samplmNr)
  i32(inputs.nedges)
  i32(inputs.deltaNr)
  i32(inputs.modelType)
  i32(off.offR)
  i32(off.offDeltaB)
  i32(off.offDeltaQ)
  i32(off.offSampling)
  i32(off.offB0s)
  i32(0)
  return buf
}

/** Upload several Float32 arrays as one storage buffer, writing each directly
 *  into the mapped GPU range — no intermediate host concat. The combined size is
 *  checked BEFORE any allocation, so a too-large DWI gets an actionable message
 *  instead of exhausting JS memory in the concat or a generic WebGPU failure. */
function storageFromParts(
  device: GPUDevice,
  parts: Float32Array[],
  label: string,
  limitBytes: number,
): GPUBuffer {
  let n = 0
  for (const p of parts) n += p.length
  const bytes = n * 4
  if (bytes > limitBytes) {
    throw new Error(
      `${label} needs ${(bytes / 1e9).toFixed(1)} GB, over this GPU's ` +
        `${(limitBytes / 1e9).toFixed(1)} GB buffer limit — the DWI is too large for this GPU.`,
    )
  }
  const buf = device.createBuffer({
    size: Math.max(bytes, 4),
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    mappedAtCreation: true,
    label,
  })
  const view = new Float32Array(buf.getMappedRange())
  let o = 0
  for (const p of parts) {
    view.set(p, o)
    o += p.length
  }
  buf.unmap()
  return buf
}

/** Result of trackStreamlines. `truncated` is true when the run stopped early
 *  (host/GPU memory, or `deviceLost`) so the streamlines are only partial;
 *  `processedSeeds` is how many of `totalSeeds` were actually tracked (equal on
 *  a complete run). */
export interface TrackResult {
  lines: Float32Array[]
  truncated: boolean
  deviceLost: boolean
  processedSeeds: number
  totalSeeds: number
}

/** Cap a single host/GPU streamline readback so peak memory is bounded by this,
 *  not by chunk size — slices are pulled back one window at a time. */
const READBACK_WINDOW_BYTES = 128 * 1024 * 1024

/**
 * Track streamlines from `seeds` (nseeds × 3 voxel coords, flat Float32Array).
 * Returns one Float32Array per surviving streamline (flat x,y,z points, length
 * 3·npts), in VOX space. `onProgress(done, total)` is called per chunk.
 *
 * Memory is bounded two ways: each batch's streamline buffer is read back in
 * fixed windows (READBACK_WINDOW_BYTES), and a batch that still hits an
 * out-of-memory error is retried with a halved seed count (down to MIN_CHUNK)
 * before, as a last resort, returning the streamlines gathered so far with
 * `truncated = true` — a partial tractogram beats none.
 *
 * `shouldStop()` is polled between batches so a superseded run (a new DWI
 * dropped mid-track) stops promptly and frees its GPU buffers.
 */
export async function trackStreamlines(
  device: GPUDevice,
  inputs: TrackingInputs,
  seeds: Float32Array,
  params: TrackingParams,
  onProgress?: (done: number, total: number) => void,
  shouldStop?: () => boolean,
): Promise<TrackResult> {
  const nSeedsTotal = seeds.length / 3
  const off = modelOffsets(inputs)

  // Static buffers (uploaded once), tracked so the finally frees them even if a
  // later allocation or pipeline creation throws. Packed to fit 10 storage
  // buffers/stage:
  //   dataf  = [DWI signal | sphere_vertices]   (verts at offset dimx*dimy*dimz*dimt)
  //   model  = [H | R | delta_b | delta_q | sampling_matrix | b0s_mask(f32)]
  const staticBuffers: GPUBuffer[] = []
  const stat = (b: GPUBuffer): GPUBuffer => {
    staticBuffers.push(b)
    return b
  }
  const out: Float32Array[] = []
  let truncated = false
  let deviceLost = false
  let processedSeeds = 0
  const maxBinding = device.limits.maxStorageBufferBindingSize
  const maxBuffer = device.limits.maxBufferSize
  // A storage buffer must fit both the per-binding and per-buffer GPU limits.
  const gpuLimit = Math.min(maxBinding, maxBuffer)

  try {
    // Big inputs are checked (and the combined size validated) BEFORE allocating,
    // so a too-large DWI reports an actionable limit error rather than blowing up
    // in a host concat or a generic WebGPU failure.
    const datafBuf = stat(
      storageFromParts(
        device,
        [inputs.dataf, inputs.sphereVertices],
        'DWI signal buffer',
        gpuLimit,
      ),
    )
    if (inputs.metricMap.byteLength > gpuLimit) {
      throw new Error(
        `FA map buffer needs ${(inputs.metricMap.byteLength / 1e9).toFixed(1)} GB, over ` +
          `this GPU's ${(gpuLimit / 1e9).toFixed(1)} GB buffer limit — the DWI is too large for this GPU.`,
      )
    }
    const metricBuf = stat(
      storageFromData(device, inputs.metricMap, 'metric_map'),
    )
    const edgesBuf = stat(
      storageFromData(device, inputs.sphereEdges, 'sphere_edges'),
    )
    const modelBuf = stat(
      storageFromParts(
        device,
        [
          inputs.H,
          inputs.R,
          inputs.deltaB,
          inputs.deltaQ,
          inputs.samplingMatrix,
          Float32Array.from(inputs.b0sMask),
        ],
        'model buffer',
        gpuLimit,
      ),
    )

    // Shader module + the two Boot pipelines.
    const module = device.createShaderModule({ code: bootShaderSource() })
    const getnumPipe = device.createComputePipeline({
      layout: 'auto',
      compute: { module, entryPoint: BOOT_ENTRY_GETNUM },
    })
    const genPipe = device.createComputePipeline({
      layout: 'auto',
      compute: { module, entryPoint: BOOT_ENTRY_GEN },
    })

    // Adaptive seed batching: start at params.chunkSize and, on an out-of-memory
    // error, halve the batch and retry the SAME seed range (down to MIN_CHUNK)
    // before giving up — so even a first batch that is too dense to read back can
    // still make progress instead of failing the whole run.
    let start = 0
    let chunkSize = params.chunkSize
    while (start < nSeedsTotal) {
      if (shouldStop?.()) break // superseded by a newer load — stop and free GPU
      const nseeds = Math.min(chunkSize, nSeedsTotal - start)
      const chunk = seeds.subarray(start * 3, (start + nseeds) * 3)
      const gridX = divUp(nseeds, BLOCK_Y)

      // Every per-chunk buffer is tracked so the finally frees it on any path
      // (validation error, readback rejection, throw) — not just success.
      const perChunk: GPUBuffer[] = []
      const track = (b: GPUBuffer): GPUBuffer => {
        perChunk.push(b)
        return b
      }
      // Stage this batch's streamlines locally and only merge into `out` once the
      // whole batch reads back — a mid-batch OOM retry must not double-count.
      const batchOut: Float32Array[] = []
      try {
        const seedsBuf = track(storageFromData(device, chunk, 'seeds'))
        const offsBuf = track(
          emptyStorage(device, (nseeds + 1) * 4, 'slinesOffs'),
        )
        device.queue.writeBuffer(offsBuf, 0, new Int32Array(nseeds + 1))
        const shDirBytes = inputs.samplmNr * gridX * BLOCK_Y * 3 * REAL_SIZE
        const shDirBuf = track(emptyStorage(device, shDirBytes, 'shDirTemp0'))

        // Pass 1: count streamlines per seed. getNum's auto layout omits
        // metric_map and the output buffers, so they're not bound here.
        const paramsGetnum = track(
          paramsBuffer(
            device,
            packBootParams(inputs, off, params, nseeds, start, false),
          ),
        )
        const counted = await dispatchBootWindows(device, getnumPipe, gridX, [
          bindGroup0(
            device,
            getnumPipe,
            paramsGetnum,
            seedsBuf,
            datafBuf,
            null,
            edgesBuf,
          ),
          bindGroup1(device, getnumPipe, modelBuf),
          bindGroup2(device, getnumPipe, offsBuf, shDirBuf, null),
        ], paramsGetnum, shouldStop, params.maxWorkgroupsPerDispatch)
        if (!counted) break

        // Exclusive prefix sum of per-seed counts (CPU), written back.
        const counts = new Int32Array(
          await readback(device, offsBuf, (nseeds + 1) * 4),
        )
        if (counts.subarray(0, nseeds).some(count => count < 0)) {
          throw subgroupSizeError('ran the seed-count pass with another subgroup layout')
        }
        const offsets = new Int32Array(nseeds + 1)
        for (let i = 0; i < nseeds; i++) offsets[i + 1] = offsets[i] + counts[i]
        const nSlines = offsets[nseeds]
        device.queue.writeBuffer(offsBuf, 0, offsets)

        if (nSlines > 0) {
          const stride = MAX_SLINE_LEN * 2 * 3
          const slineBytes = stride * nSlines * REAL_SIZE
          if (slineBytes > maxBinding) {
            // Too many streamlines for one GPU buffer — same decision tree as an
            // OOM: shrink and retry, salvage a partial at the floor, else a hard
            // "lower the density" error.
            const plan = planBatchError({
              oom: true,
              lost: false,
              chunkSize,
              hasOutput: out.length > 0,
            })
            if (plan === 'shrink') {
              chunkSize = nextChunkSize(chunkSize)
              continue
            }
            if (plan === 'salvage') {
              truncated = true
              break
            }
            const maxSlines = Math.floor(maxBinding / (stride * REAL_SIZE))
            throw new Error(
              `${nseeds.toLocaleString()} seeds produced ${nSlines.toLocaleString()} streamlines ` +
                `(${(slineBytes / 1e9).toFixed(1)} GB), over the GPU's ` +
                `${(maxBinding / 1e9).toFixed(1)} GB buffer limit — lower the seed density ` +
                `(max ~${maxSlines.toLocaleString()} streamlines/batch).`,
            )
          }
          // Interleaved [seed, len] per streamline (seed at 2i, len at 2i+1) — one
          // buffer instead of two, to fit the 10-storage-buffer budget.
          const metaInit = new Int32Array(2 * nSlines)
          for (let i = 0; i < nSlines; i++) metaInit[2 * i] = -1 // seed default -1; len 0
          const slineMetaBuf = track(
            storageFromData(device, metaInit, 'slineMeta'),
          )
          const slineBuf = track(emptyStorage(device, slineBytes, 'sline'))

          // Pass 2: generate streamlines.
          const paramsGen = track(
            paramsBuffer(
              device,
              packBootParams(inputs, off, params, nseeds, start, true),
            ),
          )
          const generated = await dispatchBootWindows(device, genPipe, gridX, [
            bindGroup0(
              device,
              genPipe,
              paramsGen,
              seedsBuf,
              datafBuf,
              metricBuf,
              edgesBuf,
            ),
            bindGroup1(device, genPipe, modelBuf),
            bindGroup2(
              device,
              genPipe,
              offsBuf,
              shDirBuf,
              slineMetaBuf,
              slineBuf,
            ),
          ], paramsGen, shouldStop, params.maxWorkgroupsPerDispatch)
          if (!generated) break

          // Read positions back in fixed-size windows so peak host (and staging)
          // memory is bounded by READBACK_WINDOW_BYTES, not by the whole batch —
          // the batch buffer reserves MAX_SLINE_LEN points per streamline even
          // though most are far shorter, so the full copy is the memory bottleneck.
          const meta = new Int32Array(
            await readback(device, slineMetaBuf, 2 * nSlines * 4),
          )
          for (let i = 1; i < meta.length; i += 2) {
            if (meta[i] < 0) {
              throw subgroupSizeError('ran the streamline pass with another subgroup layout')
            }
          }
          const winSlines = Math.max(
            1,
            Math.floor(READBACK_WINDOW_BYTES / (stride * REAL_SIZE)),
          )
          for (let base = 0; base < nSlines; base += winSlines) {
            if (shouldStop?.()) break // superseded mid-readback — abort this batch
            const n = Math.min(winSlines, nSlines - base)
            const data = new Float32Array(
              await readback(
                device,
                slineBuf,
                n * stride * REAL_SIZE,
                base * stride * REAL_SIZE,
              ),
            )
            for (let jj = 0; jj < n; jj++) {
              const npts = meta[2 * (base + jj) + 1] // odd entries are lengths
              if (npts <= 0 || npts < params.minPts || npts > params.maxPts)
                continue
              batchOut.push(data.slice(jj * stride, jj * stride + npts * 3))
            }
          }
        }
        // A new load arrived during this batch — drop it uncommitted and stop;
        // the caller discards the whole run via its loadSeq guard.
        if (shouldStop?.()) break
        // Batch fully read back — commit it and advance.
        for (const s of batchOut) out.push(s)
        start += nseeds
        processedSeeds = start
        onProgress?.(start, nSeedsTotal)
        // Grow cautiously toward the full batch instead of jumping back to it,
        // so a GPU where only a reduced batch fits doesn't re-fail full-size
        // allocations every batch.
        chunkSize = growChunkSize(chunkSize, params.chunkSize)
      } catch (err) {
        const plan = planBatchError({
          oom: isOomError(err),
          lost: isDeviceLost(err),
          chunkSize,
          hasOutput: out.length > 0,
        })
        if (plan === 'shrink') {
          chunkSize = nextChunkSize(chunkSize) // retry smaller, same seeds
          continue
        }
        if (plan === 'salvage') {
          truncated = true // at the floor / device lost — keep what we have
          deviceLost = isDeviceLost(err)
          break
        }
        throw err
      } finally {
        for (const b of perChunk) b.destroy()
      }
    }
  } finally {
    for (const b of staticBuffers) b.destroy()
  }
  return { lines: out, truncated, deviceLost, processedSeeds, totalSeeds: nSeedsTotal }
}

function paramsBuffer(device: GPUDevice, bytes: ArrayBuffer): GPUBuffer {
  const buf = device.createBuffer({
    size: bytes.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    mappedAtCreation: true,
    label: 'params',
  })
  new Uint8Array(buf.getMappedRange()).set(new Uint8Array(bytes))
  buf.unmap()
  return buf
}

// Group 0 (repacked): params(0), seeds(1), dataf(2)=[signal|verts], metric_map(3),
// sphere_edges(4). With layout:'auto', getNum's layout omits metric_map(3) — pass
// metric=null there. Bindings are by explicit index, so gaps are fine.
function bindGroup0(
  device: GPUDevice,
  pipeline: GPUComputePipeline,
  params: GPUBuffer,
  seeds: GPUBuffer,
  dataf: GPUBuffer,
  metric: GPUBuffer | null,
  edges: GPUBuffer,
): GPUBindGroup {
  const entries: GPUBindGroupEntry[] = [
    { binding: 0, resource: { buffer: params } },
    { binding: 1, resource: { buffer: seeds } },
    { binding: 2, resource: { buffer: dataf } },
    { binding: 4, resource: { buffer: edges } },
  ]
  if (metric) entries.push({ binding: 3, resource: { buffer: metric } })
  return device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries,
  })
}

// Group 1 (repacked): a single modelData buffer.
function bindGroup1(
  device: GPUDevice,
  pipeline: GPUComputePipeline,
  modelData: GPUBuffer,
): GPUBindGroup {
  return device.createBindGroup({
    layout: pipeline.getBindGroupLayout(1),
    entries: [{ binding: 0, resource: { buffer: modelData } }],
  })
}

// Group 2 (repacked): slineOutOff(0), shDir0(1), slineMeta(2), sline(3).
// getNum binds only 0+1; gen binds slineMeta + sline too.
function bindGroup2(
  device: GPUDevice,
  pipeline: GPUComputePipeline,
  offs: GPUBuffer,
  shDir: GPUBuffer,
  slineMeta: GPUBuffer | null,
  sline?: GPUBuffer | null,
): GPUBindGroup {
  const entries: GPUBindGroupEntry[] = [
    { binding: 0, resource: { buffer: offs } },
    { binding: 1, resource: { buffer: shDir } },
  ]
  if (slineMeta) entries.push({ binding: 2, resource: { buffer: slineMeta } })
  if (sline) entries.push({ binding: 3, resource: { buffer: sline } })
  return device.createBindGroup({
    layout: pipeline.getBindGroupLayout(2),
    entries,
  })
}
