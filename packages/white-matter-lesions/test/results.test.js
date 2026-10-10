import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readVolume } from '@neurodesk/synthsr';
import { PLAN, runFolds } from '../src/pipeline.js';
import { lesionResults, outputNames } from '../src/results.js';

const affine = [[2, 0, 0, -4], [0, 2, 0, -4], [0, 0, 2, -4], [0, 0, 0, 1]];

test('output names follow the input file name', () => {
  const expected = { mask: 'P57_FLAIR_lesions.nii', probability: 'P57_FLAIR_lesion_probability.nii', table: 'P57_FLAIR_lesions.tsv' };
  assert.deepEqual(outputNames('P57_FLAIR.nii.gz'), expected);
  assert.deepEqual(outputNames('P57_FLAIR.NII'), expected);
  assert.equal(outputNames('scan.nii.gz.nii').mask, 'scan.nii.gz_lesions.nii');
});

test('results threshold the probability, keep the grid and tabulate each lesion', () => {
  const probability = new Float32Array(64);
  probability[0] = 0.9;
  probability[1] = 0.5;
  probability[63] = 0.51;
  const results = lesionResults({ dims: [4, 4, 4], affine }, probability);
  const mask = readVolume(results.mask);
  assert.deepEqual(mask.dims, [4, 4, 4]);
  assert.deepEqual(mask.affine, affine);
  assert.deepEqual([...mask.data].flatMap((v, i) => (v ? [i] : [])), [0, 63]);
  assert.deepEqual(readVolume(results.probability).data, probability);
  assert.equal(new TextDecoder().decode(new Uint8Array(results.mask, 148, 18)), 'FLAMeS lesion mask');
  assert.deepEqual(results.summary, { count: 2, totalMl: 0.016 });
  assert.equal(results.tsv, 'lesion\tvoxels\tvolume_ml\tx_mm\ty_mm\tz_mm\n1\t1\t0.0080\t-4.0\t-4.0\t-4.0\n2\t1\t0.0080\t2.0\t2.0\t2.0\n');
});

test('folds run one session at a time and release every session', async () => {
  const events = [];
  class Tensor {
    constructor(type, data, dims) {
      Object.assign(this, { type, data, dims });
    }

    dispose() {}
  }
  const voxels = PLAN.patch.reduce((a, b) => a * b, 1);
  const createSession = async (bytes) => {
    events.push(`open ${bytes}`);
    return {
      inputNames: ['input'],
      outputNames: ['logits'],
      async run({ input }) {
        assert.deepEqual(input.dims, [1, 1, ...PLAN.patch]);
        const logits = new Float32Array(2 * voxels);
        for (let i = 0; i < voxels; i++) logits[voxels + i] = (i % 7) - 3;
        return { logits: { getData: async () => logits, dispose() {} } };
      },
      async release() {
        events.push(`release ${bytes}`);
        await new Promise((done) => setTimeout(done, 5));
        events.push(`released ${bytes}`);
      },
    };
  };
  const dims = [20, 20, 20];
  const volume = { dims, affine: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]], data: Float32Array.from({ length: 8000 }, (_, i) => i % 13) };
  const result = await runFolds({ volume, brainMask: new Uint8Array(8000).fill(1), folds: 2, loadModel: async (n) => { events.push(`load fold${n}`); return `fold${n}`; }, createSession, Tensor });
  assert.deepEqual(events, ['load fold0', 'open fold0', 'release fold0', 'released fold0', 'load fold1', 'open fold1', 'release fold1', 'released fold1']);
  assert.equal(result.probability.length, 8000);
});

const testVolume = {
  dims: [2, 2, 2],
  affine: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]],
  data: Float32Array.from({ length: 8 }, (_, i) => i + 1),
};

for (const failure of ['load', 'create', 'run', 'getData', 'cancel loading', 'cancel creating', 'cancel patch']) {
  test(`fold cleanup on ${failure} failure`, async () => {
    const events = [];
    const controller = new AbortController();
    const error = new Error(failure);
    const voxels = PLAN.patch.reduce((a, b) => a * b, 1);
    class Tensor {
      dispose() { events.push('input disposed'); }
    }
    const run = runFolds({
      volume: testVolume,
      brainMask: new Uint8Array(8).fill(1),
      folds: 2,
      signal: controller.signal,
      Tensor,
      loadModel: async (fold) => {
        events.push(`load ${fold}`);
        if (fold === 1 && failure === 'load') throw error;
        if (failure === 'cancel loading') controller.abort(error);
        return fold;
      },
      createSession: async (fold) => {
        if (failure === 'create') throw error;
        if (failure === 'cancel creating') controller.abort(error);
        return {
          inputNames: ['input'], outputNames: ['logits'],
          run: async () => {
            if (failure === 'run') throw error;
            if (failure === 'cancel patch') controller.abort(error);
            return { logits: {
              getData: async () => {
                if (failure === 'getData') throw error;
                const logits = new Float32Array(2 * voxels);
                logits[voxels] = 1;
                return logits;
              },
              dispose() { events.push('output disposed'); },
            } };
          },
          release: async () => { events.push(`release ${fold}`); },
        };
      },
    });
    await assert.rejects(run, (caught) => caught === error);
    if (['run', 'getData', 'cancel patch'].includes(failure)) {
      assert.equal(events.filter((event) => event === 'input disposed').length, 1);
    }
    if (['getData', 'cancel patch'].includes(failure)) assert.ok(events.includes('output disposed'));
    if (!['create', 'cancel loading'].includes(failure)) {
      assert.equal(events.filter((event) => event === 'release 0').length, 1);
    }
    if (failure === 'load') assert.ok(events.indexOf('release 0') < events.indexOf('load 1'));
  });
}

test('invalid or already cancelled runs load no graphs', async () => {
  const loadModel = () => assert.fail('must not load');
  for (const folds of [undefined, 0, -1, 1.5]) {
    await assert.rejects(runFolds({ folds, loadModel }), /positive fold count/);
  }
  await assert.rejects(runFolds({ folds: 1, models: ['eager'] }), /lazy model loader/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runFolds({ folds: 1, loadModel, signal: controller.signal }), { name: 'AbortError' });
});

test('a failed session release prevents the next graph load without releasing twice', async () => {
  const events = [];
  const error = new Error('release failed');
  const voxels = PLAN.patch.reduce((a, b) => a * b, 1);
  class Tensor { dispose() {} }
  await assert.rejects(runFolds({
    volume: testVolume, brainMask: new Uint8Array(8).fill(1), folds: 2, Tensor,
    loadModel: async (fold) => { events.push(`load ${fold}`); return fold; },
    createSession: async () => ({
      inputNames: ['input'], outputNames: ['logits'],
      run: async () => ({ logits: {
        getData: async () => { const data = new Float32Array(2 * voxels); data[voxels] = 1; return data; },
        dispose() {},
      } }),
      release: async () => { events.push('release'); throw error; },
    }),
  }), (caught) => caught === error);
  assert.deepEqual(events, ['load 0', 'release']);
});
