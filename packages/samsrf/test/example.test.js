import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as samsrf from '../src/node.js';

// SamSrf's example subject X001 (Example_Dataset.zip): set SAMSRF_EXAMPLE_DIR to its folder.
const dir = process.env.SAMSRF_EXAMPLE_DIR;
const exampleTest = dir ? test : test.skip;
const VERTICES = 134260;

exampleTest('reads a functional run of the example', () => {
  const run = samsrf.readRunFile(join(dir, 'func', 'lh_uBars1.gii'));
  try {
    assert.equal(run.volumes, 250);
    assert.equal(run.vertices, VERTICES);
    assert.equal(run.course(82127)[172], 4114.8271484375);
    assert.equal(run.course(15115)[47], 4025.035400390625);
  } finally {
    run.free();
  }
});

exampleTest('reads the bar apertures and the old-school HRF fit', () => {
  const apertures = samsrf.readAperturesFile(join(dir, 'prf', 'aps_Bars.mat'));
  try {
    assert.deepEqual([apertures.width, apertures.height, apertures.volumes], [100, 100, 250]);
    const xy = apertures.scaledXy(9.5);
    assert.equal(Math.max(...xy.map(Math.abs)), 9.5);
    const copy = samsrf.Apertures.deserialize(apertures.serialize());
    assert.deepEqual(copy.toDense(), apertures.toDense());
    copy.free();
  } finally {
    apertures.free();
  }
  const hrfFit = join(dir, 'prf', 'hrf_fit.mat');
  assert.deepEqual(Array.from(samsrf.readOldSchoolHrf(readFileSync(hrfFit))), [8, 13, 2, 1]);
  assert.throws(() => samsrf.readAperturesFile(hrfFit), /hrf_fit\.mat: .*ApFrm/);
});

exampleTest('reads the V1 label and the surf folder', () => {
  const label = samsrf.readLabelFile(join(dir, 'label', 'lh.V1.label'));
  assert.equal(label.vertices.length, 6356);
  assert.ok(label.vertices.every((vertex) => vertex < VERTICES));
  const anatomy = samsrf.readAnatomyFolder(join(dir, 'surf'), 'lh');
  assert.equal(anatomy.white.vertices.length, 3 * VERTICES);
  assert.equal(anatomy.curvature.length, VERTICES);
  assert.equal(anatomy.normals.length, 3 * VERTICES);
});

exampleTest('preprocesses two runs on the V1 label', () => {
  const label = samsrf.readLabelFile(join(dir, 'label', 'lh.V1.label'));
  const runs = [1, 2].map((index) => join(dir, 'func', `lh_uBars${index}.gii`));
  const result = samsrf.preprocessRuns(runs, { keep: label.vertices });
  assert.deepEqual([result.runs, result.volumes, result.vertices], [2, 250, 6356]);
  assert.equal(result.noiseCeiling.length, 6356);
  assert.ok(result.data.every(Number.isFinite));
});
