// Which MindGrab backend `auto` should run. Pure, so Node can test it with literal probes.
//
// MindGrab's own `auto` takes WebGPU, then WebGL2, then the threaded CPU module, and counts a
// software renderer as a GPU. On a machine without one (a VM, a remote desktop, a blocklisted
// driver) Chromium offers SwiftShader for both APIs: the WebGPU adapter lacks shader-f16, so
// MindGrab moves on to WebGL2, which then emulates every shader on the CPU and did not finish
// in 9 minutes, where the threaded CPU module segments the same image in about 25 s.
// So a software renderer is used only when the CPU module cannot run (no cross-origin isolation).

const SOFTWARE = /swiftshader|llvmpipe|lavapipe|softpipe|software|basic render|microsoft basic/i

/** True when a WebGPU adapter is emulated on the CPU. `info` holds the fields of GPUAdapterInfo. */
export function isSoftwareAdapter(info = {}) {
  if (info.isFallbackAdapter) return true
  return [info.vendor, info.architecture, info.device, info.description].some((field) => SOFTWARE.test(field ?? ''))
}

/** True when a WebGL2 context is emulated: its unmasked renderer names a software rasteriser, or
 *  Chromium refused a context with `failIfMajorPerformanceCaveat` (`caveat`). */
export function isSoftwareRenderer({ renderer = '', caveat = false } = {}) {
  return caveat || SOFTWARE.test(renderer)
}

/**
 * The backend to request for `auto`.
 *
 * `webgpu` is `{ supported, info }`: `supported` is MindGrab's checkSupport (it already demands
 * shader-f16 and the activation-sized limits, so a hardware adapter without shader-f16 falls
 * through exactly as MindGrab's own `auto` does). `webgl2` is `{ supported, renderer, caveat }`,
 * or a function returning it, called only when hardware WebGPU is unavailable, so a GPU machine
 * is probed no further than MindGrab probes it. `cpu` is whether the threaded module can run here.
 * Returns `auto` only when nothing is usable, so MindGrab reports why.
 */
export function chooseBackend({ webgpu, webgl2, cpu = false }) {
  const gpu = Boolean(webgpu?.supported)
  if (gpu && !isSoftwareAdapter(webgpu.info)) return 'webgpu'
  const context = typeof webgl2 === 'function' ? webgl2() : webgl2
  const gl = Boolean(context?.supported)
  if (gl && !isSoftwareRenderer(context)) return 'webgl2'
  if (cpu) return 'cpu'
  if (gpu) return 'webgpu'
  if (gl) return 'webgl2'
  return 'auto'
}
