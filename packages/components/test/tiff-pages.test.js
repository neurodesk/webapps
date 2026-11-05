import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { InputTooLargeError } from '../src/file-io/input-limits.js';
import { omeXml, openTiffPages, parseOmeDescription, sampleRoles } from '../src/file-io/tiff.js';

// The fixtures are written by test/fixtures/tiff/make_fixtures.py with tifffile.
const fixture = async (name) => {
  const bytes = await readFile(new URL(`./fixtures/tiff/${name}`, import.meta.url));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
};
const value = (page, sample, y, x, modulo) => (page * 37 + sample * 101 + y * 7 + x * 3) % modulo;
const expected = (page, sample, height, width, modulo) => Array.from({ length: height * width }, (_, i) => value(page, sample, Math.floor(i / width), i % width, modulo));

test('a plain multi-page stack reads every page with its calibration', async () => {
  const stack = await openTiffPages(await fixture('stack-u16.tif'));
  assert.equal(stack.pageCount, 3);
  assert.deepEqual([stack.width, stack.height, stack.dtype, stack.samplesPerPixel], [7, 5, 'uint16', 1]);
  assert.deepEqual(stack.sampleRoles, ['value']);
  assert.equal(stack.ome, false);
  assert.equal(stack.metadata, null);
  assert.deepEqual(stack.resolution, { x: 4, y: 2, unit: 'centimeter' });
  for (let page = 0; page < 3; page += 1) {
    const [plane] = await stack.readPage(page);
    assert.ok(plane instanceof Uint16Array);
    assert.deepEqual(Array.from(plane), expected(page, 0, 5, 7, 65521));
  }
});

test('an ImageJ hyperstack reports its channels, slices and spacing', async () => {
  const stack = await openTiffPages(await fixture('imagej-hyperstack.tif'));
  assert.equal(stack.pageCount, 4);
  assert.deepEqual(stack.metadata, { kind: 'imagej', images: 1, sizeC: 2, sizeZ: 2, sizeT: 1, pixelSize: { x: 0.5, y: 0.5, z: 2.5 }, frameInterval: null });
  assert.deepEqual(stack.resolution, { x: 2, y: 2, unit: null });
  const [plane] = await stack.readPage(3);
  assert.deepEqual(Array.from(plane), expected(3, 0, 4, 6, 251));
});

test('RGB samples and alpha are told apart; each sample is its own plane', async () => {
  const stack = await openTiffPages(await fixture('rgba.tif'));
  assert.deepEqual(stack.sampleRoles, ['red', 'green', 'blue', 'alpha']);
  const planes = await stack.readPage(0);
  assert.equal(planes.length, 4);
  planes.forEach((plane, sample) => assert.deepEqual(Array.from(plane), expected(0, sample, 3, 4, 251)));
});

test('sample roles follow PhotometricInterpretation and ExtraSamples', () => {
  assert.deepEqual(sampleRoles(1, 3, [0, 0]), ['value', 'value', 'value']);
  assert.deepEqual(sampleRoles(1, 2, [2]), ['value', 'alpha']);
  assert.deepEqual(sampleRoles(2, 4, [0]), ['red', 'green', 'blue', 'value']);
  assert.equal(sampleRoles(2, 1, []), null);
  assert.equal(sampleRoles(3, 1, []), null);
});

test('reduced-resolution pages are skipped', async () => {
  const stack = await openTiffPages(await fixture('with-thumbnail.tif'));
  assert.equal(stack.pageCount, 2);
  assert.deepEqual([stack.width, stack.height], [4, 4]);
});

test('palette images are refused', async () => {
  await assert.rejects(openTiffPages(await fixture('palette.tif')), /palette images are not supported/);
});

test('a stack above the byte budget is refused before reading pixels', async () => {
  await assert.rejects(openTiffPages(await fixture('stack-u16.tif'), { maxBytes: 3 * 5 * 7 * 2 - 1 }), InputTooLargeError);
  await openTiffPages(await fixture('stack-u16.tif'), { maxBytes: 3 * 5 * 7 * 2 });
});

test('OME-XML with a namespace prefix is recognised and rewritten to the default namespace', async () => {
  const stack = await openTiffPages(await fixture('prefixed-ome.tif'));
  assert.equal(stack.ome, true);
  const xml = omeXml(stack.description);
  assert.match(xml, /^<\?xml[^>]*><OME xmlns="http:\/\/www\.openmicroscopy\.org\/Schemas\/OME\/2016-06">/);
  assert.match(xml, /<Channel ID="Channel:0:0" Name="DAPI"/);
  assert.doesNotMatch(xml, /ome:/);
  assert.equal(omeXml('ImageJ=1.54f\nimages=2'), null);
  assert.equal(omeXml('<OME>no namespace</OME>'), null);
});

test('single-quoted OME attributes are read and rewritten double-quoted, entities kept', () => {
  const description = "<?xml version='1.0'?><ome:OME xmlns:ome='http://www.openmicroscopy.org/Schemas/OME/2016-06'><ome:Image ID='Image:0' Name='a &amp; \"b\"'><ome:Pixels SizeC='2' SizeZ=\"3\" PhysicalSizeX='65' PhysicalSizeXUnit='nm'/></ome:Image></ome:OME>";
  const metadata = parseOmeDescription(description);
  assert.deepEqual([metadata.sizeC, metadata.sizeZ, metadata.pixelSize.x], [2, 3, 0.065]);
  const xml = omeXml(description);
  assert.match(xml, /<Image ID="Image:0" Name="a &amp; &quot;b&quot;">/);
  assert.match(xml, /<Pixels SizeC="2" SizeZ="3" PhysicalSizeX="65" PhysicalSizeXUnit="nm"\/>/);
  assert.match(xml, /^<\?xml version='1.0'\?>/, 'the declaration is not a start tag');
});
