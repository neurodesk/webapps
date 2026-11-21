import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syntheticNifti } from '../../../test-utils/nifti-fixture.mjs';
import { loadRegistration } from '@neurodesk/registration/node';
import { Files } from '../src/files.js';
import { antsDrivers } from '../src/drivers.js';

// The kernel is deterministic (one thread, fixed seed), so the drivers, given the SYNcro core's argv, must give
// exactly the bytes of the registration package's own register() and apply() on the same images.
test('ANTs drivers reproduce the kernel byte for byte from the core argv', async () => {
  const blob = (cx, cy) => syntheticNifti({
    dims: [16, 16, 16],
    value: (i) => 100 * Math.exp(-((i % 16 - cx) ** 2 + (Math.floor(i / 16) % 16 - cy) ** 2 + (Math.floor(i / 256) - 8) ** 2) / 20),
    gzip: false,
  });
  const [fixed, moving] = [blob(7, 6), blob(8, 7)];
  const reference = await loadRegistration();
  const registered = reference.register({ fixed, moving });
  const applied = reference.apply({ registration: registered, moving, interpolation: 'linear', fill: 0 });

  const files = new Files();
  files.put('work/template.nii', fixed);
  files.put('work/brain-f32.nii', moving);
  const engine = await loadRegistration();
  const { antsRegistration, antsApplyTransforms } = antsDrivers(async () => engine);
  const [f, m] = ['work/template.nii', 'work/brain-f32.nii'];
  const argv = ['antsRegistration', '--dimensionality', '3', '--float', '1', '--random-seed', '42', '-r', `[${f},${m},1]`,
    '--metric', `mattes[${f},${m},1,32,regular,0.2]`, '--transform', 'Affine[0.25]', '--convergence', '2100x1200x1200x0',
    '--smoothing-sigmas', '3x2x1x0', '--shrink-factors', '4x2x2x1', '--metric', `mattes[${f},${m},1,32]`,
    '--transform', 'SyN[0.2,3,0]', '--convergence', '[40x20x0,1e-7,8]', '--smoothing-sigmas', '2x1x0', '--shrink-factors', '4x2x1',
    '-u', '0', '-z', '1', '--output', '[work/ants-,work/ants-brain.nii.gz]', '--verbose', '1'];
  assert.equal((await antsRegistration(argv, { files })).code, 0);
  for (const name of ['0GenericAffine.mat', '1Warp.nii.gz', '1InverseWarp.nii.gz']) {
    assert.deepEqual(await files.bytes(`work/ants-${name}`), registered.transforms[name], name);
  }
  assert.deepEqual(await files.bytes('work/ants-brain.nii.gz'), registered.warped);
  const apply = ['antsApplyTransforms', '-d', '3', '--float', '1', '-i', m, '-r', f, '-o', 'wbrain.nii.gz', '-n', 'Linear', '-f', '0',
    '-t', 'work/ants-1Warp.nii.gz', '-t', 'work/ants-0GenericAffine.mat'];
  assert.equal((await antsApplyTransforms(apply, { files })).code, 0);
  assert.deepEqual(await files.bytes('wbrain.nii.gz'), applied);
});
