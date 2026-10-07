import { segment, segmentTissues, type SegmentOptions } from '@brainchop/mindgrab'
import { parseModel } from './models'

self.onmessage = async ({ data }: MessageEvent<unknown>) => {
  try {
    if (!data || typeof data !== 'object' || !('input' in data) || !(data.input instanceof Uint8Array)
      || !('backend' in data) || (data.backend !== 'auto' && data.backend !== 'cpu')
      || !('assetPath' in data) || typeof data.assetPath !== 'string' || !('model' in data)) throw new Error('Invalid segmentation request.')
    const model = parseModel(data.model)
    const options = { backend: data.backend, worker: false, assetPath: data.assetPath, timeoutMs: 15 * 60_000 } satisfies Omit<SegmentOptions, 'model'>
    const brain = await segment(data.input, { ...options, model: 'mindgrab', mask: true })
    if (!brain.mask) throw new Error('Brain extraction returned no mask.')
    if (model === 'mindmap-pve') {
      const result = await segmentTissues(data.input, { ...options, model: 'mindmap' })
      self.postMessage({ kind: 'pve', tissues: { csf: result.tissues.csf, gm: result.tissues.gm, wm: result.tissues.wm }, mask: brain.mask, backend: result.backend, elapsedMs: brain.elapsedMs + result.elapsedMs },
        { transfer: [brain.mask, result.tissues.csf, result.tissues.gm, result.tissues.wm] })
    } else {
      const result = await segment(data.input, { ...options, model })
      self.postMessage({ kind: 'labels', image: result.image, mask: brain.mask, backend: result.backend, elapsedMs: brain.elapsedMs + result.elapsedMs },
        { transfer: [brain.mask, result.image] })
    }
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) })
  }
}
