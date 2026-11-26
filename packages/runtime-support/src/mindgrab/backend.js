// Which MindGrab backend `auto` should run. `chooseBackend` is pure, so Node tests it with literal
// probes; `withBackendChoice` wraps the MindGrab module a caller pins with the browser probes.
//
// MindGrab's own `auto` takes WebGPU, then WebGL2, then the threaded CPU module, and counts a
// software renderer as a GPU. On a machine without one (a VM, a remote desktop, a blocklisted
// driver) Chromium offers SwiftShader for both APIs: the WebGPU adapter lacks shader-f16, so
// MindGrab moves on to WebGL2, which then emulates every shader on the CPU and did not finish
// in 9 minutes, where the threaded CPU module segments the same image in about 25 s.
// So a software renderer is used only when the CPU module cannot run (no cross-origin isolation).

// Names of software rasterisers as GPUAdapterInfo and WebGL report them: SwiftShader, Mesa's
// llvmpipe, lavapipe and softpipe, and Windows' WARP (Microsoft Basic Render Driver). The sdc
// WebGPU path and test-utils/hardware-gpu.mjs use this same check.
const SOFTWARE = /swiftshader|llvmpipe|lavapipe|softpipe|software|basic render|microsoft basic|\bwarp\b|\bcpu\b/i

/** True when a WebGPU adapter is emulated on the CPU. `info` holds the fields of GPUAdapterInfo. */
export function isSoftwareAdapter(info = {}) {
  if (!info) return false
  if (info.isFallbackAdapter) return true
  return [info.vendor, info.architecture, info.device, info.description].some((field) => SOFTWARE.test(field ?? ''))
}

/** True when a WebGL2 context is emulated: its unmasked renderer names a software rasteriser, or
 *  Chromium refused a context with `failIfMajorPerformanceCaveat` (`caveat`). */
export function isSoftwareRenderer(probe) {
  if (!probe) return false
  const { renderer = '', caveat = false } = probe
  return caveat || SOFTWARE.test(renderer)
}

/**
 * The backend to request for `auto`.
 *
 * `webgpu` is `{ supported, software, info }`: `supported` is MindGrab's checkSupport.
 * `webgl2` is `{ supported, software, renderer, caveat }`, or a function returning it, called
 * only when hardware WebGPU is unavailable, so a GPU machine is probed no further than MindGrab
 * probes it. `cpu` is whether the threaded module can run here.
 * Returns `null` when the only supported GPU/WebGL2 backend is a software rasteriser and CPU is
 * unavailable (so the caller refuses it instead of letting Core's `auto` pick it), and `'auto'`
 * when nothing is supported at all so MindGrab reports every refusal.
 */
export function chooseBackend({ webgpu, webgl2, cpu = false }) {
  const gpu = Boolean(webgpu?.supported)
  const gpuSoftware = Boolean(webgpu?.software) || isSoftwareAdapter(webgpu?.info)
  if (gpu && !gpuSoftware) return 'webgpu'
  const context = typeof webgl2 === 'function' ? webgl2() : webgl2
  const gl = Boolean(context?.supported)
  const glSoftware = Boolean(context?.software) || isSoftwareRenderer(context)
  const glUnknown = !glSoftware && (context && Object.hasOwn(context, 'software') ? context.software === undefined : !context?.renderer)
  if (gl && !glSoftware && !glUnknown) return 'webgl2'
  if (cpu) return 'cpu'
  if (gl && !glSoftware) return 'webgl2'
  if ((gpu && gpuSoftware) || (gl && glSoftware)) return null
  return 'auto'
}

async function probeWebgpu(mindgrab, model) {
  const { supported, software } = await mindgrab.checkSupport(model)
  const adapter = supported ? await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' }) : null
  const info = adapter?.info ?? {}
  return {
    supported,
    software,
    info: {
      vendor: info.vendor,
      architecture: info.architecture,
      device: info.device,
      description: info.description,
      isFallbackAdapter: info.isFallbackAdapter ?? adapter?.isFallbackAdapter,
    },
  }
}

// A worker has OffscreenCanvas; a page may only have a canvas element.
const canvas = () => typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(1, 1) : typeof document === 'object' ? document.createElement('canvas') : null

function probeWebgl2(mindgrab, model) {
  const result = mindgrab.checkWebgl2Support(model)
  const { supported, renderer } = result
  const softwareField = Object.hasOwn(result, 'software') ? { software: result.software } : {}
  const probe = supported ? canvas() : null
  if (!probe) return { supported: false, renderer, ...softwareField }
  // Chromium refuses this context when it would be software-rendered.
  const caveat = !probe.getContext('webgl2', { failIfMajorPerformanceCaveat: true })
  return { supported, renderer, ...softwareField, caveat }
}

const describe = (probe, name) => !probe ? 'not probed' : !probe.supported ? 'unsupported' : `${name(probe)}${probe.caveat ? ' (performance caveat)' : ''}`

async function resolveBackend(mindgrab, { backend = 'auto', model, onLog }) {
  if (backend !== 'auto') return backend
  const webgpu = await probeWebgpu(mindgrab, model)
  let webgl2
  const cpuSupport = mindgrab.checkCpuSupport()
  const choice = chooseBackend({
    webgpu,
    webgl2: () => (webgl2 = probeWebgl2(mindgrab, model)),
    cpu: cpuSupport.supported,
  })
  const adapter = ({ info }) => [info.vendor, info.architecture, info.device, info.description].filter(Boolean).join(' ') || 'unnamed adapter'
  const summary = `WebGPU ${describe(webgpu, adapter)}; WebGL2 ${describe(webgl2, (gl) => gl.renderer || 'unnamed renderer')}`
  if (choice === null) {
    const cpuReason = cpuSupport.reasons?.join('; ') || 'cross-origin isolation is unavailable'
    const message = `no usable MindGrab backend: only software GPU rendering is available (${summary}), and the CPU backend cannot run here (${cpuReason})`
    onLog?.(`MindGrab: ${message}`)
    const ErrorClass = mindgrab.BrainchopError
    throw ErrorClass ? new ErrorClass('no-webgpu', message) : Object.assign(new Error(message), { code: 'no-webgpu' })
  }
  onLog?.(`MindGrab: auto runs on ${choice} (${summary})`)
  return choice
}

/**
 * MindGrab's `segment` and `segmentTissues` with `auto` resolved by chooseBackend before each
 * call, so a software renderer never beats the CPU module. `mindgrab` is the module the caller
 * pins (`import * as mindgrab from '@brainchop/core'`). The choice goes to `options.onLog`.
 */
export function withBackendChoice(mindgrab) {
  const resolving = (run) => async (input, options) => run(input, { ...options, backend: await resolveBackend(mindgrab, options) })
  return { segment: resolving(mindgrab.segment), segmentTissues: resolving(mindgrab.segmentTissues) }
}
