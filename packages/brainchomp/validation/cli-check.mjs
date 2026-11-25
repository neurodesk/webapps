#!/usr/bin/env node
// Portable release validation for @neurodesk/brainchomp.
// Exercises the packaged executable (or bin/brainchomp.js) on the pinned rodent
// MRI example from apps/brainchomp/examples.json, caching under tmpdir() so
// isolated $HOME stays completely untouched.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { readNifti3d } from '../src/pipeline.js';

const { values } = parseArgs({ options: { executable: { type: 'string' } } });
const command = values.executable
  ? [resolve(values.executable)]
  : [process.execPath, fileURLToPath(new URL('../bin/brainchomp.js', import.meta.url))];

const examples = JSON.parse(
  await readFile(new URL('../../../apps/brainchomp/examples.json', import.meta.url), 'utf8'),
);
const exampleSpec = examples.find((item) => item.id === 'rodent-mri')?.files?.[0];
assert.ok(exampleSpec, 'Pinned rodent-mri example must exist in apps/brainchomp/examples.json');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function ensureExample(spec) {
  const cacheDir = join(tmpdir(), 'neurodesk-brainchomp-validation-cache');
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

const work = await mkdtemp(join(tmpdir(), 'brainchomp-cli-check-'));
try {
  // 1. self-check
  const selfCheck = runCli(['self-check']);
  assert.equal(selfCheck.status, 0, `self-check failed: ${selfCheck.stderr}`);
  const selfInfo = JSON.parse(selfCheck.stdout.trim());
  assert.equal(selfInfo.ok, true, 'self-check must report ok=true');
  assert.equal(selfInfo.backend, 'cpu');
  assert.equal(selfInfo.modelsEmbedded, true);
  console.log(`PASS self-check (v${selfInfo.version}, library ${selfInfo.libraryRevision.slice(0, 8)})`);

  // 2. Real rodent MRI extraction
  const examplePath = await ensureExample(exampleSpec);
  const inputVol = readNifti3d(await readFile(examplePath), { decompress: gunzipSync });
  const outDir = join(work, 'rodent-out');
  const run = runCli([examplePath, outDir, '--threads', '4', '--offline']);
  assert.equal(run.status, 0, `brainchomp extraction failed:\n${run.stderr}`);
  const report = JSON.parse(run.stdout.trim());
  assert.equal(report.provenance.backend, 'cpu');
  assert.equal(report.provenance.openingRadius, 4);
  assert.deepEqual(report.files, ['MA_F_15M_20_image_brainchomp_brain.nii', 'MA_F_15M_20_image_brainchomp_mask.nii']);

  const brainVol = readNifti3d(await readFile(join(outDir, report.files[0])), { decompress: gunzipSync });
  const maskVol = readNifti3d(await readFile(join(outDir, report.files[1])), { decompress: gunzipSync });

  assert.deepEqual(brainVol.dims, inputVol.dims);
  assert.deepEqual(maskVol.dims, inputVol.dims);
  assertAffineClose(brainVol.affine, inputVol.affine, 'brain');
  assertAffineClose(maskVol.affine, inputVol.affine, 'mask');

  let maskCount = 0;
  let outsideNonZero = 0;
  let insideNonZero = 0;
  for (let i = 0; i < maskVol.data.length; i += 1) {
    const m = maskVol.data[i];
    assert.ok(m === 0 || m === 1, `non-binary mask value ${m} at voxel ${i}`);
    if (m === 1) {
      maskCount += 1;
      if (brainVol.data[i] !== 0) insideNonZero += 1;
    } else if (brainVol.data[i] !== 0) {
      outsideNonZero += 1;
    }
  }
  assert.equal(maskCount, report.maskVoxels);
  assert.equal(outsideNonZero, 0, 'brain output must be zero outside the brain mask');
  assert.ok(insideNonZero > 100_000, `brain has too few non-zero voxels: ${insideNonZero}`);
  const fraction = maskCount / maskVol.data.length;
  assert.ok(
    fraction > 0.02 && fraction < 0.75,
    `plausible rodent brain mask fraction expected (0.02..0.75), got ${fraction.toFixed(4)} (${maskCount} voxels)`,
  );
  console.log(
    `PASS rodent-mri extraction: dims ${brainVol.dims.join('x')}, ${maskCount} mask voxels ` +
    `(${(fraction * 100).toFixed(1)}%, ${report.brainVolumeMm3.toFixed(1)} mm^3) in ${report.elapsedMs} ms`,
  );
} finally {
  await rm(work, { recursive: true, force: true });
}

console.log('PASS @neurodesk/brainchomp portable CLI validation');
