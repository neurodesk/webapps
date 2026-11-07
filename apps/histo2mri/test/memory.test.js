import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_WORKING_BYTES, preflightSection, registerSection, workingMemory } from '../src/core/register.js';
import { slicePlane } from '../src/core/plane.js';
import { phantomSlice, phantomVolume } from './helpers.js';

// Pixel arrays that throw when read: a refusal must come before the pipeline touches them.
const untouchable = new Proxy({}, { get: (_target, key) => { throw new Error(`pixel data read (${String(key)})`); } });
const greedy = { rigid: () => assert.fail('Greedy ran'), affine: () => assert.fail('Greedy ran'), svf: () => assert.fail('Greedy ran') };

test('a 12,000² RGB section at the MRI\'s own pixel size is refused before any image is allocated', async () => {
  const volume = phantomVolume(120, 100, 5, () => phantomSlice(120, 100));
  const section = { width: 12000, height: 12000, channels: 3, maxValue: 255, data: untouchable, pixelSize: null };
  // 0.6 mm pixels: the working image keeps every section pixel (block size 1).
  const options = { pixelSize: 600 };
  const plane = slicePlane(volume, { axis: 2, index: 2 });
  assert.ok(workingMemory(plane, section, 0.6) > 5 * 1024 ** 3);
  assert.throws(() => preflightSection({ volume, section, plane: { axis: 2, index: 2 }, options }), /needs about \d+ MB of working memory, above the 2048 MB limit \(MRI plane 120 × 100 pixels of 0.6 mm, section 12000 × 12000 pixels at 600 µm per pixel\)/);
  await assert.rejects(registerSection({ volume, section, plane: { axis: 2, index: 2 }, options, greedy }), /working memory/);
});

test('a tiny anisotropic MRI whose plane grid would hold 100 million pixels is refused before sampling it', async () => {
  // 0.001 × 1 × 1 mm voxels: the plane takes the 0.001 mm spacing across the 1 mm axis too.
  const volume = { dims: [64, 400, 3], affine: [[0.001, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]], data: untouchable };
  const plane = slicePlane(volume, { axis: 2, index: 1 });
  assert.equal(plane.nu * plane.nv, 64 * 400000);
  const section = { width: 100, height: 100, channels: 3, maxValue: 255, data: untouchable, pixelSize: null };
  assert.throws(() => preflightSection({ volume, section, plane: { axis: 2, index: 1 } }), /MRI plane 64 × 400000 pixels/);
  await assert.rejects(registerSection({ volume, section, plane: { axis: 2, index: 1 }, greedy }), /working memory/);
});

test('ordinary inputs fit and the limit can be lowered', () => {
  const volume = phantomVolume(120, 100, 5, () => phantomSlice(120, 100));
  const plane = slicePlane(volume, { axis: 2, index: 2 });
  const image = phantomSlice(300, 250);
  const data = new Uint8Array(300 * 250 * 3);
  for (let i = 0; i < image.length; i++) data.fill(255 - Math.round(image[i] / 4), 3 * i, 3 * i + 3);
  const section = { width: 300, height: 250, channels: 3, maxValue: 255, data, pixelSize: null };
  assert.ok(workingMemory(plane, section, 0.24) < 64 * 1024 ** 2);
  assert.ok(MAX_WORKING_BYTES >= 1024 ** 3);
  preflightSection({ volume, section, plane: { axis: 2, index: 2 } });
  assert.throws(() => preflightSection({ volume, section, plane: { axis: 2, index: 2 }, maxBytes: 1024 }), /working memory/);
});
