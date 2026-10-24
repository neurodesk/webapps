import test from 'node:test';
import assert from 'node:assert/strict';
import { imageFiles } from '../src/automation/image-files.js';

const file = (name, value) => new File([value], name);

test('explicit roles pair independent filenames and replace converted sidecars without changing bytes', async () => {
  const files = imageFiles({
    image: [file('scan.nii.gz', 'image')],
    sidecar: [file('earlier_step.json', '{"PhaseEncodingDirection":"j-"}')],
    bval: [file('values.bvals', '0 1000')],
  }, { image: { sidecars: [file('scan.json', '{"PhaseEncodingDirection":"i"}'), file('scan.bvec', '1 0 0')] } });
  assert.deepEqual(await Promise.all(files.map(async file => [file.name, await file.text()])), [
    ['scan.nii.gz', 'image'], ['scan.bvec', '1 0 0'],
    ['scan.json', '{"PhaseEncodingDirection":"j-"}'], ['scan.bval', '0 1000'],
  ]);
});

test('distinct image roles can have identical names without mixing their metadata', async () => {
  const inputs = { image1: [file('scan.nii', 'one')], image2: [file('scan.nii', 'two')],
    sidecar1: [file('scan.json', '{"PhaseEncodingDirection":"j"}')], sidecar2: [file('scan.json', '{"PhaseEncodingDirection":"j-"}')] };
  const files = [1, 2].flatMap(index => imageFiles(inputs, {}, {
    image: `image${index}`, sidecar: `sidecar${index}`, bval: null, bvec: null, name: `image${index}_scan.nii`,
  }));
  assert.deepEqual(await Promise.all(files.map(async file => [file.name, await file.text()])), [
    ['image1_scan.nii', 'one'], ['image1_scan.json', '{"PhaseEncodingDirection":"j"}'],
    ['image2_scan.nii', 'two'], ['image2_scan.json', '{"PhaseEncodingDirection":"j-"}'],
  ]);
  assert.throws(() => imageFiles({ image: inputs.image1.concat(inputs.image2), sidecar: inputs.sidecar1 }), /exactly one image/);
  assert.throws(() => imageFiles({ sidecar: inputs.sidecar1 }), /exactly one image/);
});
