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
  assert.equal(imagej.unlabelledStack, false);
  assert.equal(parseImagejDescription('ImageJ=1.53t\nimages=30\nslices=30\n').unlabelledStack, true);
  assert.equal(parseImagejDescription('ImageJ=1.53t\nimages=30\nslices=30\nhyperstack=true\n').unlabelledStack, false);
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

test('OME attributes are read in either quote form, with XML entities decoded', () => {
  const xml = "<?xml version='1.0'?><ome:OME xmlns:ome='http://www.openmicroscopy.org/Schemas/OME/2016-06'><ome:Image ID='Image:0' Name='a &quot;b&quot;'><ome:Pixels DimensionOrder='XYZCT' SizeC='1' SizeT='12' SizeZ=\"1\" PhysicalSizeX='0.5' PhysicalSizeXUnit='&#181;m' PhysicalSizeY=\"400\" PhysicalSizeYUnit=\"n&#x6D;\" TimeIncrement='50' TimeIncrementUnit='&#x6d;s' Type='uint16'/></ome:Image></ome:OME>";
  const ome = parseOmeDescription(xml);
  assert.equal(ome.sizeT, 12);
  assert.equal(ome.sizeZ, 1);
  assert.equal(ome.dimensionOrder, 'XYZCT');
  assert.equal(ome.pixelSize.x, 0.5);
  assert.ok(Math.abs(ome.pixelSize.y - 0.4) < 1e-12);
  assert.ok(Math.abs(ome.frameInterval - 0.05) < 1e-12);
  // An entity-encoded unit that names nothing known stays unknown rather than defaulting to µm.
  assert.equal(parseOmeDescription(xml.replace("'&#181;m'", "'&amp;m'")).pixelSize.x, null);
});

test('an OME-TIFF with two Image series is refused before decoding', async () => {
  await assert.rejects(inspectTiffStack(fixture('two-series.ome.tif')), /2 image series/);
  await assert.rejects(readTiffStack(fixture('two-series.ome.tif')), /2 image series/);
});

test('an ImageJ description whose images= disagrees with the page count is refused', async () => {
  const data = new Uint8Array(4 * 3);
  const bytes = writeTiffStack({ width: 2, height: 2, data, description: 'ImageJ=1.11a\nimages=5\nframes=5\n' });
  await assert.rejects(readTiffStack(buffer(bytes)), /declares 5 images but holds 3 pages/);
  const matching = writeTiffStack({ width: 2, height: 2, data, description: imagejDescription({ frames: 3 }) });
  assert.equal((await readTiffStack(buffer(matching))).pages, 3);
});

// Each short description was also read back with Python tifffile 2026.3.3 once
// (TiffFile(...).pages[0].description), which returned the same string for all five.
for (const description of ['', 'a', 'ab', 'abc', 'abcd']) {
  test(`writeTiffStack stores the ${description.length}-character description ${JSON.stringify(description)} where readers find it`, async () => {
    const bytes = writeTiffStack({ width: 3, height: 2, data: Uint16Array.from({ length: 12 }, (_, i) => i), description });
    const view = new DataView(bytes.buffer);
    const ifd = view.getUint32(4, true);
    const entries = view.getUint16(ifd, true);
    const entry = Array.from({ length: entries }, (_, k) => ifd + 2 + k * 12).find((at) => view.getUint16(at, true) === 270);
    if (!description) {
      assert.equal(entry, undefined);
    } else {
      assert.equal(view.getUint32(entry + 4, true), description.length + 1);
      // Four bytes or fewer, NUL included: the value sits in the entry, not at an offset.
      if (description.length + 1 <= 4) assert.deepEqual(Array.from(bytes.subarray(entry + 8, entry + 8 + description.length + 1)), [...new TextEncoder().encode(description), 0]);
      else assert.equal(new TextDecoder().decode(bytes.subarray(view.getUint32(entry + 8, true), view.getUint32(entry + 8, true) + description.length)), description);
    }
    const stack = await readTiffStack(buffer(bytes));
    assert.equal(stack.metadata.description, description);
    assert.equal(stack.pages, 2);
    assert.deepEqual(Array.from(stack.data), Array.from({ length: 12 }, (_, i) => i));
  });
}

test('readTiffStack decodes into a caller-chosen type, optionally shared, with maxBytes on that output', async () => {
  const floats = await readTiffStack(fixture('stack-deflate-uint16.ome.tif'), { Type: Float32Array });
  assert.ok(floats.data instanceof Float32Array);
  assert.ok(floats.data.buffer instanceof ArrayBuffer);
  assert.equal(floats.dtype, 'uint16');
  assert.deepEqual(Array.from(floats.data), Array.from({ length: 60 }, (_, i) => i * 997));
  const shared = await readTiffStack(fixture('stack-deflate-uint16.ome.tif'), { Type: Float32Array, shared: true });
  assert.ok(shared.data.buffer instanceof SharedArrayBuffer);
  assert.deepEqual(Array.from(shared.data), Array.from(floats.data));
  // 60 uint16 samples are 120 bytes in the file's type but 240 as float32.
  await assert.doesNotReject(readTiffStack(fixture('stack-deflate-uint16.ome.tif'), { maxBytes: 120 }));
  await assert.rejects(readTiffStack(fixture('stack-deflate-uint16.ome.tif'), { Type: Float32Array, maxBytes: 239 }), InputTooLargeError);
  await assert.rejects(readTiffStack(fixture('stack-deflate-uint16.ome.tif'), { Type: Array }), /Cannot read a TIFF stack into Array/);
});

test('OME stage positions are read in micrometres from the first plane, TheZ 0', () => {
  const xml = `<?xml version="1.0"?><ome:OME xmlns:ome="http://www.openmicroscopy.org/Schemas/OME/2016-06"><ome:Image ID='Image:0' Name="tile &amp; 1"><ome:Pixels ID='Pixels:0' DimensionOrder='XYZCT' SizeX='4' SizeY='3' SizeZ='2' SizeC='1' SizeT='1' PhysicalSizeX='650' PhysicalSizeXUnit='nm' PhysicalSizeY="0.65"><ome:Plane TheZ='1' TheC='0' TheT='0' PositionX='9' PositionY='9'/><ome:Plane TheZ="0" TheC="0" TheT="0" PositionX='1520.5' PositionXUnit='µm' PositionY="-2.5" PositionYUnit="mm" PositionZ='3000' PositionZUnit='nm'/></ome:Pixels></ome:Image></ome:OME>`;
  const metadata = parseOmeDescription(xml);
  assert.equal(metadata.sizeZ, 2);
  assert.deepEqual(metadata.pixelSize, { x: 0.65, y: 0.65, z: null });
  assert.deepEqual(metadata.stagePosition, { x: 1520.5, y: -2500, z: 3 });
});

test('a position recorded only at a later z plane is not the stack origin', () => {
  // Two tiles whose stage origins differ, one recording its position at Z = 0 and the other
  // only at Z = 1: taking any plane would give both the same origin.
  const tile = (planes) => `<OME><Image ID="Image:0"><Pixels SizeX="2" SizeY="2" SizeZ="2" SizeC="1" SizeT="1">${planes}</Pixels></Image></OME>`;
  assert.deepEqual(parseOmeDescription(tile('<Plane TheZ="0" TheC="0" TheT="0" PositionX="100" PositionY="5" PositionZ="0"/>')).stagePosition, { x: 100, y: 5, z: 0 });
  assert.equal(parseOmeDescription(tile('<Plane TheZ="0" TheC="0" TheT="0"/><Plane TheZ="1" TheC="0" TheT="0" PositionX="100" PositionY="5" PositionZ="2"/>')).stagePosition, null);
  // Absent indices are 0, the OME default.
  assert.deepEqual(parseOmeDescription(tile('<Plane PositionX="7" PositionY="8"/>')).stagePosition, { x: 7, y: 8, z: null });
});

test('another image\'s stage position is never assigned to the first image', () => {
  const xml = '<OME><Image ID="Image:0"><Pixels SizeX="2" SizeY="2" SizeZ="1" SizeC="1" SizeT="1"><Plane TheZ="0" TheC="0" TheT="0"/></Pixels></Image><Image ID="Image:1"><Pixels SizeX="2" SizeY="2" SizeZ="1" SizeC="1" SizeT="1"><Plane TheZ="0" TheC="0" TheT="0" PositionX="40" PositionY="50"/></Pixels></Image></OME>';
  const metadata = parseOmeDescription(xml);
  assert.equal(metadata.images, 2);
  assert.equal(metadata.stagePosition, null);
  const selfClosing = '<OME><Image ID="Image:0"><Pixels SizeX="2" SizeY="2" SizeZ="1" SizeC="1" SizeT="1"/></Image><Image ID="Image:1"><Pixels SizeX="2" SizeY="2"><Plane PositionX="40" PositionY="50"/></Pixels></Image></OME>';
  assert.equal(parseOmeDescription(selfClosing).stagePosition, null);
});

test('an OME description without plane positions has no stage position, and other kinds record null', () => {
  const xml = '<OME><Image ID="Image:0"><Pixels SizeX="2" SizeY="2" SizeZ="1" SizeC="1" SizeT="1"><Plane TheZ="0" PositionX="1"/></Pixels></Image></OME>';
  assert.equal(parseOmeDescription(xml).stagePosition, null);
  assert.equal(parseImagejDescription('ImageJ=1.54f\nimages=1\n').stagePosition, null);
});

test('inspectTiffStack reads a File range by range, only its page directories and description', async () => {
  const bytes = fixture('stack-deflate-uint16.ome.tif');
  const ranges = [];
  class HeaderOnlyFile extends File {
    slice(start, end, type) {
      ranges.push([start, end]);
      return super.slice(start, end, type);
    }
    arrayBuffer() {
      throw new Error('the whole file was read');
    }
  }
  const info = await inspectTiffStack(new HeaderOnlyFile([bytes], 'stack.ome.tif'));
  assert.deepEqual(info, await inspectTiffStack(bytes));
  assert.ok(ranges.length > 0);
});

test('rgb: mean reads RGB pages as the mean of their three samples, as ImageJ converts RGB to 8-bit', async () => {
  const rgb = Uint8Array.from({ length: 2 * 3 * 2 * 3 }, (_, i) => (i * 37) % 256);
  const bytes = buffer(writeTiffStack({ width: 3, height: 2, data: rgb, rgb: true, pixelSize: { x: 0.5, y: 0.5 }, description: 'ImageJ=1.11a\nimages=2\nslices=2\nunit=micron\n' }));
  await assert.rejects(readTiffStack(bytes), /3 samples per pixel \(RGB\)/);
  const info = await inspectTiffStack(bytes, { rgb: 'mean' });
  assert.deepEqual([info.width, info.height, info.pages, info.dtype, info.samplesPerPixel], [3, 2, 2, 'uint8', 3]);
  const stack = await readTiffStack(bytes, { rgb: 'mean', Type: Float64Array });
  assert.deepEqual(Array.from(stack.data), Array.from({ length: 12 }, (_, i) => (rgb[3 * i] + rgb[3 * i + 1] + rgb[3 * i + 2]) / 3));
  assert.equal(stack.metadata.pixelSize.x, 0.5);
  const fromTifffile = await readTiffStack(fixture('rgb-uint8.tif'), { rgb: 'mean', Type: Float32Array });
  assert.equal(fromTifffile.dtype, 'uint8');
});

test('writeTiffStack refuses RGB data that is not Uint8Array triplets', () => {
  assert.throws(() => writeTiffStack({ width: 2, height: 2, data: new Float32Array(12), rgb: true }), /Uint8Array/);
  assert.throws(() => writeTiffStack({ width: 2, height: 2, data: new Uint8Array(4), rgb: true }), /whole number/);
});
