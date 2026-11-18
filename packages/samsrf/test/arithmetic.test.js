import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as samsrf from '../src/node.js';
import { giftiRun, matFile } from './fixtures.js';

const references = ['current', 'matlab-amd', 'matlab-intel'];
const bytes = giftiRun(Array.from({ length: 3 }, (_, v) => Array.from({ length: 16 }, (_, t) => Math.sin(t + v) + t / 13)));
function spec(reference) {
  const run = samsrf.readGiftiRun(bytes);
  const accumulator = new samsrf.RunAccumulator(run.vertices, null, { arithmeticReference: reference });
  let data;
  try {
    accumulator.pushRun(run);
    data = accumulator.finish();
  } finally {
    accumulator.free();
    run.free();
  }
  assert.equal(data.arithmeticReference, reference ?? 'current');
  const apertures = samsrf.readApertures(matFile({ ApFrm: { dims: [2, 2, 16], data: Array.from({ length: 64 }, (_, i) => Number(i % 5 === 0)) } }), 'mat');
  try {
    return {
      kind: 'rc',
      model: JSON.stringify({ Name: 'test', TR: 1, Scaling_Factor: 1, Hrf: 1, Aperture_File: 'ap', ...(reference === undefined ? {} : { Arithmetic_Reference: reference }) }),
      totalVertices: 3,
      apertures: apertures.serialize(),
      data: { volumes: data.volumes, vertices: Uint32Array.of(0, 1, 2), courses: data.data, arithmeticReference: data.arithmeticReference },
    };
  } finally { apertures.free(); }
}
const bits = (data) => new BigUint64Array(data.buffer, data.byteOffset, data.length);

test('references belong to each job, survive shards, and never leak into another job', () => {
  const jobs = [...references, undefined].map((reference) => samsrf.createJob(spec(reference)));
  try {
    const before = jobs.map((job) => job.run(0, job.vertexCount));
    for (let i = jobs.length - 1; i >= 0; i--) {
      const job = jobs[i];
      assert.deepEqual(job.run(0, job.vertexCount), before[i]);
      const result = job.merge([job.run(1, 3), job.run(0, 1)]);
      assert.equal(result.arithmeticReference, references[i] ?? 'current');
      assert.equal(job.arithmeticReference, result.arithmeticReference);
      assert.deepEqual(bits(result.maps.data), bits(job.merge([before[i]]).maps.data));
      for (let j = 0; j < 3; j++) {
        if (i % 3 !== j) assert.throws(() => job.merge([before[j]]), /arithmetic reference/);
      }
    }
    assert.deepEqual(before[0], before[3], 'omitted reference means current');
    const damaged = before[0].slice();
    new DataView(damaged.buffer).setUint32(36, 99, true);
    assert.throws(() => jobs[0].merge([damaged]), /unknown arithmetic reference/);
  } finally { jobs.forEach((job) => job.free()); }
});

test('preprocessing must declare the same reference as the fit; Intel never falls back to single', () => {
  const input = spec('matlab-intel');
  for (const reference of ['current', 'matlab-amd', undefined]) {
    assert.throws(() => samsrf.createJob({ ...input, data: { ...input.data, arithmeticReference: reference } }), /preprocessing and model/);
  }
  for (const value of ['auto', 'intel', null, true, 1, ['current']]) {
    assert.throws(() => new samsrf.RunAccumulator(3, null, { arithmeticReference: value }), /arithmetic reference/);
    assert.throws(() => samsrf.parseModel('rc', JSON.stringify({ ...JSON.parse(input.model), Arithmetic_Reference: value })), /Arithmetic_Reference/);
  }
  assert.throws(() => new samsrf.RunAccumulator(3, null, { precision: 'single', arithmeticReference: 'matlab-intel' }), /Intel single-precision kernels are not implemented/);
  assert.throws(() => samsrf.parseModel('rc', JSON.stringify({ ...JSON.parse(input.model), Data_Precision: 'single' })), /Intel single-precision kernels are not implemented/);
});
