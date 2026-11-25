import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
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
import { checkInstallation, downloadModels } from '../src/node.js';

const BIN = fileURLToPath(new URL('../bin/brainchomp.js', import.meta.url));

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

test('prepareModelInput and applyBrainMask round-trip NIfTI geometry and mask values', () => {
  const dims = [4, 4, 4];
  const data = Float32Array.from({ length: 64 }, (_, i) => i + 1);
  const affine = [
    [0.1, 0, 0, -0.2],
    [0, 0.1, 0, -0.2],
    [0, 0, 0.1, -0.2],
    [0, 0, 0, 1],
  ];
  const rawBuf = writeNifti3d({ data, dims, affine }, 'test rodent');
  const vol = readNifti3d(rawBuf);
  assert.deepEqual(vol.dims, dims);

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
  const brainVol = readNifti3d(brain);
  const maskVol = readNifti3d(mask);
  assert.equal(brainVol.data[5], 6);
  assert.equal(brainVol.data[0], 0);
  assert.equal(maskVol.data[10], 1);
  assert.ok(Math.abs(brainVol.affine[0][0] - 0.1) < 1e-6);
});

test('packaged CPU WASM files match apps/brainchomp/public/brainchomp byte-for-byte', async () => {
  for (const name of ['brainchomp.js', 'brainchomp.wasm']) {
    const pkgBytes = await readFile(new URL(`../wasm/${name}`, import.meta.url));
    const appBytes = await readFile(new URL(`../../../apps/brainchomp/public/brainchomp/${name}`, import.meta.url));
    assert.deepEqual(pkgBytes, appBytes, `${name} drifted from apps/brainchomp/public/brainchomp/${name}`);
  }
});

test('checkInstallation, downloadModels, and CLI --help/self-check work offline', async () => {
  const info = await checkInstallation();
  assert.equal(info.ok, true);
  assert.equal(info.executable, process.execPath);
  assert.equal(info.node, process.version);
  assert.equal(info.backend, 'cpu');
  assert.equal(info.modelsEmbedded, true);

  const dl = await downloadModels({ cacheDir: '/tmp/unused' });
  assert.equal(dl.count, 0);
  assert.equal(dl.modelsEmbedded, true);

  const help = execFileSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  assert.match(help, /Usage: brainchomp/);
  assert.match(help, /self-check/);

  const selfOut = execFileSync(process.execPath, [BIN, 'self-check'], { encoding: 'utf8' });
  const parsed = JSON.parse(selfOut.trim());
  assert.equal(parsed.ok, true);
  assert.equal(parsed.executable, process.execPath);
});
