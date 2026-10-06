import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { createUint8Nifti } from '@neurodesk/webapp-components/file-io';
import { editableLabelNames, editedSegmentation, findEditTarget } from '../web/js/app/segmentation-edit.js';
import { getLabelsForLabelSpace } from '../web/js/app/labels.js';

function labelMap(name, dims, { gzip = false, shift = 0, spacing = 1 } = {}) {
  const header = new ArrayBuffer(352);
  const view = new DataView(header);
  view.setInt32(0, 348, true);
  [3, ...dims, 1, 1, 1, 1].forEach((value, index) => view.setInt16(40 + index * 2, value, true));
  view.setFloat32(108, 352, true);
  view.setInt16(254, 1, true);
  view.setFloat32(280, spacing, true);
  view.setFloat32(292, shift, true);
  view.setFloat32(300, 1, true);
  view.setFloat32(320, 1, true);
  const bytes = new Uint8Array(createUint8Nifti(new Uint8Array(dims[0] * dims[1] * dims[2]), header));
  return new File([gzip ? gzipSync(bytes) : bytes], name);
}

test('a display map on the segmentation grid is the edit target', async () => {
  const file = labelMap('t1_segmentation.nii', [8, 8, 4]);
  const displayFile = labelMap('t1_segmentation_display.nii', [8, 8, 4]);
  assert.equal(await findEditTarget({ file, displayFile, labelEncoding: 'sparse' }), displayFile);
});

test('a display map resampled for the viewer cannot be edited', async () => {
  const file = labelMap('consolidated_segmentation.nii', [8, 8, 200]);
  const displayFile = labelMap('consolidated_segmentation_display.nii', [5, 5, 128]);
  assert.equal(await findEditTarget({ file, displayFile, labelEncoding: 'sparse' }), null);
});

test('without a display map only a class-index file is editable', async () => {
  const file = labelMap('mask.nii.gz', [4, 4, 4], { gzip: true });
  assert.equal(await findEditTarget({ file, displayFile: null, labelEncoding: 'class-index' }), file);
  assert.equal(await findEditTarget({ file, displayFile: null, labelEncoding: 'sparse' }), null);
});

test('gzipped maps are compared by their decoded grid', async () => {
  const file = labelMap('a.nii.gz', [6, 6, 3], { gzip: true });
  const displayFile = labelMap('a_display.nii.gz', [6, 6, 3], { gzip: true });
  assert.equal(await findEditTarget({ file, displayFile, labelEncoding: 'sparse' }), displayFile);
});

test('an applied edit replaces the downloaded file under its name and marks the result edited', async () => {
  const original = labelMap('t1_segmentation_display.nii', [4, 4, 4]);
  const source = { file: labelMap('t1_segmentation.nii', [4, 4, 4]), displayFile: original, labelEncoding: 'sparse' };
  const edited = new File([new Uint8Array([1, 2, 3])], 't1_segmentation_display.nii');
  const patch = editedSegmentation(source, edited, original);
  assert.equal(patch.file.name, 't1_segmentation.nii');
  assert.deepEqual(new Uint8Array(await patch.file.arrayBuffer()), new Uint8Array([1, 2, 3]));
  assert.equal(patch.displayFile, edited);
  assert.equal(patch.editFile, edited);
  assert.equal(patch.labelEncoding, 'class-index');
  assert.equal(patch.edited, true);
  assert.equal(patch.original, original);
});

test('editing an edited result keeps the pipeline original', () => {
  const pipeline = labelMap('t1_segmentation_display.nii', [4, 4, 4]);
  const firstEdit = new File([new Uint8Array([1])], 't1_segmentation_display.nii');
  const source = { file: new File([firstEdit], 't1_segmentation.nii'), original: pipeline };
  const patch = editedSegmentation(source, new File([new Uint8Array([2])], 'x.nii'), firstEdit);
  assert.equal(patch.original, pipeline);
});

test('label names map class indices to the label space names', () => {
  const names = editableLabelNames(getLabelsForLabelSpace('musclemap-wholebody-v1.4'));
  assert.equal(names[1], 'Levator Scapulae L');
  assert.equal(names[0], undefined);
  assert.equal(Object.keys(names).length, 113);
  assert.deepEqual(editableLabelNames(null), {});
});

for (const geometry of [{ shift: 20 }, { spacing: 2 }]) {
  test(`a display map with different geometry ${JSON.stringify(geometry)} cannot be edited`, async () => {
    const file = labelMap('full.nii', [8, 8, 4]);
    const displayFile = labelMap('display.nii', [8, 8, 4], geometry);
    assert.equal(await findEditTarget({ file, displayFile, labelEncoding: 'sparse' }), null);
  });
}
