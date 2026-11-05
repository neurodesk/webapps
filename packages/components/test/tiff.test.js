import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  imagejDescription,
  inspectTiffStack,
  micrometresPerUnit,
  parseImagejDescription,
  parseOmeDescription,
  readTiffStack,
  writeTiffStack,
} from '../src/file-io/tiff.js';
import { InputTooLargeError } from '../src/file-io/input-limits.js';

// Fixtures from test/fixtures/make_tiff_fixtures.py (tifffile 2026.3.3, imagecodecs 2026.3.6).
function fixture(name) {
  const bytes = readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function buffer(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

test('a deflate-compressed OME-TIFF reads every page with its time increment and pixel size', async () => {
  const stack = await readTiffStack(fixture('stack-deflate-uint16.ome.tif'));
  assert.equal(stack.width, 5);
  assert.equal(stack.height, 4);
  assert.equal(stack.pages, 3);
  assert.equal(stack.dtype, 'uint16');
  assert.ok(stack.data instanceof Uint16Array);
  assert.deepEqual(Array.from(stack.data), Array.from({ length: 60 }, (_, i) => i * 997));
  assert.equal(stack.metadata.kind, 'ome');
  assert.equal(stack.metadata.sizeT, 3);
  assert.equal(stack.metadata.frameInterval, 0.25);
  assert.deepEqual(stack.metadata.pixelSize, { x: 0.5, y: 0.75, z: null });
});

test('LZW int16 and ImageJ float32 stacks keep their sample type and values', async () => {
  const signed = await readTiffStack(fixture('stack-lzw-int16.tif'));
  assert.ok(signed.data instanceof Int16Array);
  assert.deepEqual(Array.from(signed.data), Array.from({ length: 60 }, (_, i) => (i - 30) * 101));
  assert.equal(signed.metadata.kind, 'baseline');
  const floats = await readTiffStack(fixture('stack-imagej-float32.tif'));
  assert.ok(floats.data instanceof Float32Array);
  assert.deepEqual(Array.from(floats.data), Array.from({ length: 60 }, (_, i) => Math.fround(i / 7)));
  assert.equal(floats.metadata.kind, 'imagej');
  assert.equal(floats.metadata.sizeT, 3);
  assert.equal(floats.metadata.frameInterval, 0.5);
  assert.ok(Math.abs(floats.metadata.pixelSize.x - 0.8) < 1e-6);
});

test('multi-sample pages are refused with what they hold, before any pixel is read', async () => {
  await assert.rejects(readTiffStack(fixture('rgb-uint8.tif')), /3 samples per pixel \(RGB\)/);
  await assert.rejects(inspectTiffStack(fixture('rgb-uint8.tif')), /one greyscale channel/);
});

test('a stack above the memory budget is refused from its page directories', async () => {
  const info = await inspectTiffStack(fixture('stack-deflate-uint16.ome.tif'));
  assert.equal(info.pages * info.width * info.height * info.bytesPerSample, 120);
  await assert.rejects(readTiffStack(fixture('stack-deflate-uint16.ome.tif'), { maxBytes: 119 }), InputTooLargeError);
});

test('reading stops when its signal aborts', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(readTiffStack(fixture('stack-deflate-uint16.ome.tif'), { signal: controller.signal }), { name: 'AbortError' });
});

test('OME-XML is recognised whatever its namespace prefix, with units converted to µm and s', () => {
  const prefixed = '<?xml version="1.0"?><ome:OME xmlns:ome="http://www.openmicroscopy.org/Schemas/OME/2016-06"><ome:Image ID="Image:0"><ome:Pixels DimensionOrder="XYZCT" SizeC="2" SizeT="40" SizeZ="1" PhysicalSizeX="400" PhysicalSizeXUnit="nm" PhysicalSizeY="0.4" TimeIncrement="33" TimeIncrementUnit="ms" Type="uint16"/></ome:Image></ome:OME>';
  const ome = parseOmeDescription(prefixed);
  assert.equal(ome.kind, 'ome');
  assert.equal(ome.sizeC, 2);
  assert.equal(ome.sizeT, 40);
  assert.equal(ome.images, 1);
  assert.ok(Math.abs(ome.pixelSize.x - 0.4) < 1e-12);
  assert.equal(ome.pixelSize.y, 0.4);
  assert.ok(Math.abs(ome.frameInterval - 0.033) < 1e-12);
  assert.equal(parseOmeDescription('ImageJ=1.53t\nimages=3'), null);
});

test('ImageJ descriptions give frames, interval from finterval or fps, and calibrated pixels', () => {
  const imagej = parseImagejDescription('ImageJ=1.53t\nimages=30\nframes=30\nfps=15\nunit=micron\n', [2, 4]);
  assert.equal(imagej.sizeT, 30);
  assert.ok(Math.abs(imagej.frameInterval - 1 / 15) < 1e-12);
  assert.deepEqual(imagej.pixelSize, { x: 0.5, y: 0.25, z: null });
  assert.equal(micrometresPerUnit('\\u00B5m'), 1);
  assert.equal(micrometresPerUnit('μm'), 1);
  assert.equal(micrometresPerUnit('pixel'), null);
});

for (const Type of [Uint8Array, Uint16Array, Int16Array, Int32Array, Float32Array, Float64Array]) {
  test(`writeTiffStack round-trips a ${Type.name} stack with its ImageJ metadata`, async () => {
    const width = 7;
    const height = 3;
    const pages = 4;
    const data = Type.from({ length: width * height * pages }, (_, i) => (Type === Float32Array || Type === Float64Array ? i / 3 - 5 : (i * 37) % 251));
    const description = imagejDescription({ frames: pages, frameInterval: 0.125, unit: 'micron' });
    const bytes = writeTiffStack({ width, height, data, description, pixelSize: { x: 0.5, y: 0.25 } });
    const stack = await readTiffStack(buffer(bytes));
    assert.equal(stack.pages, pages);
    assert.equal(stack.width, width);
    assert.equal(stack.height, height);
    assert.ok(stack.data instanceof Type);
    assert.deepEqual(Array.from(stack.data), Array.from(data));
    assert.equal(stack.metadata.kind, 'imagej');
    assert.equal(stack.metadata.sizeT, pages);
    assert.equal(stack.metadata.frameInterval, 0.125);
    assert.deepEqual(stack.metadata.pixelSize, { x: 0.5, y: 0.25, z: null });
  });
}

test('writeTiffStack refuses data that is not whole pages', () => {
  assert.throws(() => writeTiffStack({ width: 4, height: 4, data: new Uint16Array(20) }), /whole number/);
  assert.throws(() => writeTiffStack({ width: 2, height: 2, data: [1, 2, 3, 4] }), /Cannot write/);
});
