import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { readNiftiFrames } from '../../components/src/file-io/NiftiUtils.js';
import { syntheticNifti } from '../../../test-utils/nifti-fixture.mjs';
import { createN4, epiReferenceArguments } from '../src/index.js';
import createModule from '../wasm/n4-bias.mjs';

const expected = [
  '-d', '3', '-i', '/n4-0/in.nii', '-o', '[/n4-0/corrected.nii,/n4-0/bias.nii]',
  '--convergence', '[50x50x50x50x50,1e-07]', '--shrink-factor', '4',
];

test('EPI-reference N4 uses the niworkflows convergence and shrink schedule', () => {
  assert.deepEqual(epiReferenceArguments({
    input: '/n4-0/in.nii', corrected: '/n4-0/corrected.nii', bias: '/n4-0/bias.nii',
  }), expected);
  assert.throws(() => epiReferenceArguments({ weight: 'mask.nii' }), /does not use a weight/);
});

test('the existing N4 WASM executes the EPI-reference profile and returns corrected image and bias', async () => {
  const image = syntheticNifti({ dims: [16, 16, 16], value: (index) => 10 + index % 16 + 2 * (Math.floor(index / 16) % 16) + Math.floor(index / 256) });
  let actual;
  const n4 = await createN4({
    createModule: async (options) => {
      const module = await createModule(options);
      const call = module.callMain.bind(module);
      module.callMain = (argv) => {
        actual = [...argv];
        return call(argv);
      };
      return module;
    },
    wasmBinary: await readFile(new URL('../wasm/n4-bias.wasm', import.meta.url)),
    buildArguments: epiReferenceArguments,
  });
  const { corrected, bias } = await n4.correct({ image });
  assert.deepEqual(actual, expected);
  const output = readNiftiFrames(corrected).data;
  const field = readNiftiFrames(bias).data;
  assert.ok(output.every(Number.isFinite));
  assert.ok(field.every((value) => Number.isFinite(value) && value > 0));
  assert.ok(Math.max(...field) - Math.min(...field) > 1e-3, "the nonuniform input receives a spatial bias correction");
  for (let index = 0; index < output.length; index++) {
    const x = index % 16;
    const y = Math.floor(index / 16) % 16;
    const z = Math.floor(index / 256);
    const original = 10 + x + 2 * y + z;
    assert.ok(Math.abs(output[index] * field[index] - original) < 1e-4);
  }
});
