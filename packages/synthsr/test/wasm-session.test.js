import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { WasmActivation } from '../src/wasm-activation.js';
import { createStreamedWasmSession } from '../src/wasm-session.js';
import { planGpuGraph } from '../src/gpu-session.js';

test('activation copies preserve values across pages and slot reuse', () => {
  const activation = new WasmActivation(29, 7);
  const values = Float32Array.from({ length: 29 }, (_, i) => i / 3);
  activation.set(values);
  activation.set(new Float32Array([91, 92, 93, 94]), 12);
  values.set([91, 92, 93, 94], 12);
  const copied = new Float32Array(21);
  activation.copyTo(copied, 2, 5, 24);
  assert.deepEqual(copied.subarray(2), values.subarray(5, 24));
  assert.deepEqual(activation.pages.map(page => page.length), [7, 7, 7, 7, 1]);
});

test('pinned SYNcro dimensions never require a multi-gigabyte activation buffer', () => {
  const plan = planGpuGraph([192, 288, 288]);
  assert.ok(Math.max(...plan.slots.map(slot => slot.bytes)) > 2 ** 31);
  for (const slot of plan.slots) {
    const activation = new WasmActivation(slot.bytes / 4);
    assert.equal(activation.pages.length, 0);
    activation.set(new Float32Array([17]), activation.length - 1);
    assert.ok(activation.pages.every(page => page.byteLength <= 32 * 1024 * 1024));
    const result = new Float32Array(1);
    activation.copyTo(result, 0, activation.length - 1, activation.length);
    assert.equal(result[0], 17);
  }
});

test('streamed operators match whole-network ORT inference', {
  skip: !process.env.SYNTHSR_MODEL_PATH,
  timeout: 120000,
}, async () => {
  const ort = await import('onnxruntime-node');
  const raw = await readFile(process.env.SYNTHSR_MODEL_PATH);
  const runtime = {
    Tensor: ort.Tensor,
    InferenceSession: {
      create: (bytes, options) => ort.InferenceSession.create(bytes, {
        ...options,
        executionProviders: ['cpu'],
        intraOpNumThreads: 2,
      }),
    },
  };
  const full = await runtime.InferenceSession.create(raw, {});
  const streamed = await createStreamedWasmSession(raw, [32, 32, 32], runtime, {
    maxElements: 128 * 1024,
  });
  const data = Float32Array.from({ length: 32 ** 3 }, (_, i) => (Math.sin(i * 0.173) + 1) / 2);
  const input = new ort.Tensor('float32', data, [1, 1, 32, 32, 32]);
  let expected;
  let actual;
  try {
    expected = await full.run({ [full.inputNames[0]]: input });
    actual = await streamed.run({ [streamed.inputNames[0]]: input });
    const a = await actual[streamed.outputNames[0]].getData();
    const b = await expected[full.outputNames[0]].getData();
    assert.equal(a.length, b.length);
    let maximumError = 0;
    for (let i = 0; i < a.length; i++) maximumError = Math.max(maximumError, Math.abs(a[i] - b[i]));
    assert.ok(maximumError < 1e-5, `maximum absolute error ${maximumError}`);
  } finally {
    input.dispose();
    for (const tensor of Object.values(expected ?? {})) tensor.dispose();
    for (const tensor of Object.values(actual ?? {})) tensor.dispose();
    await full.release();
    await streamed.release();
  }
});
