/**
 * The `conform` VolumeTransform for mindgrab — reslice any volume to a
 * 256×256×256 isotropic 1 mm FreeSurfer-canonical grid (the model's input).
 *
 * Extracts a few header primitives on the main thread, sends only numbers +
 * the image array to a Web Worker, and patches the header with the worker's
 * result. The worker never sees NIFTI objects.
 */
import type {
  NIFTI1,
  NIFTI2,
  TransformOptions,
  TypedVoxelArray,
  VolumeTransform,
} from '@niivue/niivue'
import { NVWorker } from '@niivue/niivue'
import ProcessingWorker from './conform-worker?worker&inline'

// --- shared worker (lazy singleton) ---

let bridge: NVWorker | null = null

function getBridge(): NVWorker {
  if (!bridge) bridge = new NVWorker(() => new ProcessingWorker())
  return bridge
}

/** Terminate the conform worker (app cleanup / HMR). The NiiVue extension context
 *  doesn't own this worker, so it must be torn down explicitly. */
export function disposeConformWorker(): void {
  bridge?.terminate()
  bridge = null
}

// --- worker result → patched NIFTI header ---

interface WorkerResult {
  img: TypedVoxelArray
  datatypeCode: number
  bitsPerVoxel: number
  sclSlope: number
  sclInter: number
  calMin: number
  calMax: number
}

interface ConformWorkerResult extends WorkerResult {
  dims?: number[]
  pixDims?: number[]
  affine?: number[]
}

async function run(
  name: string,
  hdr: NIFTI1 | NIFTI2,
  img: TypedVoxelArray | ArrayBuffer,
  options?: TransformOptions,
): Promise<{ hdr: NIFTI1 | NIFTI2; img: TypedVoxelArray }> {
  const result = await getBridge().execute<ConformWorkerResult>({
    name,
    img,
    datatypeCode: hdr.datatypeCode,
    sclSlope: hdr.scl_slope,
    sclInter: hdr.scl_inter,
    options,
  })
  // Clone input header and patch only the fields the worker changed
  const outHdr: NIFTI1 | NIFTI2 = JSON.parse(JSON.stringify(hdr))
  outHdr.datatypeCode = result.datatypeCode
  outHdr.numBitsPerVoxel = result.bitsPerVoxel
  outHdr.scl_slope = result.sclSlope
  outHdr.scl_inter = result.sclInter
  outHdr.cal_min = result.calMin
  outHdr.cal_max = result.calMax
  // Conform produces new geometry
  if (result.dims) outHdr.dims = result.dims
  if (result.pixDims) outHdr.pixDims = result.pixDims
  if (result.affine) {
    const a = result.affine
    outHdr.affine = [
      [a[0], a[1], a[2], a[3]],
      [a[4], a[5], a[6], a[7]],
      [a[8], a[9], a[10], a[11]],
      [0, 0, 0, 1],
    ]
    outHdr.sform_code = 1
    outHdr.qform_code = 0
  }
  return { hdr: outHdr, img: result.img }
}

export const conform: VolumeTransform = {
  name: 'conform',
  description:
    'Reslice to 256×256×256 isotropic 1 mm volume (FreeSurfer style)',
  options: [
    { name: 'toRAS', type: 'checkbox', label: 'Output RAS orientation', default: false },
    { name: 'isLinear', type: 'checkbox', label: 'Linear interpolation', default: true },
    { name: 'asFloat32', type: 'checkbox', label: 'Output as Float32', default: false },
    { name: 'isRobustMinMax', type: 'checkbox', label: 'Robust min/max (2%-98%)', default: false },
  ],
  apply: (hdr, img, opts) => {
    // Pass header geometry to the worker via options.
    const extOpts = {
      ...opts,
      dims: [...hdr.dims],
      pixDims: [...hdr.pixDims],
      affine: hdr.affine.flat(),
    }
    return run('conform', hdr, img, extOpts)
  },
}
