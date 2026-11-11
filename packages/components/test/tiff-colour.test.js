import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readTiffImage } from '../src/file-io/tiff.js';
import { InputTooLargeError } from '../src/file-io/input-limits.js';

// Fixtures from test/fixtures/make_colour_tiff_fixtures.py.
function fixture(name) {
  const bytes = readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

const ramp = (count, scale) => Array.from({ length: count }, (_, i) => i * scale);

test('an 8-bit deflate RGB image reads interleaved, declaring 300 dpi without calling it a pixel size', async () => {
  const image = await readTiffImage(fixture('colour-rgb-deflate-uint8.tif'));
  assert.equal(image.width, 5);
  assert.equal(image.height, 4);
  assert.equal(image.channels, 3);
  assert.equal(image.bitsPerSample, 8);
  assert.ok(image.data instanceof Uint8Array);
  assert.deepEqual(Array.from(image.data), ramp(60, 4));
  assert.equal(image.pixelSize, null);
  assert.deepEqual(image.declaredSpacing, { x: 1 / 300, y: 1 / 300, z: null, unit: 'inch' });
});

test('a 16-bit RGB image drops its alpha sample and declares pixels per centimetre', async () => {
  const image = await readTiffImage(fixture('colour-rgba-uint16.tif'));
  assert.equal(image.channels, 3);
  assert.equal(image.bitsPerSample, 16);
  assert.equal(image.maxValue, 65535);
  assert.ok(image.data instanceof Uint16Array);
  assert.deepEqual(Array.from(image.data), ramp(36, 1000));
  assert.equal(image.pixelSize, null);
  assert.deepEqual(image.declaredSpacing, { x: 0.002, y: 0.0025, z: null, unit: 'centimeter' });
});

test('three greyscale samples per pixel are a channel stack, refused rather than read as RGB', async () => {
  await assert.rejects(readTiffImage(fixture('colour-minisblack-3samples.tif')), /channel stack/);
});

test('palette images become RGB through their colour map and white-is-zero greyscale is inverted', async () => {
  const palette = await readTiffImage(fixture('colour-palette-uint8.tif'));
  assert.equal(palette.channels, 3);
  const first = Array.from(palette.data.subarray(0, 12));
  const expected = [0, 1, 2, 3].flatMap((i) => [i, 2 * i, 3 * i].map((v) => Math.floor(((Math.floor((v * 257) / 4)) / 65536) * 256)));
  assert.deepEqual(first, expected);
  assert.equal(palette.pixelSize, null);
  const white = await readTiffImage(fixture('colour-miniswhite-uint8.tif'));
  assert.equal(white.channels, 1);
  assert.deepEqual(Array.from(white.data), ramp(20, 10).map((v) => 255 - v));
});

test('reduced-resolution pages are skipped and a stack of full-size pages is refused', async () => {
  const image = await readTiffImage(fixture('colour-rgb-reduced.tif'));
  assert.equal(image.width, 6);
  assert.equal(image.height, 4);
  assert.deepEqual(Array.from(image.data), ramp(72, 2));
  await assert.rejects(readTiffImage(fixture('colour-rgb-two-pages.tif')), /2 full-size pages/);
});

test('an unflagged smaller TIFF page is another image, not a thumbnail', async () => {
  const bytes = fixture('colour-rgb-reduced.tif');
  const view = new DataView(bytes);
  const little = view.getUint16(0) === 0x4949;
  const first = view.getUint32(4, little);
  const second = view.getUint32(first + 2 + 12 * view.getUint16(first, little), little);
  assert.ok(second);
  let found = false;
  for (let i = 0; i < view.getUint16(second, little); i++) {
    const entry = second + 2 + 12 * i;
    if (view.getUint16(entry, little) !== 254) continue;
    view.setUint32(entry + 8, 0, little);
    found = true;
  }
  assert.ok(found);
  await assert.rejects(readTiffImage(bytes), /stack rather than one image/);
});

test('an RGB OME-TIFF reads with its OME pixel size', async () => {
  const image = await readTiffImage(fixture('colour-rgb.ome.tif'));
  assert.equal(image.metadata.kind, 'ome');
  assert.equal(image.channels, 3);
  assert.deepEqual(Array.from(image.data), ramp(60, 3));
  assert.deepEqual(image.pixelSize, { x: 2.5, y: 2.5 });
});

test('an image above the memory budget is refused before decoding', async () => {
  await assert.rejects(readTiffImage(fixture('colour-rgb-deflate-uint8.tif'), { maxBytes: 59 }), InputTooLargeError);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(readTiffImage(fixture('colour-rgb-deflate-uint8.tif'), { signal: controller.signal }), { name: 'AbortError' });
});

test('8-bit CMYK converts to RGB and 16-bit CMYK is refused before decoding', async () => {
  const eight = await readTiffImage(fixture('colour-cmyk-uint8.tif'));
  assert.equal(eight.channels, 3);
  const [red, green, black] = [0, 1, 2].map((i) => Array.from(eight.data.subarray(3 * i, 3 * i + 3)));
  assert.ok(red[0] > 250 && red[1] === 0 && red[2] === 0, `red ${red}`);
  assert.ok(green[1] > 250 && green[0] === 0 && green[2] === 0, `green ${green}`);
  assert.deepEqual(black, [0, 0, 0]);
  await assert.rejects(readTiffImage(fixture('colour-cmyk-uint16.tif')), /16-bit CMYK TIFF cannot be converted/);
});
