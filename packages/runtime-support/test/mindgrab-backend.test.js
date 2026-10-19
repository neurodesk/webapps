import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chooseBackend, isSoftwareAdapter, isSoftwareRenderer, withBackendChoice } from '../src/mindgrab/backend.js'

// Strings as Chromium reports them.
const swiftshaderAdapter = { vendor: 'google', architecture: 'swiftshader', device: '', description: 'SwiftShader Device (Subzero)', isFallbackAdapter: false }
const appleAdapter = { vendor: 'apple', architecture: 'metal-3', device: '', description: '', isFallbackAdapter: false }
const nvidiaAdapter = { vendor: 'nvidia', architecture: 'ampere', device: '', description: 'NVIDIA GeForce RTX 3080' }
const swiftshaderGl = 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)'
const metalGl = 'ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Pro, Unspecified Version)'
const nvidiaGl = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Direct3D11 vs_5_0 ps_5_0, D3D11)'

test('software WebGPU adapters are recognised by name or by the fallback flag', () => {
  assert.equal(isSoftwareAdapter(swiftshaderAdapter), true)
  assert.equal(isSoftwareAdapter({ vendor: 'mesa', architecture: '', description: 'llvmpipe (LLVM 17.0.6, 256 bits)' }), true)
  assert.equal(isSoftwareAdapter({ vendor: 'mesa', description: 'lavapipe' }), true)
  assert.equal(isSoftwareAdapter({ vendor: 'microsoft', description: 'Microsoft Basic Render Driver' }), true)
  assert.equal(isSoftwareAdapter({ vendor: 'apple', isFallbackAdapter: true }), true)
  assert.equal(isSoftwareAdapter(appleAdapter), false)
  assert.equal(isSoftwareAdapter(nvidiaAdapter), false)
  assert.equal(isSoftwareAdapter({}), false)
})

test('software WebGL2 renderers are recognised by name or by a performance-caveat refusal', () => {
  assert.equal(isSoftwareRenderer({ renderer: swiftshaderGl }), true)
  assert.equal(isSoftwareRenderer({ renderer: 'llvmpipe (LLVM 15.0.7, 256 bits)' }), true)
  assert.equal(isSoftwareRenderer({ renderer: 'softpipe' }), true)
  assert.equal(isSoftwareRenderer({ renderer: 'Google SwiftShader' }), true)
  assert.equal(isSoftwareRenderer({ renderer: 'ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)' }), true)
  assert.equal(isSoftwareRenderer({ renderer: 'WebKit WebGL', caveat: true }), true)
  assert.equal(isSoftwareRenderer({ renderer: metalGl, caveat: false }), false)
  assert.equal(isSoftwareRenderer({ renderer: nvidiaGl }), false)
})

test('a machine with only SwiftShader runs the threaded CPU module', () => {
  // Headless Chromium without a GPU: the WebGPU adapter lacks shader-f16, WebGL2 is SwiftShader.
  const choice = chooseBackend({ webgpu: { supported: false, info: swiftshaderAdapter }, webgl2: { supported: true, renderer: swiftshaderGl, caveat: true }, cpu: true })
  assert.equal(choice, 'cpu')
  // Even a software adapter that passed every WebGPU check loses to the CPU module.
  assert.equal(chooseBackend({ webgpu: { supported: true, info: swiftshaderAdapter }, webgl2: { supported: true, renderer: swiftshaderGl }, cpu: true }), 'cpu')
  // A renderer string WEBGL_debug_renderer_info hides is still caught by the caveat probe.
  assert.equal(chooseBackend({ webgpu: { supported: false, info: {} }, webgl2: { supported: true, renderer: 'WebKit WebGL', caveat: true }, cpu: true }), 'cpu')
})

test('hardware keeps MindGrab\'s order: WebGPU, then WebGL2 when WebGPU lacks shader-f16', () => {
  let probed = false
  const webgl2 = () => {
    probed = true
    return { supported: true, renderer: metalGl, caveat: false }
  }
  assert.equal(chooseBackend({ webgpu: { supported: true, info: appleAdapter }, webgl2, cpu: true }), 'webgpu')
  assert.equal(probed, false, 'a usable hardware adapter needs no WebGL2 probe')
  // checkSupport reports supported: false for an adapter without shader-f16 or with short limits.
  assert.equal(chooseBackend({ webgpu: { supported: false, info: nvidiaAdapter }, webgl2, cpu: true }), 'webgl2')
  assert.equal(probed, true)
  assert.equal(chooseBackend({ webgpu: null, webgl2: { supported: true, renderer: nvidiaGl, caveat: false }, cpu: false }), 'webgl2')
})

test('without the CPU module a software renderer is still better than nothing', () => {
  assert.equal(chooseBackend({ webgpu: { supported: true, info: swiftshaderAdapter }, webgl2: { supported: true, renderer: swiftshaderGl }, cpu: false }), 'webgpu')
  assert.equal(chooseBackend({ webgpu: { supported: false, info: swiftshaderAdapter }, webgl2: { supported: true, renderer: swiftshaderGl }, cpu: false }), 'webgl2')
  assert.equal(chooseBackend({ webgpu: { supported: false }, webgl2: { supported: false }, cpu: true }), 'cpu')
  // Nothing at all: MindGrab's own auto explains every refusal.
  assert.equal(chooseBackend({ webgpu: { supported: false }, webgl2: { supported: false }, cpu: false }), 'auto')
})

// A MindGrab module whose probes report `support`, recording the backend each call receives.
function fakeMindgrab(support, calls) {
  const run = async (input, options) => {
    calls.push(options.backend)
    return { backend: options.backend }
  }
  return {
    checkSupport: async () => ({ supported: support.webgpu }),
    checkWebgl2Support: () => ({ supported: support.webgl2, renderer: '' }),
    checkCpuSupport: () => ({ supported: support.cpu }),
    segment: run,
    segmentTissues: run,
  }
}

test('withBackendChoice resolves auto before each call and logs the choice', async () => {
  const calls = []
  const lines = []
  const { segment, segmentTissues } = withBackendChoice(fakeMindgrab({ webgpu: false, webgl2: false, cpu: true }, calls))
  const onLog = (line) => lines.push(line)
  assert.deepEqual(await segment(new Uint8Array(), { model: 'mindgrab', backend: 'auto', onLog }), { backend: 'cpu' })
  assert.deepEqual(await segmentTissues(new Uint8Array(), { model: 'mindmap', onLog }), { backend: 'cpu' })
  assert.deepEqual(calls, ['cpu', 'cpu'])
  assert.equal(lines.length, 2)
  assert.match(lines[0], /^MindGrab: auto runs on cpu /)
  assert.match(lines[0], /WebGPU unsupported/)
})

test('withBackendChoice passes a named backend through without probing', async () => {
  const calls = []
  const mindgrab = fakeMindgrab({ webgpu: true, webgl2: true, cpu: true }, calls)
  mindgrab.checkSupport = async () => assert.fail('a named backend is not probed')
  const { segment } = withBackendChoice(mindgrab)
  assert.deepEqual(await segment(new Uint8Array(), { model: 'mindgrab', backend: 'webgl2' }), { backend: 'webgl2' })
  assert.deepEqual(calls, ['webgl2'])
})

test('withBackendChoice leaves auto to MindGrab when nothing is usable, so it reports why', async () => {
  const calls = []
  const { segment } = withBackendChoice(fakeMindgrab({ webgpu: false, webgl2: false, cpu: false }, calls))
  await segment(new Uint8Array(), { model: 'mindgrab' })
  assert.deepEqual(calls, ['auto'])
})
