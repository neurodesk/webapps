#!/usr/bin/env node
// Portable release validation for @neurodesk/tumour-report.
// Exercises the packaged executable (or bin/tumour-report.js) on the pinned
// BEAMSTER_A_038 native T1c example, caching the downloaded example under
// tmpdir() so isolated $HOME stays completely untouched.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readVolume } from '@neurodesk/synthsr';

const { values } = parseArgs({ options: { executable: { type: 'string' } } });
const command = values.executable
  ? [resolve(values.executable)]
  : [process.execPath, fileURLToPath(new URL('../bin/tumour-report.js', import.meta.url))];

const examples = JSON.parse(
  await readFile(new URL('../../../apps/tumour-report/examples.json', import.meta.url), 'utf8'),
);
const reference = JSON.parse(
  await readFile(new URL('./container-reference.json', import.meta.url), 'utf8'),
);

const exampleSpec = examples.find((item) => item.id === 'beamster-a-038')?.files?.[0];
assert.ok(exampleSpec, 'Pinned beamster-a-038 example must exist in apps/tumour-report/examples.json');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function ensureExample(spec) {
  const cacheDir = join(tmpdir(), 'neurodesk-tumour-report-validation-cache');
  const targetPath = join(cacheDir, spec.name);
  try {
    const existing = await readFile(targetPath);
    if (existing.length === spec.bytes && sha256(existing) === spec.sha256) {
      return targetPath;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const response = await fetch(spec.url);
  assert.ok(response.ok, `Download ${spec.name}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.length, spec.bytes, `${spec.name} byte length mismatch`);
  assert.equal(sha256(bytes), spec.sha256, `${spec.name} SHA-256 mismatch`);
  await mkdir(cacheDir, { recursive: true });
  const partial = `${targetPath}.${randomUUID()}.partial`;
  try {
    await writeFile(partial, bytes, { flag: 'wx' });
    await rename(partial, targetPath);
  } finally {
    await rm(partial, { force: true });
  }
  return targetPath;
}

function runCli(args) {
  const run = spawnSync(command[0], [...command.slice(1), ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (run.error) throw run.error;
  return run;
}

function countNonZero(arr) {
  let n = 0;
  for (let i = 0; i < arr.length; i += 1) {
    if (arr[i] > 0) n += 1;
  }
  return n;
}

function assertAffineClose(actual, expected, label) {
  for (let r = 0; r < 4; r += 1) {
    for (let c = 0; c < 4; c += 1) {
      assert.ok(
        Math.abs(actual[r][c] - expected[r][c]) <= 1e-4,
        `${label} affine[${r}][${c}] mismatch: ${actual[r][c]} vs ${expected[r][c]}`,
      );
    }
  }
}

const work = await mkdtemp(join(tmpdir(), 'tumour-report-cli-check-'));
try {
  // 1. self-check
  const selfCheck = runCli(['self-check']);
  assert.equal(selfCheck.status, 0, `self-check failed: ${selfCheck.stderr}`);
  const selfInfo = JSON.parse(selfCheck.stdout.trim());
  assert.equal(selfInfo.ok, true, 'self-check must report ok=true');
  assert.equal(selfInfo.executionProvider, 'cpu', 'self-check must report cpu provider');
  assert.equal(selfInfo.greedy, 'wasm-single', 'self-check must report greedy wasm-single');
  console.log(`PASS self-check (v${selfInfo.version}, ORT ${selfInfo.onnxRuntime}, ${selfInfo.assets} assets)`);

  // 2. Full offline segmentation + native morphometry + MNI Greedy RADS on BEAMSTER_A_038
  const examplePath = await ensureExample(exampleSpec);
  const inputVolume = readVolume((await readFile(examplePath)).buffer);
  const outDir = join(work, 'beamster-full');
  const fullRun = runCli([
    examplePath,
    outDir,
    '--tumour-type',
    'metastasis',
    '--threads',
    '4',
    '--offline',
  ]);
  assert.equal(fullRun.status, 0, `full segmentation failed:\n${fullRun.stderr}`);
  const fullSummary = JSON.parse(fullRun.stdout.trim());
  assert.equal(fullSummary.provenance.executionProvider, 'cpu');
  assert.equal(fullSummary.provenance.mode, 'raidionics-v1.3');
  assert.equal(fullSummary.lesionCount, reference.results.nativeTumour.lesionCount);
  assert.ok(
    Math.abs(fullSummary.totalVolumeMl - reference.results.nativeTumour.totalVolumeMl) <= 0.5,
    `totalVolumeMl ${fullSummary.totalVolumeMl} drifted from reference ${reference.results.nativeTumour.totalVolumeMl}`,
  );

  const brainVol = readVolume((await readFile(join(outDir, 'BEAMSTER_A_038_T1c_brain_mask.nii'))).buffer);
  const tumourVol = readVolume((await readFile(join(outDir, 'BEAMSTER_A_038_T1c_tumour_mask.nii'))).buffer);
  const mniVol = readVolume((await readFile(join(outDir, 'BEAMSTER_A_038_T1c_tumour_mask_mni.nii'))).buffer);

  assert.deepEqual(brainVol.dims, inputVolume.dims);
  assert.deepEqual(tumourVol.dims, inputVolume.dims);
  assertAffineClose(brainVol.affine, inputVolume.affine, 'brain mask');
  assertAffineClose(tumourVol.affine, inputVolume.affine, 'tumour mask');
  assert.deepEqual(mniVol.dims, [197, 233, 189]);

  const brainVoxels = countNonZero(brainVol.data);
  const tumourVoxels = countNonZero(tumourVol.data);
  const mniVoxels = countNonZero(mniVol.data);
  assert.ok(
    Math.abs(brainVoxels - reference.results.nativeBrain.nodeVoxels) <= reference.results.nativeBrain.nodeVoxels * 0.02,
    `brainVoxels ${brainVoxels} drifted from reference ${reference.results.nativeBrain.nodeVoxels}`,
  );
  assert.ok(
    Math.abs(tumourVoxels - reference.results.nativeTumour.nodeVoxels) <= reference.results.nativeTumour.nodeVoxels * 0.02,
    `tumourVoxels ${tumourVoxels} drifted from reference ${reference.results.nativeTumour.nodeVoxels}`,
  );
  assert.ok(mniVoxels > 10000 && mniVoxels < 30000, `unexpected MNI tumour voxels: ${mniVoxels}`);

  const reportJson = JSON.parse(await readFile(join(outDir, 'BEAMSTER_A_038_T1c_report.json'), 'utf8'));
  assert.equal(reportJson.schemaVersion, 1);
  assert.equal(reportJson.tumourType, 'metastasis');
  assert.equal(reportJson.rads.laterality.leftPct, 100);
  const lobeNames = reportJson.rads.cortical.mniLobes.involved.map((item) => item.name);
  assert.ok(lobeNames.includes('frontal_left'), `expected frontal_left in ${lobeNames.join(', ')}`);
  assert.ok(lobeNames.includes('parietal_left'), `expected parietal_left in ${lobeNames.join(', ')}`);
  const lesionsLines = (await readFile(join(outDir, 'BEAMSTER_A_038_T1c_lesions.tsv'), 'utf8')).trim().split('\n');
  assert.equal(lesionsLines.length, 4, 'lesions.tsv must have header + 3 lesion rows');
  const summaryLines = (await readFile(join(outDir, 'BEAMSTER_A_038_T1c_rads_summary.tsv'), 'utf8')).trim().split('\n');
  assert.ok(summaryLines.length >= 10, 'rads_summary.tsv must include summary and MNI rows');
  console.log(
    `PASS beamster-a-038 full pipeline: ${fullSummary.lesionCount} lesions, ${fullSummary.totalVolumeMl.toFixed(3)} mL, ` +
    `brain ${brainVoxels} vox, tumour ${tumourVoxels} vox, MNI ${mniVoxels} vox (left ${reportJson.rads.laterality.leftPct}%)`,
  );

  // 3. Supplied-mask native-only mode (--mask --no-mni --skull-stripped)
  const maskOutDir = join(work, 'beamster-supplied-mask');
  const maskRun = runCli([
    examplePath,
    maskOutDir,
    '--mask',
    join(outDir, 'BEAMSTER_A_038_T1c_tumour_mask.nii'),
    '--no-mni',
    '--skull-stripped',
    '--tumour-type',
    'metastasis',
    '--offline',
  ]);
  assert.equal(maskRun.status, 0, `supplied-mask run failed:\n${maskRun.stderr}`);
  const maskSummary = JSON.parse(maskRun.stdout.trim());
  assert.equal(maskSummary.provenance.mode, 'supplied-mask');
  assert.equal(maskSummary.lesionCount, fullSummary.lesionCount);
  assert.equal(maskSummary.totalVolumeMl, fullSummary.totalVolumeMl);
  console.log(`PASS supplied-mask mode matches full morphometry (${maskSummary.lesionCount} lesions, ${maskSummary.totalVolumeMl.toFixed(3)} mL)`);
} finally {
  await rm(work, { recursive: true, force: true });
}

console.log('PASS @neurodesk/tumour-report portable CLI validation');
