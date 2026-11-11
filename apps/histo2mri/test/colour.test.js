import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rgbToHed, toContrast } from '../src/core/colour.js';

// scikit-image 0.24.0 skimage.color.rgb2hed on these 8-bit pixels (the reference implementation
// of Ruifrok & Johnston's vectors this module follows).
const SKIMAGE = [
  [[255, 255, 255], [0, 0, 0]],
  [[0, 0, 0], [1.21016731119, 0, 0.881950455136]],
  [[120, 60, 160], [0.075253387213, 0.0476556414456, 0.00855268817806]],
  [[200, 150, 190], [0.017673696762, 0.0156310900228, 0.0185294503633]],
  [[90, 40, 20], [0.0218284611858, 0, 0.229843858104]],
  [[250, 10, 128], [0, 0.240595862132, 0.0459371504367]],
  [[1, 2, 3], [0.53655655993, 0, 0.235408836431]],
];

test('colour deconvolution reproduces scikit-image rgb2hed', () => {
  for (const [rgb, expected] of SKIMAGE) {
    const hed = rgbToHed(...rgb.map((value) => value / 255));
    hed.forEach((value, stain) => assert.ok(Math.abs(value - expected[stain]) < 1e-9, `${rgb} stain ${stain}: ${value} vs ${expected[stain]}`));
  }
});

test('the stain contrasts are rgbToHed per pixel', () => {
  const planes = [0, 1, 2].map((c) => Float32Array.from(SKIMAGE, ([rgb]) => rgb[c] / 255));
  for (const [stain, method] of ['haematoxylin', 'eosin', 'dab'].entries()) {
    const { data } = toContrast(planes, SKIMAGE.length, 1, method);
    SKIMAGE.forEach(([rgb], i) => assert.ok(Math.abs(data[i] - rgbToHed(...planes.map((p) => p[i]))[stain]) < 1e-6, `${method} ${rgb}`));
  }
  assert.throws(() => toContrast([planes[0]], SKIMAGE.length, 1, 'haematoxylin'), /needs an RGB image/);
});

test('brightness is inverted for a bright (brightfield) background and kept for a dark one', () => {
  const size = 20;
  const grey = (inside, outside) => {
    const plane = new Float32Array(size * size);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) plane[y * size + x] = x > 4 && x < 15 && y > 4 && y < 15 ? inside : outside;
    return [plane, plane, plane];
  };
  const brightfield = toContrast(grey(0.3, 0.95), size, size);
  assert.equal(brightfield.inverted, true);
  assert.ok(Math.abs(brightfield.data[0] - 0.05) < 1e-6);
  assert.ok(Math.abs(brightfield.data[10 * size + 10] - 0.7) < 1e-6);
  const darkfield = toContrast(grey(0.7, 0.05), size, size);
  assert.equal(darkfield.inverted, false);
  assert.ok(Math.abs(darkfield.data[10 * size + 10] - 0.7) < 1e-6);
});
