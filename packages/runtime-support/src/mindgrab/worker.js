import * as mindgrab from '@brainchop/mindgrab'
import { withBackendChoice } from './backend.js'

const { segment, segmentTissues } = withBackendChoice(mindgrab)

self.onmessage = async ({ data: { input, tissues, options } }) => {
  try {
    const run = tissues ? segmentTissues : segment
    const onLog = (line) => self.postMessage({ log: line })
    const result = await run(input, { ...options, onLog, worker: false, timeoutMs: 900000 })
    self.postMessage({ result })
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) })
  }
}
