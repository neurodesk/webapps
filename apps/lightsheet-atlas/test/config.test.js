import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EXAMPLE_SETTINGS, outputNames, runSettings } from '../src/config.js';

const examples = JSON.parse(readFileSync(new URL('../examples.json', import.meta.url)));

test('every example has its orientation and steps', () => {
  assert.deepEqual(Object.keys(EXAMPLE_SETTINGS).sort(), examples.map((e) => e.id).sort());
});

test('form values become run settings, and errors name their field', () => {
  const settings = runSettings({ voxelSizeUm: ['5', '2', '2'], orientation: ' ASR ', register: false, detect: true });
  assert.deepEqual(settings.voxelSizeUm, [5, 2, 2]);
  assert.equal(settings.orientation, 'asr');
  const field = (values) => {
    try {
      runSettings(values);
    } catch (error) {
      return error.field;
    }
    return null;
  };
  assert.equal(field({ voxelSizeUm: ['', 2, 2], orientation: 'asr', register: true, detect: false }), 'voxelZ');
  assert.equal(field({ voxelSizeUm: [5, 2, 2], orientation: 'ass', register: true, detect: false }), 'orientation');
  assert.equal(field({ voxelSizeUm: [5, 2, 2], orientation: 'asr', register: false, detect: false }), 'register');
  assert.equal(field({ voxelSizeUm: [50, 40, 40], orientation: 'asr', register: true, detect: true }), 'detect');
  assert.equal(field({ voxelSizeUm: [5, 2, 2], orientation: 'asr', register: false, detect: true, detection: { ballOverlapFraction: 2 } }), 'ballOverlapFraction');
});

test('outputs are named after the input', () => {
  assert.equal(outputNames('cellfinder-crop.ome.tif').candidates, 'cellfinder-crop_candidates.csv');
  assert.equal(outputNames('cellfinder-crop.ome.tif').marks, 'cellfinder-crop_candidates.nii.gz');
  assert.equal(outputNames('my brain.zarr').registeredAtlas, 'my_brain_registered-atlas.nii.gz');
});
