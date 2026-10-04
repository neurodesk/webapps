import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import model from '../src/browser-model.json' with { type: 'json' };
import { createBrowserSession, planStripGraph } from '../src/browser.js';
import { finishStrip } from '../src/index.js';
import { layerModel, slabPlan } from '../../runtime-support/src/streamed-onnx/session.js';

const modelPath = process.env.SYNTHSTRIP_MODEL_PATH;
const native = () => createRequire(new URL('../../synthsr/package.json', import.meta.url))('onnxruntime-node');
const nativeOptions = options => ({ ...options, executionProviders: ['cpu'], intraOpNumThreads: 2 });

function preparedFixture(dims, input) {
  const affine = [[-1, 0, 0, 0], [0, 0, 1, 0], [0, -1, 0, 0], [0, 0, 0, 1]];
  return {
    modelDims: dims,
    perm: [0, 1, 2],
    flip: [false, false, false],
    orientedDims: dims,
    resampledDims: dims,
    sp: [1, 1, 1],
    resize: false,
    lo: [0, 0, 0],
    shift: [0, 0, 0],
    volume: { dims, affine, data: input },
  };
}

test('pinned SynthStrip planner preserves split sums, final scalar convolution and resize geometry', () => {
  const nodes = planStripGraph([192, 320, 320]);
  assert.deepEqual(nodes.map(node => node.name), model.nodes.map(node => node.name));
  assert.deepEqual(Object.fromEntries(['Conv', 'LeakyRelu', 'MaxPool', 'Resize', 'Add'].map(op => [op, nodes.filter(node => node.op === op).length])), {
    Conv: 33, LeakyRelu: 26, MaxPool: 6, Resize: 6, Add: 6,
  });
  const final = nodes.at(-1);
  assert.equal(final.kernel, 3);
  assert.deepEqual(final.shape, { channels: 1, dims: [192, 320, 320] });
  assert.ok(slabPlan(final).some(slab => slab.inputStart < slab.start));
  for (const node of nodes.filter(node => node.op === 'Resize')) {
    assert.deepEqual(node.shape.dims, node.inputShape.dims.map(value => value * 2));
    assert.equal(node.inputs.length, 1);
    assert.ok(node.sizesInput);
    assert.equal(node.attrs.cubic_coeff_a, -0.75);
    for (const slab of slabPlan(node)) {
      assert.equal(slab.start % 2, 0);
      assert.equal(slab.end % 2, 0);
      assert.equal(slab.inputStart, slab.start / 2);
      assert.equal(slab.inputEnd, slab.end / 2);
    }
  }
  assert.throws(() => planStripGraph([192, 288, 288]), /multiples of 64/);
});

test('browser graph export reproduces exact initializer spans and size expressions', {
  skip: !modelPath && 'Set SYNTHSTRIP_MODEL_PATH for graph export validation',
}, async () => {
  const script = new URL('../scripts/export-browser-graph.py', import.meta.url).pathname;
  const code = 'import importlib.util,json,pathlib,sys; s=importlib.util.spec_from_file_location("exporter",sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(json.dumps(m.export(pathlib.Path(sys.argv[2]))))';
  const { stdout } = await promisify(execFile)('python3', ['-c', code, script, modelPath], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(stdout), model);
});

test('streamed SynthStrip matches the untouched browser graph across forced slabs and reruns after failure', {
  skip: !modelPath && 'Set SYNTHSTRIP_MODEL_PATH for numerical validation',
}, async t => {
  const ort = native();
  const raw = await readFile(modelPath);
  const dims = [64, 64, 64];
  const length = dims.reduce((a, b) => a * b);
  const input = Float32Array.from({ length }, (_, index) => {
    const x = Math.floor(index / 4096) - 31.5;
    const y = Math.floor(index / 64) % 64 - 31.5;
    const z = index % 64 - 31.5;
    return Math.exp(-(x * x + y * y + z * z) / 500) + (index % 7) / 100;
  });
  const tensor = new ort.Tensor('float32', input, [1, 1, ...dims]);
  const cap = 512 * 1024;
  let failNextRun = false;
  let feedPeak = 0;
  let outputPeak = 0;
  let negativeValues = 0;
  const adapter = { ...ort, InferenceSession: { create: async (bytes, options) => {
    const session = await ort.InferenceSession.create(bytes, nativeOptions(options));
    return {
      async run(feeds) {
        if (failNextRun) {
          failNextRun = false;
          throw new Error('Injected ORT run failure');
        }
        for (const feed of Object.values(feeds)) {
          if (feed.type !== 'float32') continue;
          feedPeak = Math.max(feedPeak, feed.data.length);
          for (const value of feed.data) if (value < 0) negativeValues++;
        }
        const outputs = await session.run(feeds);
        for (const output of Object.values(outputs)) outputPeak = Math.max(outputPeak, output.data.length);
        return outputs;
      },
      release: () => session.release(),
    };
  } } };
  const streamed = await createBrowserSession(raw, dims, adapter, { maxElements: cap });
  const reference = await ort.InferenceSession.create(raw, nativeOptions({ graphOptimizationLevel: 'all' }));
  let actual;
  let expected;
  try {
    actual = await streamed.run({ input: tensor });
    expected = await reference.run({ input: tensor });
    const x = await actual.output.getData();
    const y = await expected.output.getData();
    let maximum = 0;
    for (let index = 0; index < x.length; index++) {
      assert.ok(Number.isFinite(x[index]));
      maximum = Math.max(maximum, Math.abs(x[index] - y[index]));
    }
    t.diagnostic(`maximum distance difference ${maximum}; feed peak ${feedPeak}; output peak ${outputPeak}`);
    assert.ok(maximum < 1e-4, `maximum float32 distance difference ${maximum}`);
    assert.ok(feedPeak <= cap);
    assert.ok(outputPeak <= cap);
    assert.ok(negativeValues > 0, 'negative intermediate values exercise LeakyRelu');
    const prep = preparedFixture(dims, input);
    const actualMask = Uint8Array.from(x, value => value < 1 ? 1 : 0);
    const expectedMask = Uint8Array.from(y, value => value < 1 ? 1 : 0);
    assert.deepEqual(actualMask, expectedMask);
    assert.throws(() => finishStrip(x, prep), /empty brain mask/);
    assert.throws(() => finishStrip(y, prep), /empty brain mask/);
    failNextRun = true;
    await assert.rejects(streamed.run({ input: tensor }), /Injected ORT run failure/);
    const rerun = await streamed.run({ input: tensor });
    try {
      assert.deepEqual(await rerun.output.getData(), x);
    } finally {
      rerun.output.dispose();
    }
  } finally {
    actual?.output.dispose();
    expected?.output.dispose();
    tensor.dispose();
    await streamed.release();
    await reference.release();
  }
});

test('local int64 Resize sizes preserve coordinate ramps at every slab boundary', {
  skip: !modelPath && 'Set SYNTHSTRIP_MODEL_PATH for Resize validation',
}, async () => {
  const ort = native();
  const raw = await readFile(modelPath);
  const node = planStripGraph([64, 64, 64]).find(node => node.op === 'Resize');
  const inputShape = { channels: 1, dims: [7, 3, 5] };
  const shape = { channels: 1, dims: [14, 6, 10] };
  const resize = { ...node, inputShape, shape };
  const session = await ort.InferenceSession.create(layerModel(resize, raw, model), nativeOptions({}));
  const values = Float32Array.from({ length: 105 }, (_, index) => index - 50);
  const result = new Float32Array(840);
  try {
    for (const slab of slabPlan(resize, 120)) {
      const input = new ort.Tensor('float32', values.slice(slab.inputStart * 15, slab.inputEnd * 15), [1, 1, slab.inputEnd - slab.inputStart, 3, 5]);
      const sizes = new ort.Tensor('int64', BigInt64Array.from([1, 1, slab.end - slab.start, 6, 10], BigInt), [5]);
      let output;
      try {
        output = await session.run({ [node.inputs[0]]: input, [node.sizesInput]: sizes });
        result.set(await output[node.output].getData(), slab.start * 60);
      } finally {
        input.dispose();
        sizes.dispose();
        output?.[node.output].dispose();
      }
    }
    for (let x = 0; x < 14; x++) {
      for (let y = 0; y < 6; y++) {
        for (let z = 0; z < 10; z++) {
          assert.equal(result[(x * 6 + y) * 10 + z], values[(Math.floor(x / 2) * 3 + Math.floor(y / 2)) * 5 + Math.floor(z / 2)]);
        }
      }
    }
  } finally {
    await session.release();
  }
});

test('streamed real-volume distances and finished masks match the untouched pinned browser model', {
  skip: (!modelPath || !process.env.SYNTHSTRIP_INPUT_PATH) && 'Set SYNTHSTRIP_MODEL_PATH and SYNTHSTRIP_INPUT_PATH for full-volume validation',
}, async t => {
  const { readVolume } = await import('../../synthsr/src/index.js');
  const { prepareStrip } = await import('../src/index.js');
  const ort = native();
  const raw = await readFile(modelPath);
  const source = await readFile(process.env.SYNTHSTRIP_INPUT_PATH);
  const volume = readVolume(source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength));
  const prep = prepareStrip(volume);
  t.diagnostic(`prepared dimensions ${prep.modelDims.join('x')}`);
  const input = new ort.Tensor('float32', prep.input, [1, 1, ...prep.modelDims]);
  const reference = await ort.InferenceSession.create(raw, nativeOptions({
    graphOptimizationLevel: 'all', enableCpuMemArena: false, enableMemPattern: false,
  }));
  let expected;
  try {
    const output = await reference.run({ input });
    try {
      expected = (await output.output.getData()).slice();
    } finally {
      output.output.dispose();
    }
  } catch (error) {
    input.dispose();
    throw error;
  } finally {
    await reference.release();
  }
  const adapter = { ...ort, InferenceSession: {
    create: (bytes, options) => ort.InferenceSession.create(bytes, nativeOptions(options)),
  } };
  const streamed = await createBrowserSession(raw, prep.modelDims, adapter);
  let actual;
  try {
    const output = await streamed.run({ input });
    actual = await output.output.getData();
    output.output.dispose();
  } finally {
    input.dispose();
    await streamed.release();
  }
  let maximum = 0;
  for (let index = 0; index < actual.length; index++) {
    assert.ok(Number.isFinite(actual[index]));
    maximum = Math.max(maximum, Math.abs(actual[index] - expected[index]));
  }
  assert.ok(maximum < 1e-4, `maximum real-volume distance difference ${maximum}`);
  const actualMask = finishStrip(actual, prep).mask.data;
  const expectedMask = finishStrip(expected, prep).mask.data;
  assert.deepEqual(actualMask, expectedMask);
  t.diagnostic(`maximum distance difference ${maximum}; identical mask brain voxels ${actualMask.reduce((sum, value) => sum + value, 0)}`);
});
