import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSegmentationResult } from '../src/segmentation.ts';

test('segmentation worker boundary rejects empty images, unknown backends and invalid timings', () => {
  const valid = { kind: 'labels', mask: new ArrayBuffer(352), image: new ArrayBuffer(352), backend: 'cpu', elapsedMs: 12 };
  for (const value of [null, {}, { ...valid, image: new ArrayBuffer(0) }, { ...valid, image: 'nifti' }, { ...valid, backend: 'guess' }, { ...valid, elapsedMs: NaN }, { ...valid, elapsedMs: -1 }]) {
    assert.throws(() => parseSegmentationResult(value));
  }
  assert.deepEqual(parseSegmentationResult(valid), valid);
});

test('PVE result requires all three tissue volumes and its independent brain mask', () => {
  const image = new ArrayBuffer(352);
  const valid = { kind: 'pve', tissues: { csf: image, gm: image, wm: image }, mask: image, backend: 'cpu', elapsedMs: 10 };
  assert.deepEqual(parseSegmentationResult(valid), valid);
  for (const value of [{ ...valid, mask: undefined }, { ...valid, tissues: { csf: image, gm: image } }, { ...valid, tissues: { ...valid.tissues, wm: new ArrayBuffer(0) } }]) {
    assert.throws(() => parseSegmentationResult(value));
  }
});
