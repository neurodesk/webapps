#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readNifti } from '@neurodesk/webapp-components/file-io/nifti';
import { browserReference } from './browser-reference.mjs';
import { outputNames } from '../src/results.js';
import { MODEL_ASSETS, resolveModels } from '../src/assets.js';
import { compareDetections } from './detection-parity.mjs';
import { compareV2Outputs } from './v2-parity.mjs';
import { createProstateFixture, createProstateSeedMask, PROSTATE_FIXTURE_DIMS, PROSTATE_FIXTURE_SEEDS } from '../../../apps/seedseg/test/prostate-fixture.mjs';
import { markerComponents, matchComponentsToSeeds } from '../../../apps/seedseg/test/marker-components.mjs';
const { values } = parseArgs({ options: { executable: { type: 'string' }, composite: { type: 'boolean' }, case: { type: 'string' } } });
const command = values.executable ? [resolve(values.executable)] : [process.execPath, fileURLToPath(new URL('../bin/seedseg.js', import.meta.url))];
const modelsDirectory = values.executable ? join(dirname(await realpath(values.executable)), 'models') : process.env.NEURODESK_SEEDSEG_MODEL_DIR;
assert.ok(modelsDirectory, 'Source validation requires NEURODESK_SEEDSEG_MODEL_DIR');
const scratch = await mkdtemp(join(tmpdir(), 'seedseg-cli-check-'));
const started = performance.now();
const cases = [1, 2, 3, 4].map(ensemble => ({ id: `ensemble-${ensemble}`, pipeline: 'legacy-v1', ensemble, threshold: 0.1, topN: 3 }));
cases.push({ id: 'top-1', pipeline: 'legacy-v1', ensemble: 4, threshold: 0.1, topN: 1 }, { id: 'top-2', pipeline: 'legacy-v1', ensemble: 4, threshold: 0.1, topN: 2 }, { id: 'threshold', pipeline: 'legacy-v1', ensemble: 4, threshold: 0.5, topN: 3 });
cases.unshift(
  { id: 'default-v2', pipeline: 'nnunet-v2', folds: [0], threshold: 0.1, topN: 3 },
  { id: 'ensemble-v2', pipeline: 'nnunet-v2', folds: [0, 1, 2, 3, 4], threshold: 0.1, topN: 3 },
  { id: 'mirrored-v2', pipeline: 'nnunet-v2', folds: [0], mirror: true, threshold: 0.1, topN: 3 },
  { id: 'fp32-v2', pipeline: 'nnunet-v2', folds: [0], model: 'fp32', threshold: 0.1, topN: 3 },
  { id: 'top-1-v2', pipeline: 'nnunet-v2', folds: [0, 1, 2, 3, 4], threshold: 0.1, topN: 1 },
  { id: 'threshold-v2', pipeline: 'nnunet-v2', folds: [0, 1, 2, 3, 4], threshold: 0.5, topN: 3 },
);
if (values.executable) cases.splice(cases.findIndex(spec => spec.id === 'fp32-v2'), 1);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
try {
  const input = join(scratch, 'synthetic-prostate-t1.nii');
  await writeFile(input, createProstateFixture());
  const isolated = join(scratch, 'isolated-home');
  await mkdir(isolated);
  const env = { ...process.env, NEURODESK_OFFLINE: '1', NEURODESK_SEEDSEG_MODEL_DIR: modelsDirectory };
  delete env.CI;
  delete env.ORT_DISABLE_TELEMETRY;
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']) env[key] = isolated;
  const failed = (args, pattern) => {
    const run = spawnSync(command[0], [...command.slice(1), ...args], { encoding: 'utf8', env, timeout: 30_000 });
    assert.ifError(run.error);
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, pattern);
  };
  const guardedOutput = join(scratch, 'guard-output');
  const emptyModels = join(scratch, 'missing-models');
  await mkdir(emptyModels);
  failed([input, guardedOutput, '--ensemble', '5'], /positive integer.*4/);
  failed([input, guardedOutput, '--threshold', 'NaN'], /finite number/);
  failed([input, guardedOutput, '--top-n', '0'], /positive integer/);
  failed([input, guardedOutput, '--ensemble', '1', '--cache-dir', emptyModels, '--offline'], /missing.*offline model/);
  await writeFile(join(emptyModels, MODEL_ASSETS[0].filename), 'corrupt checkpoint');
  failed([input, guardedOutput, '--ensemble', '1', '--cache-dir', emptyModels, '--offline'], /checksum verification/);
  await assert.rejects(readFile(join(guardedOutput, 'consensus.nii')), { code: 'ENOENT' });
  await mkdir(guardedOutput);
  await writeFile(join(guardedOutput, 'keep.txt'), 'preserve');
  failed([input, guardedOutput, '--ensemble', '1'], /not empty/);
  assert.equal(await readFile(join(guardedOutput, 'keep.txt'), 'utf8'), 'preserve');
  assert.deepEqual(await readdir(isolated, { recursive: true }), []);
  console.log('PASS actual command: invalid ensemble/threshold/top-N, missing/corrupt offline models, nonempty output preservation, clean HOME with CI unset');
  const receipts = [];
  for (const spec of cases.filter(candidate => !values.case || candidate.id === values.case)) {
    console.log(`RUN ${spec.id}: actual CLI`);
    const output = join(scratch, spec.id);
    const selected = spec.pipeline === 'legacy-v1' ? resolveModels(undefined, spec).slice(0, spec.ensemble) : resolveModels(spec.folds, spec);
    const methodArgs = spec.pipeline === 'legacy-v1' ? ['--ensemble', String(spec.ensemble)] : ['--folds', spec.folds.join(','), '--model', spec.model ?? 'web', ...(spec.mirror ? ['--mirror'] : [])];
    const run = spawnSync(command[0], [...command.slice(1), input, output, ...methodArgs, '--threshold', String(spec.threshold), '--top-n', String(spec.topN), '--threads', '4', '--offline'],
      { encoding: 'utf8', env, maxBuffer: 16 * 1024 * 1024, timeout: 12 * 60 * 1000 });
    assert.ifError(run.error);
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(run.stdout);
    assert.deepEqual(report.models.map(model => model.sha256), selected.map(asset => asset.sha256));
    console.log(`RUN ${spec.id}: production browser worker`);
    const web = await browserReference({ modelsDirectory, ...spec, composite: values.composite });
    if (process.env.SEEDSEG_VALIDATION_ARTIFACTS) {
      const directory = join(process.env.SEEDSEG_VALIDATION_ARTIFACTS, spec.id);
      await mkdir(join(directory, 'browser'), { recursive: true });
      await cp(output, join(directory, 'native'), { recursive: true });
      const stageNames = { ...outputNames(spec.ensemble, spec.pipeline), detections: 'detections.json' };
      for (const [stage, bytes] of Object.entries(web.files)) await writeFile(join(directory, 'browser', stageNames[stage]), bytes);
    }
    const names = outputNames(spec.ensemble, spec.pipeline);
    assert.deepEqual((await readdir(output)).sort(), [...Object.values(names), ...(spec.pipeline === 'nnunet-v2' ? ['detections.json'] : [])].sort());
    let detectionParity;
    if (spec.pipeline === 'nnunet-v2') {
      const native = JSON.parse(await readFile(join(output, 'detections.json'), 'utf8'));
      const browser = JSON.parse(web.files.detections);
      detectionParity = compareDetections(native, browser);
      assert.ok(detectionParity.sameTopK && detectionParity.sameOrder && detectionParity.sameCandidateCount && detectionParity.sameCountFlag, `${spec.id}: upstream v2 detection parity ${JSON.stringify(detectionParity)}`);
    }
    let maximumProbabilityDifference = 0;
    let consensus;
    const v2 = { native: {}, browser: {} };
    for (const [stage, name] of Object.entries(names)) {
      const native = await readNifti(await readFile(join(output, name)));
      const browser = await readNifti(web.files[stage]);
      if (spec.pipeline === 'nnunet-v2') {
        v2.native[stage] = native.data;
        v2.browser[stage] = browser.data;
      }
      assert.deepEqual(native.dims, PROSTATE_FIXTURE_DIMS);
      assert.deepEqual(native.header.affine, browser.header.affine);
      assert.ok(native.data.every(value => Number.isFinite(value) && value >= 0 && value <= (stage === 'markers' ? spec.topN : 1)));
      assert.equal(native.data.length, browser.data.length);
      if (stage === 'consensus' || stage === 'markers') {
        if (stage === 'consensus') assert.deepEqual(native.data, browser.data, `${spec.id}: exact native/browser legacy marker mask`);
        else assert.ok(native.data.every(Number.isInteger) && browser.data.every(Number.isInteger), 'V2 marker maps contain integer ranks');
        consensus = native.data;
      } else {
        for (let index = 0; index < native.data.length; index++) maximumProbabilityDifference = Math.max(maximumProbabilityDifference, Math.abs(native.data[index] - browser.data[index]));
      }
    }
    const components = markerComponents(consensus, PROSTATE_FIXTURE_DIMS);
    assert.ok(components.length <= spec.topN);
    let markerAgreement;
    if (spec.pipeline === 'nnunet-v2') {
      markerAgreement = compareV2Outputs({ ...v2, dims: PROSTATE_FIXTURE_DIMS, mirror: Boolean(spec.mirror) });
      const detections = report.detections;
      assert.ok(detections.markers.length >= 1, `${spec.id}: at least one marker`);
      assert.equal(detections.countFlag, detections.nCandidates < spec.topN);
      assert.equal(components.length, detections.markers.length);
      const nearest = components.map(component => PROSTATE_FIXTURE_SEEDS.map((seed, index) => ({ index,
        distance: Math.hypot(...component.centroid.map((value, axis) => value - seed[axis])) })).sort((a, b) => a.distance - b.distance)[0]);
      assert.equal(new Set(nearest.map(match => match.index)).size, nearest.length, `${spec.id}: distinct planted seeds`);
      for (const match of nearest) assert.ok(match.distance <= 1, `${spec.id}: marker within one voxel of a planted seed`);
      for (const marker of detections.markers) assert.equal(consensus.filter(value => value === marker.rank).length, marker.nVoxels);
    }
    if (spec.id === 'ensemble-4') {
      assert.equal(components.length, 3);
      for (const match of matchComponentsToSeeds(components, PROSTATE_FIXTURE_SEEDS)) assert.ok(match.distance <= 1);
      const planted = createProstateSeedMask();
      const count = planted.reduce((sum, value) => sum + value, 0);
      const recall = planted.reduce((sum, value, index) => sum + (value && consensus[index] ? 1 : 0), 0) / count;
      assert.ok(recall >= 0.9);
      assert.ok(consensus.reduce((sum, value) => sum + value, 0) <= 10 * count);
      console.log(`PASS independent planted geometry: centroid <= 1 voxel, recall=${recall}, mask <= ${10 * count} voxels`);
    }
    const receipt = { ...spec, nativeSeconds: report.seconds, ortNode: report.onnxRuntime, ortWeb: web.ortWeb, chromium: web.chromium,
      components, detectionParity, markerAgreement, maximumProbabilityDifference, maskSha256: sha256(new Uint8Array(consensus.buffer)), composite: web.composite };
    receipts.push(receipt);
    console.log(`PASS ${JSON.stringify(receipt)}`);
    assert.deepEqual(await readdir(isolated, { recursive: true }), [], 'No runtime/cache/telemetry writes outside output');
  }
  assert.ok(receipts.length, 'Unknown validation case');
  if (!values.case) {
    const baseline = receipts.find(item => item.id === 'ensemble-4');
    for (const id of ['top-1', 'top-2', 'threshold']) assert.notEqual(receipts.find(item => item.id === id).maskSha256, baseline.maskSha256, `${id} must change the output`);
    for (const [base, ids] of [['ensemble-v2', ['top-1-v2', 'threshold-v2']], ['default-v2', ['ensemble-v2', 'mirrored-v2']]]) {
      for (const id of ids) assert.notEqual(receipts.find(item => item.id === id).maskSha256, receipts.find(item => item.id === base).maskSha256, `${id} must change the output`);
    }
  }
  console.log(`PASS SeedSeg offline software parity; elapsed ${(performance.now() - started) / 1000}s. Synthetic fixture, no clinical accuracy claim.`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
