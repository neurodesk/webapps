#!/usr/bin/env node
// Browser-runtime contract for the SynthMorph registration model.
//
// The original 160x160x192 export is valid ONNX, but it is not a browser
// model: its first 3D conv activation is 1*256*160*160*192 float32 values
// (about 4.7 GiB), which fails ORT WebGPU before registration can run.
// This test pins the manifest to a lower static graph that the worker can
// execute in a browser, while still upsampling the displacement field back
// to the canonical MNI160 grid for downstream stages.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const manifest = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'web/models/manifest.json'), 'utf8')
);

const synthmorph = manifest.modelAssets.find(a => a.id === 'lnm-synthmorph-mni');
assert.ok(synthmorph, "manifest must include modelAsset 'lnm-synthmorph-mni'");

const runtime = synthmorph.browserRuntime;
assert.ok(runtime && typeof runtime === 'object',
  'lnm-synthmorph-mni must declare browserRuntime metadata');

assert.deepEqual(runtime.sourceGrid, [160, 160, 192],
  'browser SynthMorph must still consume displacements on the canonical MNI160 grid');

assert.ok(Array.isArray(runtime.inputDims) && runtime.inputDims.length === 3,
  'browserRuntime.inputDims must be [X,Y,Z]');
assert.ok(Array.isArray(runtime.svfDims) && runtime.svfDims.length === 3,
  'browserRuntime.svfDims must be [X/2,Y/2,Z/2]');
assert.deepEqual(runtime.svfDims, runtime.inputDims.map(v => v / 2),
  'browserRuntime.svfDims must be exactly half of inputDims');
assert.deepEqual(runtime.executionProviders, ['wasm'],
  'current SynthMorph graph must be routed through WASM because WebGPU cannot run NHWC 3D MaxPool');
assert.ok(Array.isArray(runtime.webgpuUnsupportedOps) &&
    runtime.webgpuUnsupportedOps.includes('MaxPool3D'),
  'browserRuntime must document the WebGPU-blocking MaxPool3D operator');

assert.deepEqual(synthmorph.inputShape, [1, ...runtime.inputDims, 1],
  'manifest inputShape must match browserRuntime.inputDims');
assert.deepEqual(synthmorph.svfShape, [1, ...runtime.svfDims, 3],
  'manifest svfShape must match browserRuntime.svfDims');

for (const d of runtime.inputDims) {
  assert.equal(d % 16, 0,
    `SynthMorph browser input dimension ${d} must remain divisible by 16 for four pooling levels`);
}

assert.notDeepEqual(runtime.inputDims, runtime.sourceGrid,
  'browser SynthMorph must not use the full 160x160x192 graph');

const firstConvChannels = runtime.firstConvChannels;
assert.equal(firstConvChannels, 256,
  'browserRuntime.firstConvChannels must document the SynthMorph first conv width');

const computedPeak = runtime.inputDims.reduce((acc, v) => acc * v, 1) *
  firstConvChannels * Float32Array.BYTES_PER_ELEMENT;
assert.equal(runtime.maxActivationBytes, computedPeak,
  'browserRuntime.maxActivationBytes must match inputDims * firstConvChannels * sizeof(float32)');

const BROWSER_ACTIVATION_BUDGET = 256 * 1024 * 1024;
assert.ok(runtime.maxActivationBytes <= BROWSER_ACTIVATION_BUDGET,
  `SynthMorph browser peak activation ${(runtime.maxActivationBytes / 1048576).toFixed(1)} MiB ` +
  `exceeds ${(BROWSER_ACTIVATION_BUDGET / 1048576)} MiB budget`);

assert.match(synthmorph.filename, /lnm-synthmorph-mni-\d+x\d+x\d+\.onnx$/,
  'browser SynthMorph filename must include its static input grid');
assert.match(synthmorph.cacheKey, /browser-\d+x\d+x\d+/,
  'browser SynthMorph cacheKey must include its static input grid to avoid stale 160-grid cache hits');

console.log(
  `synthmorph browser model OK: ${runtime.inputDims.join('x')} input, ` +
  `${(runtime.maxActivationBytes / 1048576).toFixed(1)} MiB peak first activation.`
);
