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
      },
    };
  };
  const dims = [20, 20, 20];
  const volume = { dims, affine: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]], data: Float32Array.from({ length: 8000 }, (_, i) => i % 13) };
  const result = await runFolds({ volume, brainMask: new Uint8Array(8000).fill(1), models: ['fold0', 'fold1'], createSession, Tensor });
  assert.deepEqual(events, ['open fold0', 'release fold0', 'open fold1', 'release fold1']);
  assert.equal(result.probability.length, 8000);
});
