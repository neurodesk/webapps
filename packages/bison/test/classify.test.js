import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyVoxels } from '../src/classify.js';
import { IMAGE_RANGE } from '../src/features.js';

class Tensor {
  constructor(type, data, dims) {
    this.type = type;
    this.data = data;
    this.dims = dims;
  }
}

// A stand-in forest: label = round(T1) % 9, probability 1 on that class.
function fakeClassifier(calls) {
  const session = {
    async run({ X }) {
      const [rows, features] = X.dims;
      calls.push(rows);
      const label = new BigInt64Array(rows);
      const probabilities = new Float32Array(rows * 9);
      for (let r = 0; r < rows; r++) {
        const value = Math.round(X.data[r * features + 8]) % 9;
        label[r] = BigInt(value);
        probabilities[r * 9 + value] = 1;
      }
      return { label: new Tensor('int64', label, [rows]), probabilities: new Tensor('float32', probabilities, [rows, 9]) };
    },
  };
  return { Tensor, session };
}

function images(length) {
  const zero = new Float32Array(length);
  return {
    mode: 't1',
    priors: Array.from({ length: 8 }, () => zero),
    t1: Float32Array.from({ length }, (_, i) => i + 1),
    avT1: zero,
    t1Histogram: new Float64Array(IMAGE_RANGE * 8),
  };
}

test('classifies in batches and keeps row order', async () => {
  const calls = [];
  const voxels = Uint32Array.from([0, 2, 3, 5, 6, 9, 10]);
  const progress = [];
  const result = await classifyVoxels(fakeClassifier(calls), images(12), voxels, { batchSize: 3, onProgress: (f) => progress.push(f) });
  assert.deepEqual(calls, [3, 3, 1]);
  assert.deepEqual([...result.labels], [...voxels].map((v) => (v + 1) % 9));
  assert.equal(result.classCount, 9);
  for (let r = 0; r < voxels.length; r++) assert.equal(result.probabilities[r * 9 + result.labels[r]], 1);
  assert.equal(progress.at(-1), 1);
});

test('refuses a model with the wrong class count', async () => {
  const classifier = fakeClassifier([]);
  const flair = { ...images(4), mode: 't1-flair', priors: Array.from({ length: 9 }, () => new Float32Array(4)) };
  flair.flair = new Float32Array(4).fill(1);
  flair.avFlair = new Float32Array(4);
  flair.t1Histogram = new Float64Array(IMAGE_RANGE * 9);
  flair.flairHistogram = new Float64Array(IMAGE_RANGE * 9);
  const original = classifier.session.run;
  classifier.session.run = async ({ X }) => original({ X: new Tensor('float32', X.data, [X.dims[0], 18]) });
  await assert.rejects(classifyVoxels(classifier, flair, Uint32Array.from([0, 1])), /9 classes, not 10/);
});

test('stops when aborted', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(classifyVoxels(fakeClassifier([]), images(4), Uint32Array.from([0]), { signal: controller.signal }));
});
