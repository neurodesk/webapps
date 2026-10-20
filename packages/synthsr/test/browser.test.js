import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserSession, browserRuntime, chooseBrowserBackend, planGpuGraph, GPU_IMPLEMENTATION } from '../src/browser.js';
import manifest from '../model.manifest.json' with { type: 'json' };
import graph from '../src/gpu-model.json' with { type: 'json' };

test('browser defaults to WASM with the supplied runtime and model', async () => {
  const bytes = new Uint8Array([1, 2]), session = {};
  const ort = { InferenceSession: { create(model, options) {
    assert.equal(model, bytes);
    assert.deepEqual(options, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
    return session;
  } } };
  assert.equal(await createBrowserSession(ort, bytes, undefined, [32, 32, 32]), session);
  assert.throws(() => createBrowserSession(ort, bytes, 'cuda'), /wasm or webgpu/);
});

test('WebGPU routes to the pinned custom executor and never falls back to ORT', async () => {
  const ort = { InferenceSession: { create() { assert.fail('GPU must not use ORT'); } } };
  await assert.rejects(createBrowserSession(ort, new Uint8Array(16), 'webgpu', [32, 32, 32]), /validated SynthSR model/);
  assert.deepEqual(browserRuntime('webgpu'), { gpuImplementation: GPU_IMPLEMENTATION });
  assert.deepEqual(browserRuntime(), { onnxRuntime: '1.29.0' });
  const asset = manifest.assets.find(a => a.filename === 'synthsr-v2.onnx');
  assert.equal(graph.sha256, asset.sha256);
  assert.equal(graph.bytes, asset.bytes);
});

test('a software or undersized WebGPU adapter sends SynthSR to WASM', () => {
  const shape = [160, 160, 224];
  const largest = Math.max(...planGpuGraph(shape).slots.map((slot) => slot.bytes));
  const roomy = { maxBufferSize: 4 * 2 ** 30, maxStorageBufferBindingSize: 4 * 2 ** 30 };
  const swiftshader = { info: { vendor: 'google', architecture: 'swiftshader', isFallbackAdapter: true }, limits: { maxBufferSize: 2 ** 30, maxStorageBufferBindingSize: 2 ** 30 } };
  assert.equal(chooseBrowserBackend(null, shape), 'wasm');
  assert.equal(chooseBrowserBackend(swiftshader, shape), 'wasm');
  assert.equal(chooseBrowserBackend(swiftshader), 'wasm');
  assert.equal(chooseBrowserBackend({ isFallbackAdapter: true, info: {}, limits: roomy }, shape), 'wasm');
  assert.equal(chooseBrowserBackend({ info: { isFallbackAdapter: false }, limits: { ...roomy, maxStorageBufferBindingSize: largest - 1 } }, shape), 'wasm');
  assert.equal(chooseBrowserBackend({ info: { isFallbackAdapter: false }, limits: { ...roomy, maxBufferSize: largest - 1 } }, shape), 'wasm');
  assert.equal(chooseBrowserBackend({ info: { isFallbackAdapter: false }, limits: { ...roomy, maxBufferSize: largest } }, shape), 'webgpu');
  assert.equal(chooseBrowserBackend({ info: { isFallbackAdapter: false }, limits: roomy }), 'webgpu');
});
