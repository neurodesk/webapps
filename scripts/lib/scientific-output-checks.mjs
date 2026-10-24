import assert from 'node:assert/strict';
import { decodeNiftiBuffer, readNiftiFrames } from '../../packages/components/src/file-io/NiftiUtils.js';

export async function inspectScientificImage(bytes, type = 'neuro:volume') {
  const image = readNiftiFrames(await decodeNiftiBuffer(bytes));
  assert.ok(image.data.every(Number.isFinite), 'Every image frame has finite voxel values');
  assert.ok(image.data.some(value => value > 0), 'The image contains nonempty scientific output');
  if (type === 'neuro:mask') assert.ok(image.data.every(value => value === 0 || value === 1), 'The brain mask is binary');
  if (type === 'neuro:label-map') {
    assert.ok(image.data.every(Number.isInteger), 'Segmentation labels are integers');
    assert.ok(new Set(image.data).size > 2, 'Segmentation contains multiple tissue labels');
  }
  return { dims: image.dims, frames: image.frames ?? 1, voxels: image.data.length };
}
