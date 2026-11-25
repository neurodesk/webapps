#!/usr/bin/env node
// Portable release validation for @neurodesk/brainchop.
// Exercises the packaged executable (or bin/brainchop.js) on the pinned T1 MRI
// example from apps/brainchop/examples.json across both label segmentation and
// tissue fraction maps, caching the example under tmpdir() so isolated $HOME
// stays completely untouched.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { parseNiftiVolume, sameNiftiGrid } from '@neurodesk/webapp-components/file-io/nifti';

const { values } = parseArgs({ options: { executable: { type: 'string' } } });
const command = values.executable
  ? [resolve(values.executable)]
  : [process.execPath, fileURLToPath(new URL('../bin/brainchop.js', import.meta.url))];

const examples = JSON.parse(
  await readFile(new URL('../../../apps/brainchop/examples.json', import.meta.url), 'utf8'),
);
const exampleSpec = examples.find((item) => item.id === 't1-brain')?.files?.[0];
assert.ok(exampleSpec, 'Pinned t1-brain example must exist in apps/brainchop/examples.json');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function ensureExample(spec) {
  const cacheDir = join(tmpdir(), 'neurodesk-brainchop-validation-cache');
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

const work = await mkdtemp(join(tmpdir(), 'brainchop-cli-check-'));
try {
  // 1. self-check
  const selfCheck = runCli(['self-check']);
  assert.equal(selfCheck.status, 0, `self-check failed: ${selfCheck.stderr}`);
  const selfInfo = JSON.parse(selfCheck.stdout.trim());
  assert.equal(selfInfo.ok, true, 'self-check must report ok=true');
  assert.equal(selfInfo.backend, 'cpu');
  assert.equal(selfInfo.corePackage, '@brainchop/core');
  assert.equal(selfInfo.modelsEmbedded, true);
  assert.deepEqual(selfInfo.models, ['mindmap', 'mindmap-fast', 'mindsnap', 'tissue-fractions']);
  console.log(`PASS self-check (v${selfInfo.version}, @brainchop/core ${selfInfo.coreVersion})`);

  // 2. Real T1 brain MRI: mindmap-fast label segmentation
  const examplePath = await ensureExample(exampleSpec);
  const inputBytes = await readFile(examplePath);
  const inputUncompressed = gunzipSync(inputBytes);
  const inputVol = parseNiftiVolume(inputUncompressed);

  const labelOutDir = join(work, 'mindmap-fast');
  const labelRun = runCli([examplePath, labelOutDir, '--model', 'mindmap-fast', '--threads', '4', '--offline']);
  assert.equal(labelRun.status, 0, `mindmap-fast failed:\n${labelRun.stderr}`);
  const labelReport = JSON.parse(labelRun.stdout.trim());
  assert.equal(labelReport.kind, 'labels');
  assert.equal(labelReport.model, 'mindmap-fast');
  assert.equal(labelReport.provenance.backend, 'cpu');
  assert.deepEqual(labelReport.files, ['t1_crop_mindmap-fast.nii']);

  const labelBytes = await readFile(join(labelOutDir, labelReport.files[0]));
  const labelVol = parseNiftiVolume(labelBytes);
  assert.deepEqual(labelVol.dims, inputVol.dims);
  assert.equal(sameNiftiGrid(labelBytes, inputUncompressed, 0.05), true, 'label output must stay on input grid');
  assert.ok(labelReport.uniqueLabels >= 10 && labelReport.uniqueLabels <= 17, `expected 10..17 non-zero labels, got ${labelReport.uniqueLabels}`);
  const brainFrac = labelReport.nonZeroVoxels / labelVol.imageData.length;
  assert.ok(brainFrac > 0.05 && brainFrac < 0.8, `plausible brain fraction expected (0.05..0.80), got ${brainFrac.toFixed(4)}`);
  console.log(
    `PASS mindmap-fast: dims ${labelVol.dims.join('x')}, ${labelReport.uniqueLabels} classes, ` +
    `${labelReport.nonZeroVoxels} voxels (${(brainFrac * 100).toFixed(1)}%) in ${labelReport.elapsedMs} ms`,
  );

  // 3. Real T1 brain MRI: GM/WM/CSF tissue fraction maps
  const tissueOutDir = join(work, 'tissue-fractions');
  const tissueRun = runCli([examplePath, tissueOutDir, '--model', 'tissue-fractions', '--threads', '4', '--offline']);
  assert.equal(tissueRun.status, 0, `tissue-fractions failed:\n${tissueRun.stderr}`);
  const tissueReport = JSON.parse(tissueRun.stdout.trim());
  assert.equal(tissueReport.kind, 'tissues');
  assert.equal(tissueReport.model, 'tissue-fractions');
  assert.deepEqual(tissueReport.files, ['t1_crop_gm.nii', 't1_crop_wm.nii', 't1_crop_csf.nii', 't1_crop_brain.nii']);

  for (const stage of ['gm', 'wm', 'csf', 'brain']) {
    const mapInfo = tissueReport.maps[stage];
    assert.ok(mapInfo.nonZeroVoxels > 10_000, `${stage} has too few non-zero voxels: ${mapInfo.nonZeroVoxels}`);
    assert.ok(mapInfo.max > 0.5 && mapInfo.max <= 1.001, `${stage} max fraction out of range: ${mapInfo.max}`);
    const mapBytes = await readFile(join(tissueOutDir, mapInfo.file));
    const mapVol = parseNiftiVolume(mapBytes);
    assert.deepEqual(mapVol.dims, inputVol.dims);
    assert.equal(sameNiftiGrid(mapBytes, inputUncompressed, 0.05), true, `${stage} output must stay on input grid`);
  }
  console.log(
    `PASS tissue-fractions: GM ${tissueReport.maps.gm.nonZeroVoxels}, WM ${tissueReport.maps.wm.nonZeroVoxels}, ` +
    `CSF ${tissueReport.maps.csf.nonZeroVoxels}, brain ${tissueReport.maps.brain.nonZeroVoxels} voxels in ${tissueReport.elapsedMs} ms`,
  );
} finally {
  await rm(work, { recursive: true, force: true });
}

console.log('PASS @neurodesk/brainchop portable CLI validation');
