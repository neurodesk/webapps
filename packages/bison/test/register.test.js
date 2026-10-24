import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkArguments } from '@neurodesk/hmc-registration';
import { loadHmcRegistration } from '@neurodesk/hmc-registration/node';
import { createFloat32Nifti, createNiftiHeaderFromVolume, readNiftiImageData } from '@neurodesk/webapp-components/file-io/nifti';
import {
  affineArguments,
  applyArguments,
  flairToT1,
  niftiName,
  nonlinearArguments,
  rigidArguments,
  templateToFlair,
  templateToT1,
  templateToT1Linear,
} from '../src/register.js';

const count = (argv, token) => argv.filter((value) => value === token).length;
const valueAfter = (argv, flag) => argv[argv.indexOf(flag) + 1];

const REGISTRATIONS = {
  affine: affineArguments({ fixed: 'template.nii.gz', moving: 't1.nii.gz', output: 'lin_', seed: 7 }),
  nonlinear: nonlinearArguments({ fixed: 'template.nii.gz', moving: 't1_vp.nii', initial: 'lin.mat', output: 'nl_', seed: 7 }),
  rigid: rigidArguments({ fixed: 't1.nii.gz', moving: 'flair.nii.gz', output: 'rigid_', seed: 7 }),
};

test('every antsRegistration argv has one --float 1 and one --random-seed', () => {
  for (const [name, argv] of Object.entries(REGISTRATIONS)) {
    assert.equal(count(argv, '--float'), 1, name);
    assert.equal(valueAfter(argv, '--float'), '1', name);
    assert.equal(count(argv, '--random-seed'), 1, name);
    assert.equal(valueAfter(argv, '--random-seed'), '7', name);
    assert.doesNotThrow(() => checkArguments(argv), name);
  }
});

test('same-modality stages use correlation, the FLAIR rigid mutual information', () => {
  const metrics = (argv) => argv.filter((_, i) => argv[i - 1] === '--metric').map((metric) => metric.slice(0, metric.indexOf('[')));
  assert.deepEqual(metrics(REGISTRATIONS.affine), ['GC', 'GC']);
  assert.deepEqual(metrics(REGISTRATIONS.nonlinear), ['GC', 'CC']);
  assert.deepEqual(metrics(REGISTRATIONS.rigid), ['Mattes']);
  assert.deepEqual(metrics(affineArguments({ fixed: 'f.nii', moving: 'm.nii', output: 'o_', metric: 'Mattes' })), ['Mattes', 'Mattes']);
  assert.throws(() => affineArguments({ fixed: 'f.nii', moving: 'm.nii', output: 'o_', metric: 'MI' }), /Unknown registration metric/);
});

test('the registration stages follow the native tools', () => {
  const transforms = (argv) => argv.filter((_, i) => argv[i - 1] === '--transform');
  assert.deepEqual(transforms(REGISTRATIONS.affine), ['Rigid[0.1]', 'Affine[0.1]']);
  assert.equal(valueAfter(REGISTRATIONS.affine, '--initial-moving-transform'), '[template.nii.gz,t1.nii.gz,1]');
  assert.deepEqual(transforms(REGISTRATIONS.nonlinear), ['Affine[0.1]', 'SyN[0.1,3,0]']);
  assert.equal(valueAfter(REGISTRATIONS.nonlinear, '--initial-moving-transform'), 'lin.mat');
  // nlfit_s -level 2: the finest SyN level is shrink 2 on the 1 mm template.
  const shrinks = REGISTRATIONS.nonlinear.filter((_, i) => REGISTRATIONS.nonlinear[i - 1] === '--shrink-factors');
  assert.equal(shrinks.at(-1).split('x').at(-1), '2');
  assert.deepEqual(transforms(REGISTRATIONS.rigid), ['Rigid[0.1]']);
  // bestlinreg_s2 -close: no centre-of-mass start.
  assert.equal(count(REGISTRATIONS.rigid, '--initial-moving-transform'), 0);
});

test('seeds outside the kernel range are refused', () => {
  for (const seed of [0, -1, 1.5, 2147483648, '3']) {
    assert.throws(() => affineArguments({ fixed: 'f.nii', moving: 'm.nii', output: 'o_', seed }), /seed/);
  }
});

test('transform lists put the transform that acts first on the output point last', () => {
  assert.deepEqual(templateToT1Linear({ affine: 'lin.mat' }), ['inverse:lin.mat']);
  assert.deepEqual(templateToT1({ affine: 'nl.mat', inverseWarp: 'nl_inverse.nii.gz' }), ['nl_inverse.nii.gz', 'inverse:nl.mat']);
  assert.deepEqual(templateToFlair({ t1Affine: 'lin.mat', rigid: 'rigid.mat' }), ['inverse:lin.mat', 'inverse:rigid.mat']);
  assert.deepEqual(flairToT1({ rigid: 'rigid.mat' }), ['rigid.mat']);
});

test('applyArguments builds --apply argv and refuses unknown interpolation', () => {
  assert.deepEqual(
    applyArguments({ fixed: 'f.nii', moving: 'm.nii', output: 'o.nii', interpolation: 'BSpline[2]', transforms: ['a.mat'] }),
    ['--apply', 'f.nii', 'm.nii', 'o.nii', 'BSpline[2]', '0', 'a.mat'],
  );
  assert.throws(() => applyArguments({ fixed: 'f', moving: 'm', output: 'o', interpolation: 'Cubic', transforms: ['a.mat'] }), /interpolation/);
  assert.throws(() => applyArguments({ fixed: 'f', moving: 'm', output: 'o', interpolation: 'Linear', transforms: [] }), /transform/);
  assert.deepEqual(checkArguments(applyArguments({ fixed: 'f.nii', moving: 'm.nii', output: 'o.nii', interpolation: 'Linear', transforms: ['inverse:a.mat'] })).length, 7);
});

test('niftiName keeps .nii.gz for gzipped bytes', () => {
  assert.equal(niftiName('t1', new Uint8Array([0x1f, 0x8b, 8])), 't1.nii.gz');
  assert.equal(niftiName('t1', new Uint8Array([92, 1, 0])), 't1.nii');
});

// An ITK .mat (MATLAB level 4) with one affine and its centre.
function matFile(parameters) {
  const parts = [];
  for (const [name, values] of [['AffineTransform_double_3_3', parameters], ['fixed', [0, 0, 0]]]) {
    const encoded = new TextEncoder().encode(name);
    const head = new DataView(new ArrayBuffer(20));
    [0, values.length, 1, 0, encoded.length + 1].forEach((value, i) => head.setInt32(4 * i, value, true));
    parts.push(new Uint8Array(head.buffer), encoded, new Uint8Array([0]), new Uint8Array(new Float64Array(values).buffer));
  }
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

test('hmc --apply applies the last listed transform first', async () => {
  // A 3-voxel cube at k = 32 on a 1 mm identity grid; T moves +10 mm along z, S doubles z.
  // Last listed first: moving(T(S(p))), so the cube lands at 2k + 10 = 32, k = 11 (else k = 6).
  const n = 64;
  const header = createNiftiHeaderFromVolume({ hdr: { dims: [3, n, n, n, 1, 1, 1, 1], pixDims: [1, 1, 1, 1, 1, 1, 1, 1], affine: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]] } });
  const image = new Float32Array(n ** 3);
  for (let z = 31; z <= 33; z++) {
    for (let y = 31; y <= 33; y++) {
      for (let x = 39; x <= 41; x++) image[(z * n + y) * n + x] = 100;
    }
  }
  const ants = await loadHmcRegistration();
  const { outputs } = ants.run(['--apply', 'image.nii', 'image.nii', 'out.nii', 'Linear', '0', 'T.mat', 'S.mat'], {
    'image.nii': new Uint8Array(createFloat32Nifti(image, header)),
    'T.mat': matFile([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 10]),
    'S.mat': matFile([1, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0]),
  });
  const { data } = readNiftiImageData(outputs['out.nii']);
  let peak = 0;
  for (let i = 1; i < data.length; i++) if (data[i] > data[peak]) peak = i;
  assert.equal(Math.floor(peak / (n * n)), 11);
});
