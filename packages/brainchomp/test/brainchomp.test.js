import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { parseNiftiVolumeHeader } from '@neurodesk/webapp-components/file-io/nifti-volume';
import {
  applyWorldRemap,
  availableDirections,
  buildReorientMatrix,
  INPUT_WORLD_REMAP,
  outputNames,
} from '../src/orient.js';
import {
  applyBrainMask,
  prepareModelInput,
  readNifti3d,
  validateOptions,
  writeNifti3d,
} from '../src/pipeline.js';
import { checkInstallation, downloadModels, extract } from '../src/node.js';

const BIN = fileURLToPath(new URL('../bin/brainchomp.js', import.meta.url));

function runBin(args) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });
}

test('orientation helpers and outputNames match Brainchomp conventions', () => {
  assert.equal(buildReorientMatrix(['A', 'S', 'L']), null);
  assert.equal(buildReorientMatrix(['A', 'S', '?']), null);
  assert.deepEqual(buildReorientMatrix(['A', 'I', '?']), [
    [-1, 0, 0],
    [0, 1, 0],
    [0, 0, -1],
  ]);
  assert.deepEqual(availableDirections(['A', 'I']), ['R', 'L']);
  const affine = [
    [0.1, 0, 0, -12.8],
    [0, 0, 0.1, -12.8],
    [0, 0.1, 0, -12.8],
    [0, 0, 0, 1],
  ];
  assert.deepEqual(applyWorldRemap(affine, INPUT_WORLD_REMAP), [
    [-0.1, 0, 0, 12.8],
    [0, -0.1, 0, 12.8],
    [0, 0, 0.1, -12.8],
    [0, 0, 0, 1],
  ]);
  assert.deepEqual(outputNames('mouse_t2w.nii.gz'), {
    brain: 'mouse_t2w_brainchomp_brain.nii',
    mask: 'mouse_t2w_brainchomp_mask.nii',
    reoriented: 'mouse_t2w_reoriented.nii',
  });
});

test('validateOptions checks opening radius and fillHoles', () => {
  assert.deepEqual(validateOptions(), { opening: 4, fillHoles: true });
  assert.deepEqual(validateOptions({ opening: 0, fillHoles: false }), { opening: 0, fillHoles: false });
  assert.throws(() => validateOptions({ opening: -1 }), /opening/);
  assert.throws(() => validateOptions({ opening: 65 }), /opening/);
  assert.throws(() => validateOptions({ fillHoles: 'yes' }), /fillHoles/);
});

test('prepareModelInput and applyBrainMask preserve qform+sform, support NIfTI-2, and reject float32 affine overflow', () => {
  const dims = [4, 4, 4];
  const data = Float32Array.from({ length: 64 }, (_, i) => i + 1);
  const affine = [
    [0.1, 0, 0, -0.2],
    [0, 0.1, 0, -0.2],
    [0, 0, 0.1, -0.2],
    [0, 0, 0, 1],
  ];
  const transforms = {
    qformCode: 2,
    sformCode: 1,
    pixdim0: 1,
    pixDims: [0.1, 0.1, 0.1],
    quaternB: 0,
    quaternC: 0,
    quaternD: 0,
    qoffsetX: -1.5,
    qoffsetY: -0.2,
    qoffsetZ: -0.2,
    srowX: affine[0],
    srowY: affine[1],
    srowZ: affine[2],
    xyztUnits: 2,
  };
  const rawBuf = writeNifti3d({ data, dims, affine, transforms, version: 1 }, 'test rodent');
  const vol = readNifti3d(rawBuf);
  assert.deepEqual(vol.dims, dims);
  assert.equal(vol.affineSource, 'sform');
  assert.ok(Math.abs(vol.affine[0][3] - -0.2) < 1e-6);

  const remappedBuf = prepareModelInput(vol);
  const remappedVol = readNifti3d(remappedBuf);
  assert.ok(Math.abs(remappedVol.affine[0][0] - -0.1) < 1e-6);
  assert.ok(Math.abs(remappedVol.affine[1][2] - -0.1) < 1e-6);
  assert.ok(Math.abs(remappedVol.affine[2][1] - 0.1) < 1e-6);

  const maskData = new Uint8Array(64);
  maskData[5] = 1;
  maskData[10] = 1;
  const { brain, mask, maskVoxels } = applyBrainMask(vol, { data: maskData, dims, affine });
  assert.equal(maskVoxels, 2);
  const brainHdr = parseNiftiVolumeHeader(brain);
  const maskHdr = parseNiftiVolumeHeader(mask);
  assert.equal(brainHdr.qformCode, 2);
  assert.equal(brainHdr.sformCode, 1);
  assert.ok(Math.abs(brainHdr.transforms.qoffsetX - -1.5) < 1e-5);
  assert.equal(maskHdr.qformCode, 2);
  assert.equal(maskHdr.sformCode, 1);

  // Qform-only NIfTI-2 preserved on applyBrainMask.
  const v2Buf = writeNifti3d({
    data,
    dims,
    affine,
    transforms: { ...transforms, qformCode: 1, sformCode: 0, qoffsetX: -0.2 },
    version: 2,
  });
  const v2Vol = readNifti3d(v2Buf);
  assert.equal(v2Vol.version, 2);
  const v2Out = applyBrainMask(v2Vol, { data: maskData, dims, affine });
  assert.equal(parseNiftiVolumeHeader(v2Out.mask).version, 2);

  // Float32 affine overflow rejected when preparing NIfTI-1 model input.
  assert.throws(
    () => prepareModelInput({
      data,
      dims,
      affine: [
        [0.1, 0, 0, 1e100],
        [0, 0.1, 0, 0],
        [0, 0, 0.1, 0],
        [0, 0, 0, 1],
      ],
    }),
    /NIfTI-1 finite float32/,
  );
});

test('packaged CPU WASM files match apps/brainchomp/public/brainchomp byte-for-byte', async () => {
  for (const name of ['brainchomp.js', 'brainchomp.wasm']) {
    const pkgBytes = await readFile(new URL(`../wasm/${name}`, import.meta.url));
    const appBytes = await readFile(new URL(`../../../apps/brainchomp/public/brainchomp/${name}`, import.meta.url));
    assert.deepEqual(pkgBytes, appBytes, `${name} drifted from apps/brainchomp/public/brainchomp/${name}`);
  }
});

test('extract enforces exclusive lock, cleans up failed output dir, and validates gzip/overflow', async () => {
  const work = await mkdtemp(join(tmpdir(), 'brainchomp-node-'));
  try {
    // Invalid options and unknown keys fail BEFORE touching output directory.
    const untouched = join(work, 'untouched');
    await assert.rejects(extract({ input: '', output: untouched }), /input must be a non-empty string/);
    await assert.rejects(extract({ input: 'in.nii', output: untouched, opennig: 4 }), /Unknown option in extract options: opennig/);
    await assert.rejects(extract({ input: 'in.nii', output: untouched, fillHoles: null }), /fillHoles must be a boolean/);
    await assert.rejects(extract({ input: 'in.nii', output: untouched, overwrite: null }), /overwrite must be a boolean/);
    await assert.rejects(access(untouched), { code: 'ENOENT' });

    // Shared exclusive lock file rejects concurrent runs.
    const lockedDir = join(work, 'locked');
    await mkdir(lockedDir);
    await writeFile(join(lockedDir, '.neurodesk-cli.lock'), '{"pid":1}\n');
    await assert.rejects(
      extract({ input: join(work, 'missing.nii'), output: lockedDir }),
      /locked by another process/,
    );

    // Bad gzip CRC fails and cleans up newly created output dir.
    const raw = Buffer.from(writeNifti3d({
      data: new Float32Array(8).fill(1),
      dims: [2, 2, 2],
      affine: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]],
    }));
    const badGz = Buffer.from(gzipSync(raw));
    badGz[badGz.length - 5] ^= 0xff;
    const badPath = join(work, 'corrupt.nii.gz');
    const failedOut = join(work, 'failed-out');
    await writeFile(badPath, badGz);
    await assert.rejects(extract({ input: badPath, output: failedOut }));
    await assert.rejects(access(failedOut), { code: 'ENOENT' });

    // FLOAT64 1e100 voxel overflow fails and cleans up newly created output dir.
    const overflowData = new Float64Array(8).fill(1);
    overflowData[3] = 1e100;
    const overflowBuf = Buffer.from(writeNifti3d({
      data: overflowData,
      dims: [2, 2, 2],
      affine: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]],
    }));
    const overflowPath = join(work, 'overflow.nii');
    const overflowOut = join(work, 'overflow-out');
    await writeFile(overflowPath, overflowBuf);
    await assert.rejects(
      extract({ input: overflowPath, output: overflowOut }),
      /non-finite or float32-overflowing intensities/,
    );
    await assert.rejects(access(overflowOut), { code: 'ENOENT' });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('checkInstallation, downloadModels, and CLI enforce strict per-subcommand options', async () => {
  const existingDir = await mkdtemp(join(tmpdir(), 'brainchomp-cache-'));
  try {
    const info = await checkInstallation({ cacheDir: existingDir });
    assert.equal(info.ok, true);
    assert.equal(info.executable, process.execPath);
    assert.equal(info.node, process.version);
    assert.equal(info.backend, 'cpu');
    assert.equal(info.modelsEmbedded, true);

    await assert.rejects(checkInstallation({ cacheDir: '' }), /non-empty/);
    await assert.rejects(checkInstallation({ cacheDir: join(existingDir, 'missing') }), /does not exist/);

    const dl = await downloadModels({ cacheDir: existingDir });
    assert.equal(dl.count, 0);
    assert.equal(dl.modelsEmbedded, true);
    await assert.rejects(downloadModels({ cacheDir: '' }), /non-empty/);

    const help = execFileSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
    assert.match(help, /Usage: brainchomp/);

    const selfOut = runBin(['self-check']);
    assert.equal(selfOut.status, 0, selfOut.stderr);
    assert.equal(JSON.parse(selfOut.stdout.trim()).ok, true);

    const badCases = [
      ['download-models', '--opening=999'],
      ['download-models', '--cache-dir='],
      ['download-models', '--threads=2'],
      ['self-check', '--opening=4'],
      ['self-check', '--cache-dir='],
      ['self-check', '--no-fill-holes'],
      ['in.nii', 'out', '--cache-dir=/tmp'],
      ['in.nii', 'out', '--opening='],
      ['in.nii', 'out', '--opening=2.5'],
      ['in.nii', 'out', '--threads='],
    ];
    for (const args of badCases) {
      const res = runBin(args);
      assert.notEqual(res.status, 0, `Expected failure for args: ${args.join(' ')}`);
    }
  } finally {
    await rm(existingDir, { recursive: true, force: true });
  }
});
