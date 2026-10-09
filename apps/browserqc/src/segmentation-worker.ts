import { segment, segmentTissues, type SegmentOptions } from '@brainchop/mindgrab'
import { segmentForQc } from '@neurodesk/browserqc'
import { parseModel } from './models'

self.onmessage = async ({ data }: MessageEvent<unknown>) => {
  try {
    if (!data || typeof data !== 'object' || !('input' in data) || !(data.input instanceof Uint8Array)
      || !('backend' in data) || (data.backend !== 'auto' && data.backend !== 'cpu')
      || !('assetPath' in data) || typeof data.assetPath !== 'string' || !('model' in data)) throw new Error('Invalid segmentation request.')
    const model = parseModel(data.model)
    const options = { backend: data.backend, worker: false, assetPath: data.assetPath, timeoutMs: 15 * 60_000 } satisfies Omit<SegmentOptions, 'model'>
    const result = await segmentForQc({ segment, segmentTissues }, data.input, model, options)
    const images = result.kind === 'pve' ? [result.tissues.csf, result.tissues.gm, result.tissues.wm] : [result.image]
    self.postMessage(result, { transfer: [result.mask, ...images] })
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) })
  }
}
