import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { readNifti } from '@neurodesk/webapp-components/file-io/nifti';
import { dice, maskVoxels } from '../../../test-utils/dice.mjs';
import { pinnedExample } from './example.mjs';
import { browserReference, CASES } from './browser-reference.mjs';

const { values } = parseArgs({ options: { executable: { type: 'string' } } });
const command = values.executable
  ? [resolve(values.executable)]
  : [process.execPath, resolve('packages/vesselboost/bin/vesselboost.js')];
const cacheDir =
  process.env.NEURODESK_VESSELBOOST_MODEL_DIR ||
  (values.executable && join(await realpath(values.executable), '..', 'models'));
assert.ok(cacheDir, 'Set NEURODESK_VESSELBOOST_MODEL_DIR or pass a complete portable executable');
const work = await mkdtemp(join(tmpdir(), 'vesselboost-cli-check-'));
const example = await pinnedExample();
const browserOutput = join(work, 'browser');
await browserReference({ output: browserOutput, cacheDir });
const referenceBytes = await readFile(
  new URL(
    '../../../apps/vesselboost/test/fixtures/upstream-reference/lausanne-tof-crop-192x192x64_vesselboost-manual_0429.nii.gz',
    import.meta.url
  )
);
assert.equal(
  createHash('sha256').update(referenceBytes).digest('hex'),
  '6502ec4c92e57bc98fda8d2c33f6cbd305d147a6d12b9982cf0932a2e37a3a1d'
);
const reference = await readNifti(referenceBytes);
assert.equal(maskVoxels(reference.data), 33894);
for (const scenario of CASES) {
  const output = join(work, scenario.id);
  const p = scenario.parameters;
  const flags = [
    p.biasCorrection ? '--bias-correction' : '--no-bias-correction',
    '--model',
    p.model,
    '--downsample',
    String(p.downsample),
    '--denoise',
    p.denoise,
  ];
  if (p.brainExtraction) flags.push('--brain-extraction', p.brainExtraction);
  const result = spawnSync(
    command[0],
    [
      ...command.slice(1),
      example.path,
      output,
      '--threads',
      '4',
      '--offline',
      '--cache-dir',
      cacheDir,
      ...flags,
    ],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
  );
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.provenance.executionProvider, 'cpu');
  const browserDirectory = join(browserOutput, scenario.id);
  const nativeNames = (await readdir(output)).sort();
  const browserNames = (await readdir(browserDirectory)).sort();
  assert.deepEqual(nativeNames, browserNames);
  for (const name of nativeNames) {
    const a = await readFile(join(output, name));
    const b = await readFile(join(browserDirectory, name));
    assert.deepEqual(
      a.subarray(0, 352),
      b.subarray(0, 352),
      `${scenario.id}/${name} NIfTI headers`
    );
    const nativeVolume = await readNifti(a);
    const browserVolume = await readNifti(b);
    if (name === 'segmentation.nii') {
      const score = dice(nativeVolume.data, browserVolume.data);
      // Existing independent browser/PyTorch gate, unchanged. No tolerance invented for optional methods.
      assert.ok(score >= 0.99, `${scenario.id} CLI/browser Dice ${score} < existing 0.99 gate`);
      console.log(`PASS ${scenario.id} actual production browser/CLI Dice ${score}`);
      if (scenario.id === 'manual') {
        for (const [label, data] of [
          ['native', nativeVolume.data],
          ['browser', browserVolume.data],
        ]) {
          const independent = dice(data, reference.data);
          assert.ok(independent >= 0.99, `${label} independent PyTorch Dice ${independent}`);
          console.log(
            `PASS ${label} independent PyTorch manual_0429 Dice ${independent}, ${maskVoxels(
              data
            )} voxels`
          );
        }
      }
    } else {
      assert.deepEqual(a, b, `${scenario.id}/${name} required shared Rust preprocessing bytes`);
      console.log(`PASS ${scenario.id}/${name} browser/CLI byte-identical`);
    }
  }
}
console.log(`PASS VesselBoost CLI and actual production browser; receipts ${work}`);
