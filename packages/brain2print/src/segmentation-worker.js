import { segment, segmentTissues, checkSupport, checkWebgl2Support, checkCpuSupport } from '@brainchop/mindgrab'
import { chooseBackend } from './backend.js'

async function probeWebgpu(model) {
  const { supported } = await checkSupport(model)
  const adapter = supported ? await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }) : null
  const info = adapter?.info ?? {}
  return {
    supported,
    info: {
      vendor: info.vendor,
      architecture: info.architecture,
      device: info.device,
      description: info.description,
      isFallbackAdapter: info.isFallbackAdapter ?? adapter?.isFallbackAdapter,
    },
  }
}

function probeWebgl2(model) {
  const { supported, renderer } = checkWebgl2Support(model)
  // Chromium refuses this context when it would be software-rendered.
  const caveat = supported && !new OffscreenCanvas(1, 1).getContext('webgl2', { failIfMajorPerformanceCaveat: true })
  return { supported, renderer, caveat }
}

// `auto` is resolved here rather than by MindGrab, so a software renderer never wins over the CPU module.
async function resolveBackend(backend, model) {
  if (backend !== 'auto') return backend
  const webgpu = await probeWebgpu(model)
  return chooseBackend({ webgpu, webgl2: () => probeWebgl2(model), cpu: checkCpuSupport().supported })
}

self.onmessage = async ({ data: { input, tissues, options } }) => {
  try {
    const run = tissues ? segmentTissues : segment
    const backend = await resolveBackend(options.backend ?? 'auto', options.model)
    const result = await run(input, { ...options, backend, worker: false, timeoutMs: 900000 })
    self.postMessage({ result })
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) })
  }
}
