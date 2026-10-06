import type { SegmentResult } from '@brainchop/mindgrab'
import mindgrabPackage from '@brainchop/mindgrab/package.json' with { type: 'json' }
import type { Model } from './models'
import { runAbortable } from '@neurodesk/webapp-components/automation'

export type SegmentationBackend = 'auto' | 'cpu'
type SegmentationTiming = Pick<SegmentResult, 'backend' | 'elapsedMs'>
export type SegmentationResult = SegmentationTiming & (
  { kind: 'labels'; image: ArrayBuffer; mask: ArrayBuffer } |
  { kind: 'pve'; tissues: { csf: ArrayBuffer; gm: ArrayBuffer; wm: ArrayBuffer }; mask: ArrayBuffer }
)
function isImage(value: unknown): value is ArrayBuffer {
  return value instanceof ArrayBuffer && value.byteLength > 0
}
export const SEGMENTATION_TIMEOUT_MS = 15 * 60_000

export function parseSegmentationResult(value: unknown): SegmentationResult {
  if (!value || typeof value !== 'object' || !('mask' in value) || !isImage(value.mask)
    || !('backend' in value) || !('elapsedMs' in value) || typeof value.elapsedMs !== 'number'
    || !Number.isFinite(value.elapsedMs) || value.elapsedMs < 0) throw new Error('Segmentation worker returned an invalid result.')
  const { mask, backend, elapsedMs } = value
  if (backend !== 'cpu' && backend !== 'webgpu' && backend !== 'webgl2') throw new Error('Unknown segmentation backend.')
  if ('kind' in value && value.kind === 'labels' && 'image' in value && isImage(value.image)) {
    return { kind: 'labels', image: value.image, mask, backend, elapsedMs }
  }
  if ('kind' in value && value.kind === 'pve' && 'tissues' in value && value.tissues && typeof value.tissues === 'object') {
    const tissues = value.tissues
    if ('csf' in tissues && isImage(tissues.csf) && 'gm' in tissues && isImage(tissues.gm) && 'wm' in tissues && isImage(tissues.wm)) {
      return { kind: 'pve', tissues: { csf: tissues.csf, gm: tissues.gm, wm: tissues.wm }, mask, backend, elapsedMs }
    }
  }
  throw new Error('Segmentation worker returned invalid tissue images.')
}

export async function runSegmentation(input: Uint8Array, backend: SegmentationBackend, model: Model, signal: AbortSignal): Promise<SegmentationResult> {
  signal.throwIfAborted()
  const worker = new Worker(new URL('./segmentation-worker.ts', import.meta.url), { type: 'module' })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await runAbortable(signal, () => new Promise<SegmentationResult>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Segmentation timed out.')), SEGMENTATION_TIMEOUT_MS)
      worker.onmessage = ({ data }: MessageEvent<unknown>) => {
        try {
          if (data && typeof data === 'object' && 'error' in data && typeof data.error === 'string') throw new Error(data.error)
          resolve(parseSegmentationResult(data))
        } catch (error) { reject(error) }
      }
      worker.onerror = event => reject(new Error(event.message || 'Segmentation worker failed.'))
      worker.onmessageerror = () => reject(new Error('Segmentation worker returned an unreadable result.'))
      worker.postMessage({ input, backend, model, assetPath: new URL(`${import.meta.env.BASE_URL}brainchop/${mindgrabPackage.version}/`, document.baseURI).href })
    }), () => worker.terminate())
  } finally {
    clearTimeout(timer)
    worker.terminate()
  }
}
