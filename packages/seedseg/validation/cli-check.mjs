#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readNifti } from '@neurodesk/webapp-components/file-io/nifti';
import { browserReference } from './browser-reference.mjs';
import { outputNames } from '../src/results.js';
import { MODEL_ASSETS } from '../src/assets.js';
import { createProstateFixture, createProstateSeedMask, PROSTATE_FIXTURE_DIMS, PROSTATE_FIXTURE_SEEDS } from '../../../apps/seedseg/test/prostate-fixture.mjs';
import { markerComponents, matchComponentsToSeeds } from '../../../apps/seedseg/test/marker-components.mjs';
const { values } = parseArgs({ options: { executable: { type: 'string' }, composite: { type: 'boolean' }, case: { type: 'string' } } });
const command = values.executable ? [resolve(values.executable)] : [process.execPath, fileURLToPath(new URL('../bin/seedseg.js', import.meta.url))];
const modelsDirectory = values.executable ? join(dirname(await realpath(values.executable)), 'models') : process.env.NEURODESK_SEEDSEG_MODEL_DIR;
assert.ok(modelsDirectory, 'Source validation requires NEURODESK_SEEDSEG_MODEL_DIR');
const scratch = await mkdtemp(join(tmpdir(), 'seedseg-cli-check-'));
const started = performance.now();
const cases = [1, 2, 3, 4].map(ensemble => ({ id: `ensemble-${ensemble}`, ensemble, threshold: 0.1, topN: 3 }));
cases.push({ id: 'top-1', ensemble: 4, threshold: 0.1, topN: 1 }, { id: 'top-2', ensemble: 4, threshold: 0.1, topN: 2 }, { id: 'threshold', ensemble: 4, threshold: 0.5, topN: 3 });
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
    const output = join(scratch, spec.id);
    const run = spawnSync(command[0], [...command.slice(1), input, output, '--ensemble', String(spec.ensemble), '--threshold', String(spec.threshold), '--top-n', String(spec.topN), '--threads', '4', '--offline'],
      { encoding: 'utf8', env, maxBuffer: 16 * 1024 * 1024, timeout: 12 * 60 * 1000 });
    assert.ifError(run.error);
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(run.stdout);
    assert.deepEqual(report.models.map(model => model.sha256), MODEL_ASSETS.slice(0, spec.ensemble).map(asset => asset.sha256));
    const web = await browserReference({ modelsDirectory, ...spec, composite: values.composite });
    const names = outputNames(spec.ensemble);
    assert.deepEqual((await readdir(output)).sort(), Object.values(names).sort());
    let maximumProbabilityDifference = 0;
    let consensus;
    for (const [stage, name] of Object.entries(names)) {
      const native = await readNifti(await readFile(join(output, name)));
      const browser = await readNifti(web.files[stage]);
      assert.deepEqual(native.dims, PROSTATE_FIXTURE_DIMS);
      assert.deepEqual(native.header.affine, browser.header.affine);
      assert.ok(native.data.every(value => Number.isFinite(value) && value >= 0 && value <= 1));
      assert.equal(native.data.length, browser.data.length);
      if (stage === 'consensus') {
        assert.deepEqual(native.data, browser.data, `${spec.id}: exact native/browser marker mask`);
        consensus = native.data;
      } else {
        for (let index = 0; index < native.data.length; index++) maximumProbabilityDifference = Math.max(maximumProbabilityDifference, Math.abs(native.data[index] - browser.data[index]));
      }
    }
    const components = markerComponents(consensus, PROSTATE_FIXTURE_DIMS);
    assert.ok(components.length <= spec.topN);
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
      components, maximumProbabilityDifference, maskSha256: sha256(new Uint8Array(consensus.buffer)), composite: web.composite };
    receipts.push(receipt);
    console.log(`PASS ${JSON.stringify(receipt)}`);
    assert.deepEqual(await readdir(isolated, { recursive: true }), [], 'No runtime/cache/telemetry writes outside output');
  }
  assert.ok(receipts.length, 'Unknown validation case');
  if (!values.case) {
    const baseline = receipts.find(item => item.id === 'ensemble-4');
    for (const id of ['top-1', 'top-2', 'threshold']) assert.notEqual(receipts.find(item => item.id === id).maskSha256, baseline.maskSha256, `${id} must change the output`);
  }
  console.log(`PASS SeedSeg offline software parity; elapsed ${(performance.now() - started) / 1000}s. Synthetic fixture, no clinical accuracy claim.`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
