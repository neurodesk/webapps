import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { writeNiftiVolume } from '@neurodesk/webapp-components/file-io/nifti-volume';
import {
  findModel,
  labelColormap,
  labelNamesMap,
  MODELS,
  outputNames,
  stemFor,
  TISSUE_STAGES,
  validateOptions,
} from '../src/models.js';
import { checkInstallation, downloadModels, segment } from '../src/node.js';

const BIN = fileURLToPath(new URL('../bin/brainchop.js', import.meta.url));

function runBin(args) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });
}

test('MODELS catalog exposes all four v4.0 models with @brainchop/core colormaps', () => {
  assert.deepEqual(MODELS.map((m) => m.id), ['mindmap', 'mindmap-fast', 'mindsnap', 'tissue-fractions']);
  assert.equal(findModel('mindsnap')?.classes, 104);
  assert.equal(findModel('unknown'), null);
  for (const model of MODELS.filter((m) => m.kind === 'labels')) {
    const lut = labelColormap(model.id);
    assert.ok(lut, model.id);
    assert.equal(lut.labels.length, model.classes);
    assert.equal(lut.A[0], 0);
    assert.equal(lut.A[1], 255);
    assert.equal(Object.keys(labelNamesMap(model.id)).length, model.classes);
  }
  assert.equal(labelColormap('tissue-fractions'), null);
  assert.equal(TISSUE_STAGES.length, 4);
});

test('stemFor, outputNames, and validateOptions enforce model and flag contracts', () => {
  assert.equal(stemFor('sub-01_T1w.nii.gz'), 'sub-01_T1w');
  assert.deepEqual(outputNames('sub-01_T1w.nii.gz', 'mindmap'), { segmentation: 'sub-01_T1w_mindmap.nii' });
  assert.deepEqual(outputNames('sub-01_T1w.nii.gz', 'tissue-fractions'), {
    gm: 'sub-01_T1w_gm.nii',
    wm: 'sub-01_T1w_wm.nii',
    csf: 'sub-01_T1w_csf.nii',
    brain: 'sub-01_T1w_brain.nii',
  });
  assert.equal(validateOptions({ model: 'mindsnap', saveConform: true }).model.id, 'mindsnap');
  assert.throws(() => validateOptions({ model: 'bogus' }), /Unknown model/);
  assert.throws(
    () => validateOptions({ model: 'tissue-fractions', legacyCleanup: true }),
    /legacyCleanup is only supported for label models/,
  );
});

test('segment enforces exclusive lock, cleans up failed output dir, and validates gzip/overflow', async () => {
  const work = await mkdtemp(join(tmpdir(), 'brainchop-node-'));
  try {
    // Empty model / input fails BEFORE creating output directory.
    const untouched = join(work, 'untouched');
    await assert.rejects(
      segment({ input: 'in.nii', output: untouched, model: '' }),
      /model must be a non-empty string/,
    );
    await assert.rejects(access(untouched), { code: 'ENOENT' });

    // Exclusive lock rejects concurrent runs.
    const lockedDir = join(work, 'locked');
    await mkdir(lockedDir);
    await writeFile(join(lockedDir, '.brainchop.lock'), '{"pid":1}\n');
    await assert.rejects(
      segment({ input: join(work, 'missing.nii'), output: lockedDir }),
      /locked by another process/,
    );

    // Bad gzip CRC fails and cleans up newly created output dir.
    const raw = Buffer.from(writeNiftiVolume({
      data: new Float32Array(8).fill(1),
      dims: [2, 2, 2],
      affine: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]],
    }));
    const badGz = Buffer.from(gzipSync(raw));
    badGz[badGz.length - 5] ^= 0xff;
    const badPath = join(work, 'corrupt.nii.gz');
    const failedOut = join(work, 'failed-out');
    await writeFile(badPath, badGz);
    await assert.rejects(segment({ input: badPath, output: failedOut }));
    await assert.rejects(access(failedOut), { code: 'ENOENT' });

    // FLOAT64 1e100 voxel overflow fails cleanly and removes output dir.
    const overflowData = new Float64Array(8).fill(1);
    overflowData[2] = 1e100;
    const overflowBuf = Buffer.from(writeNiftiVolume({
      data: overflowData,
      dims: [2, 2, 2],
      affine: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]],
    }));
    const overflowPath = join(work, 'overflow.nii');
    const overflowOut = join(work, 'overflow-out');
    await writeFile(overflowPath, overflowBuf);
    await assert.rejects(
      segment({ input: overflowPath, output: overflowOut }),
      /non-finite or float32-overflowing intensities/,
    );
    await assert.rejects(access(overflowOut), { code: 'ENOENT' });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('checkInstallation, downloadModels, and CLI enforce strict per-subcommand options', async () => {
  const existingDir = await mkdtemp(join(tmpdir(), 'brainchop-cache-'));
  try {
    const info = await checkInstallation({ cacheDir: existingDir });
    assert.equal(info.ok, true);
    assert.equal(info.executable, process.execPath);
    assert.equal(info.node, process.version);
    assert.equal(info.backend, 'cpu');
    assert.equal(info.corePackage, '@brainchop/core');
    assert.equal(info.modelsEmbedded, true);

    await assert.rejects(checkInstallation({ cacheDir: '' }), /non-empty/);
    await assert.rejects(checkInstallation({ cacheDir: join(existingDir, 'missing') }), /does not exist/);

    const dl = await downloadModels({ cacheDir: existingDir });
    assert.equal(dl.count, 0);
    assert.equal(dl.modelsEmbedded, true);
    await assert.rejects(downloadModels({ cacheDir: '' }), /non-empty/);

    const help = execFileSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
    assert.match(help, /Usage: brainchop/);

    const selfOut = runBin(['self-check']);
    assert.equal(selfOut.status, 0, selfOut.stderr);
    assert.equal(JSON.parse(selfOut.stdout.trim()).ok, true);

    const badCases = [
      ['download-models', '--model=fake'],
      ['download-models', '--cache-dir='],
      ['download-models', '--threads=2'],
      ['self-check', '--model=mindmap'],
      ['self-check', '--cache-dir='],
      ['self-check', '--save-conform'],
      ['in.nii', 'out', '--cache-dir=/tmp'],
      ['in.nii', 'out', '--model='],
      ['in.nii', 'out', '--threads='],
      ['in.nii', 'out', '--threads=1.5'],
    ];
    for (const args of badCases) {
      const res = runBin(args);
      assert.notEqual(res.status, 0, `Expected failure for args: ${args.join(' ')}`);
    }
  } finally {
    await rm(existingDir, { recursive: true, force: true });
  }
});
