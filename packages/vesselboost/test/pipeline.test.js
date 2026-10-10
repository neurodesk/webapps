import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createNiftiFromVolume,
  parseNiftiVolume,
} from '@neurodesk/webapp-components/file-io/nifti';
import { createVesselBoostPipeline } from '../src/pipeline.js';

function fixture() {
  const calls = [];
  const stages = new Map();
  const affine = [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  ];
  const bytes = createNiftiFromVolume({
    img: Float32Array.from({ length: 512 }, (_, i) => i + 1),
    hdr: { dims: [8, 8, 8], pixDims: [1, 1, 1], affine },
  });
  const preprocessingWasm = {
    bilateral_denoise(data, ...args) {
      calls.push(['bilateral', args]);
      return Float32Array.from(data, (v) => v / 2);
    },
    nlm_denoise(data, ...args) {
      calls.push(['nlm', args]);
      return Float32Array.from(data, (v) => v / 3);
    },
    n4_bias_correct(data, ...args) {
      calls.push(['n4', args]);
      return Float32Array.from(data, (v) => v * 2);
    },
    bet_brain_extract(data, ...args) {
      calls.push(['bet', args.slice(0, 7)]);
      return new Uint8Array(data.length).fill(1);
    },
  };
  const events = {
    emit() {},
    complete() {},
    stepComplete() {},
    volumeInfo() {},
    log() {},
    progress() {},
    stageData(stage, bytes) {
      stages.set(stage, parseNiftiVolume(bytes));
    },
  };
  return {
    bytes,
    calls,
    stages,
    options: { ort: {}, preprocessingWasm, parseVolume: parseNiftiVolume, events },
  };
}
test('operation instances keep explicit independent state and optional steps support undo', async () => {
  const a = fixture();
  const b = fixture();
  const first = createVesselBoostPipeline(a.options);
  const second = createVesselBoostPipeline(b.options);
  await first.dispatch('load', { inputData: a.bytes });
  assert.equal(second.state.rasData, null);
  const original = [...first.state.rasData];
  await first.dispatch('run-n4');
  assert.equal(first.state.rasData[0], 2 * original[0]);
  await first.dispatch('run-denoise', { method: 'nlm-fast' });
  assert.deepEqual(a.calls[1][1].slice(-3), [3, 1, 0]);
  await first.dispatch('skip-denoise');
  assert.equal(first.state.denoisedData, null);
  await first.dispatch('skip-n4');
  assert.deepEqual([...first.state.rasData], original);
  await first.dispatch('downsample', { factor: 2 });
  assert.deepEqual(first.state.rasDims, [4, 4, 4]);
  assert.deepEqual(first.state.rasSpacing, [2, 2, 2]);
  await first.dispatch('skip-downsample');
  assert.deepEqual(first.state.rasDims, [8, 8, 8]);
  assert.deepEqual([...first.state.rasData], original);
});
test('optional BET receives fractional intensity and emits a brain mask without changing intensities', async () => {
  const f = fixture();
  const pipeline = createVesselBoostPipeline(f.options);
  await pipeline.dispatch('load', { inputData: f.bytes });
  const before = [...pipeline.state.rasData];
  await pipeline.dispatch('run-bet', { method: 'bet', fractionalIntensity: 0.7 });
  assert.equal(f.calls[0][1][6], 0.7);
  assert.deepEqual([...pipeline.state.rasData], before);
  assert.ok(pipeline.state.brainMask.every((v) => v === 1));
  await pipeline.dispatch('skip-bet');
  assert.equal(pipeline.state.brainMask, null);
});
test('failed model inference disposes input tensors and releases the owned session', async () => {
  const f = fixture();
  const events = [];
  class Tensor {
    dispose() {
      events.push('dispose-input');
    }
  }
  const ort = {
    Tensor,
    InferenceSession: {
      async create() {
        return {
          inputNames: ['x'],
          outputNames: ['y'],
          async run() {
            throw new Error('inference failed');
          },
          async release() {
            events.push('release');
          },
        };
      },
    },
  };
  const pipeline = createVesselBoostPipeline({
    ...f.options,
    ort,
    fetchModel: async () => new Uint8Array(),
  });
  await pipeline.dispatch('load', { inputData: f.bytes });
  await assert.rejects(pipeline.dispatch('run-inference'), /inference failed/);
  assert.deepEqual(events, ['dispose-input', 'release']);
  assert.equal(pipeline.state.segLabelsRAS, null);
});
test('missing preprocessing fails explicitly even when inference alone is requested', () => {
  assert.throws(() => createVesselBoostPipeline({}), /Required VesselBoost preprocessing/);
});

test('vessel inference forwards the caller requested CPU thread settings to ONNX Runtime', async () => {
  for (const threads of [1, 4]) {
    const f = fixture();
    let received;
    const sessionOptions = {
      executionProviders: ['cpu'],
      intraOpNumThreads: threads,
      interOpNumThreads: 1,
    };
    const pipeline = createVesselBoostPipeline({
      ...f.options,
      sessionOptions,
      fetchModel: async () => new Uint8Array(),
      ort: {
        InferenceSession: {
          async create(_bytes, options) {
            received = options;
            throw new Error('stop after capturing runtime options');
          },
        },
      },
    });
    await pipeline.dispatch('load', { inputData: f.bytes });
    await assert.rejects(pipeline.dispatch('run-inference'), /stop after capturing/);
    assert.deepEqual(received, { ...sessionOptions, graphOptimizationLevel: 'all' });
  }
});

test('cancellation during an inference patch releases every tensor and the session', async () => {
  const f = fixture();
  const events = [];
  const controller = new AbortController();
  class Tensor {
    dispose() {
      events.push('dispose-input');
    }
  }
  const ort = {
    Tensor,
    InferenceSession: {
      async create() {
        return {
          inputNames: ['x'],
          outputNames: ['y'],
          async run() {
            controller.abort();
            return {
              y: {
                async getData() {
                  return new Float32Array(64 ** 3);
                },
                dispose() {
                  events.push('dispose-output');
                },
              },
            };
          },
          async release() {
            events.push('release');
          },
        };
      },
    },
  };
  const pipeline = createVesselBoostPipeline({
    ...f.options,
    ort,
    signal: controller.signal,
    fetchModel: async () => new Uint8Array(),
  });
  await pipeline.dispatch('load', { inputData: f.bytes });
  await assert.rejects(pipeline.dispatch('run-inference'), { name: 'AbortError' });
  assert.deepEqual(events, ['dispose-input', 'dispose-output', 'release']);
  assert.equal(pipeline.state.segLabelsRAS, null);
});
