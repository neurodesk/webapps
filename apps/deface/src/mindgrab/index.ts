/**
 * mindgrab brain extraction (WebGPU), lifted from brain2print's validated
 * pipeline. Produces a brain mask for the b0 so the tensor fit can be
 * background-free.
 *
 * Flow (the caller wires it): conform the b0 to 256³ 1 mm FreeSurfer-canonical
 * via the `conform` VolumeTransform (an NVImage + extension context), normalize
 * + transpose to the model's z-fastest order, run the tinygrad-generated
 * mindgrab model, then serialize the label volume back to NIfTI in conformed
 * space. niimath reslices it to the native DWI grid (no dilation by default).
 *
 * Requires WebGPU with `shader-f16` and ~1.4 GB max buffer (recent desktop
 * Chrome/Edge). Returns null device when unavailable so the caller can fall
 * back to an unmasked fit.
 */

import type { NVExtensionContext, NVImage } from '@niivue/niivue'
import mindgrabImpl from './model'
import { writeUint8LabelNifti } from './nifti-writer'

const CONFORM_DIM = 256
const EXPECTED_VOXELS = CONFORM_DIM * CONFORM_DIM * CONFORM_DIM
const SPACING_EPSILON = 1e-4
/** ~1.4 GB — a 256³ Float32 volume × a few intermediate tensors. */
const REQUIRED_BUFFER_BYTES = 1_409_286_144

export type MindgrabInferer = {
  (img32: Float32Array): Promise<Float32Array[]>
  dispose: () => Promise<void>
}

type GeneratedInferer = (img32: Float32Array) => Promise<Float32Array[]>
type ModelImpl = {
  load: (device: GPUDevice, weights: Uint8Array) => Promise<GeneratedInferer>
}

// --- GPU device ---

/** WebGPU device with the features/limits mindgrab needs, or null if absent. */
export async function getBrainGPUDevice(): Promise<GPUDevice | null> {
  if (typeof navigator === 'undefined' || !navigator.gpu) return null
  const adapter = await navigator.gpu.requestAdapter()
  if (!adapter) return null
  if (!adapter.features.has('shader-f16')) return null
  if (adapter.limits.maxStorageBufferBindingSize < REQUIRED_BUFFER_BYTES) {
    return null
  }
  if (adapter.limits.maxBufferSize < REQUIRED_BUFFER_BYTES) return null
  try {
    return await adapter.requestDevice({
      requiredFeatures: ['shader-f16'],
      requiredLimits: {
        maxStorageBufferBindingSize: REQUIRED_BUFFER_BYTES,
        maxBufferSize: REQUIRED_BUFFER_BYTES,
      },
    })
  } catch {
    return null
  }
}

// --- model load (tracks GPU buffers so dispose() can release them) ---

function destroyBuffers(buffers: GPUBuffer[]): void {
  for (const buffer of buffers) {
    try {
      buffer.destroy()
    } catch {
      // device loss / double-destroy shouldn't mask the caller's cleanup
    }
  }
  buffers.length = 0
}

function createTrackingDevice(
  device: GPUDevice,
  buffers: GPUBuffer[],
): GPUDevice {
  const tracking = {
    createBindGroup: device.createBindGroup.bind(device),
    createBindGroupLayout: device.createBindGroupLayout.bind(device),
    createBuffer: (d: GPUBufferDescriptor): GPUBuffer => {
      const b = device.createBuffer(d)
      buffers.push(b)
      return b
    },
    createCommandEncoder: device.createCommandEncoder.bind(device),
    createComputePipelineAsync: device.createComputePipelineAsync.bind(device),
    createPipelineLayout: device.createPipelineLayout.bind(device),
    createShaderModule: device.createShaderModule.bind(device),
    queue: device.queue,
  }
  return tracking as unknown as GPUDevice
}

/** Load mindgrab and return an inferer; `dispose()` frees its GPU buffers. */
export async function loadMindgrab(
  device: GPUDevice,
  weights: ArrayBuffer | Uint8Array | string,
): Promise<MindgrabInferer> {
  let bytes: Uint8Array
  if (typeof weights === 'string') {
    const res = await fetch(weights)
    if (!res.ok) {
      throw new Error(`could not load mindgrab weights (${res.status})`)
    }
    bytes = new Uint8Array(await res.arrayBuffer())
  } else {
    bytes = new Uint8Array(weights)
  }
  const tracked: GPUBuffer[] = []
  let generated: GeneratedInferer
  try {
    generated = await (mindgrabImpl as unknown as ModelImpl).load(
      createTrackingDevice(device, tracked),
      bytes,
    )
  } catch (err) {
    destroyBuffers(tracked)
    throw err
  }

  let disposed = false
  const inferer = ((img32: Float32Array) => {
    if (disposed) return Promise.reject(new Error('mindgrab inferer disposed'))
    if (img32.length !== EXPECTED_VOXELS) {
      return Promise.reject(
        new Error(
          `mindgrab expected ${EXPECTED_VOXELS} voxels, got ${img32.length}`,
        ),
      )
    }
    return generated(img32)
  }) as MindgrabInferer
  inferer.dispose = async () => {
    if (disposed) return
    disposed = true
    destroyBuffers(tracked)
  }
  return inferer
}

// --- input prep: conform + normalize + transpose to the model's voxel order ---

// NIfTI memory order is x-fastest; the tinygrad model wants z-fastest.
function transposeToModel(data: Float32Array, size: number): Float32Array {
  const out = new Float32Array(data.length)
  let it = 0
  for (let x = 0; x < size; x++)
    for (let y = 0; y < size; y++)
      for (let z = 0; z < size; z++)
        out[it++] = data[x + y * size + z * size * size]
  return out
}

// Inverse transpose model-order labels → NIfTI-order Uint8 (clamped 0..255).
function transposeFromModelAsLabels(
  data: Float32Array,
  size: number,
): Uint8Array {
  const out = new Uint8Array(data.length)
  let it = 0
  for (let x = 0; x < size; x++)
    for (let y = 0; y < size; y++)
      for (let z = 0; z < size; z++) {
        const v = data[it++]
        out[x + y * size + z * size * size] =
          v > 0 ? (v < 255 ? Math.round(v) : 255) : 0
      }
  return out
}

/**
 * Conform `volume` to 256³ 1 mm (caller must have registered the `conform`
 * transform on `ctx`) and return the conformed NVImage plus a normalized,
 * model-ordered Float32 volume.
 */
export async function prepareInput(
  ctx: NVExtensionContext,
  volume: NVImage,
): Promise<{ conformed: NVImage; img32: Float32Array }> {
  const p = volume.permRAS
  const px = volume.hdr.pixDims
  const isConformed =
    volume.dims[1] === CONFORM_DIM &&
    volume.dims[2] === CONFORM_DIM &&
    volume.dims[3] === CONFORM_DIM &&
    p?.[0] === -1 &&
    p?.[1] === 3 &&
    p?.[2] === -2 &&
    Math.abs((px?.[1] ?? 0) - 1) < SPACING_EPSILON &&
    Math.abs((px?.[2] ?? 0) - 1) < SPACING_EPSILON &&
    Math.abs((px?.[3] ?? 0) - 1) < SPACING_EPSILON
  const conformed = isConformed
    ? volume
    : await ctx.applyVolumeTransform('conform', volume, {
        toRAS: false,
        isLinear: true,
        asFloat32: true,
        isRobustMinMax: false,
      })
  if (!conformed.img)
    throw new Error('prepareInput: conformed volume has no image data')
  if (
    conformed.dims[1] !== CONFORM_DIM ||
    conformed.dims[2] !== CONFORM_DIM ||
    conformed.dims[3] !== CONFORM_DIM ||
    conformed.img.length !== EXPECTED_VOXELS
  ) {
    throw new Error('prepareInput: conform did not produce 256³ data')
  }
  const native = new Float32Array(conformed.img as ArrayLike<number>)
  const img32 = transposeToModel(native, CONFORM_DIM)
  let mn = Infinity
  let mx = -Infinity
  for (const v of img32) {
    if (!Number.isFinite(v)) continue
    if (v < mn) mn = v
    if (v > mx) mx = v
  }
  const range = mx - mn
  if (Number.isFinite(range) && range > 0) {
    const scale = 1 / range
    for (let i = 0; i < img32.length; i++) {
      const v = img32[i]
      img32[i] = Number.isFinite(v) ? (v - mn) * scale : 0
    }
  } else {
    img32.fill(0)
  }
  return { conformed, img32 }
}

/** Serialize mindgrab labels (model order) → a Uint8 mask NIfTI in conformed
 *  space (ready for niimath to reslice to the native DWI grid). */
export function buildMaskNifti(
  conformed: NVImage,
  labels: Float32Array,
): ArrayBuffer {
  if (labels.length !== EXPECTED_VOXELS) {
    throw new Error(
      `buildMaskNifti expected ${EXPECTED_VOXELS} labels, got ${labels.length}`,
    )
  }
  const niftiOrder = transposeFromModelAsLabels(labels, CONFORM_DIM)
  return writeUint8LabelNifti(conformed.hdr, niftiOrder)
}
