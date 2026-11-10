import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ngffLevels,
  openMicroscopyStack,
  openOmeZarrStack,
  openTiffStack,
} from '../src/file-io/microscopy-stack.js';
import { micrometresPerUnit } from '../src/file-io/tiff.js';
import { encodeTiff } from './fixtures/tiff-writer.mjs';

const plane = (width, height, offset, Type = Uint16Array) => Type.from({ length: width * height }, (_, i) => offset + i);
const file = (bytes, name, path) => {
  const result = new File([bytes], name);
  if (path) Object.defineProperty(result, 'webkitRelativePath', { value: path });
  return result;
};

const OME = '<?xml version="1.0"?><ome:OME xmlns:ome="http://www.openmicroscopy.org/Schemas/OME/2016-06"><ome:Image ID="Image:0">'
  + '<ome:Pixels DimensionOrder="XYZCT" SizeX="3" SizeY="2" SizeZ="2" SizeC="1" SizeT="1" Type="uint16" '
  + 'PhysicalSizeX="0.65" PhysicalSizeXUnit="µm" PhysicalSizeY="650" PhysicalSizeYUnit="nm" PhysicalSizeZ="0.005" PhysicalSizeZUnit="mm">'
  + '</ome:Pixels></ome:Image></ome:OME>';

test('NGFF and OME length units are read in microns', () => {
  assert.equal(micrometresPerUnit('nm'), 0.001);
  assert.equal(micrometresPerUnit('micrometer'), 1);
  assert.equal(micrometresPerUnit('millimeter'), 1000);
  assert.equal(micrometresPerUnit('meter'), 1e6);
  assert.equal(micrometresPerUnit('furlong'), null);
});

test('a multi-page OME-TIFF reads plane by plane with its voxel size', async () => {
  const pages = [0, 100].map((offset, z) => ({ width: 3, height: 2, data: plane(3, 2, offset), description: z === 0 ? OME : undefined }));
  const stack = await openTiffStack([file(encodeTiff(pages), 'brain.ome.tif')]);
  assert.deepEqual(stack.shape, [2, 2, 3]);
  assert.equal(stack.dtype, 'uint16');
  assert.deepEqual(stack.voxelSizeUm, { z: 5, y: 0.65, x: 0.65 });
  assert.deepEqual([...(await stack.readPlane(1))], [100, 101, 102, 103, 104, 105]);
  await assert.rejects(stack.readPlane(2), RangeError);
});

const omeWith = (sizeZ, tiffData, uuid = '') => OME
  .replace('<ome:OME ', `<ome:OME ${uuid ? `UUID="${uuid}" ` : ''}`)
  .replace('SizeZ="2"', `SizeZ="${sizeZ}"`)
  .replace('</ome:Pixels>', `${tiffData}</ome:Pixels>`);
const omeFile = (description, offsets, name = 'mapped.ome.tif') => file(encodeTiff(offsets.map((offset, i) => ({ width: 3, height: 2, data: plane(3, 2, offset), description: i === 0 ? description : undefined }))), name);

test('OME TiffData decides which page holds each z plane', async () => {
  // Page 0 holds z 1 and page 1 holds z 0, so plane 0 is the second page.
  const swapped = omeWith(2, '<ome:TiffData IFD="1" FirstZ="0" PlaneCount="1"/><ome:TiffData IFD="0" FirstZ="1" PlaneCount="1"/>');
  const stack = await openTiffStack([omeFile(swapped, [20, 10])]);
  assert.deepEqual(stack.shape, [2, 2, 3]);
  assert.equal((await stack.readPlane(0))[0], 10);
  assert.equal((await stack.readPlane(1))[0], 20);

  // IFD defaults to 0 and PlaneCount to one plane once IFD is given; a block without either
  // covers every page from IFD 0. Pages no plane names (thumbnails) are never read.
  const zFirst = omeWith(3, '<ome:TiffData IFD="2" FirstZ="0"/><ome:TiffData IFD="3" FirstZ="1" PlaneCount="2"/>');
  const thumbnails = [90, 91].map((value, i) => ({ width: 1, height: 1, data: Uint16Array.of(value), description: i === 0 ? zFirst : undefined }));
  const planes = [30, 40, 50].map((value) => ({ width: 3, height: 2, data: plane(3, 2, value) }));
  const offset = await openTiffStack([file(encodeTiff([...thumbnails, ...planes]), 'thumbnail.ome.tif')]);
  assert.deepEqual(offset.shape, [3, 2, 3]);
  assert.deepEqual(await Promise.all([0, 1, 2].map(async (z) => (await offset.readPlane(z))[0])), [30, 40, 50]);
  const whole = await openTiffStack([omeFile(omeWith(3, '<ome:TiffData/>', 'urn:uuid:a'), [7, 8, 9])]);
  assert.deepEqual(await Promise.all([0, 1, 2].map(async (z) => (await whole.readPlane(z))[0])), [7, 8, 9]);
  // DimensionOrder does not move z planes when there is one channel and one time point.
  const ordered = await openTiffStack([omeFile(swapped.replace('XYZCT', 'XYCTZ'), [20, 10])]);
  assert.equal((await ordered.readPlane(0))[0], 10);
  // A UUID naming this file is its own pages.
  const own = omeWith(2, '<ome:TiffData IFD="1" FirstZ="0"><ome:UUID>urn:uuid:a</ome:UUID></ome:TiffData><ome:TiffData IFD="0" FirstZ="1"><ome:UUID>urn:uuid:a</ome:UUID></ome:TiffData>', 'urn:uuid:a');
  assert.equal((await (await openTiffStack([omeFile(own, [20, 10])])).readPlane(0))[0], 10);
});

test('OME TiffData the reader cannot follow is refused before decoding', async () => {
  const refused = async (sizeZ, tiffData, offsets, pattern, uuid) => assert.rejects(openTiffStack([omeFile(omeWith(sizeZ, tiffData, uuid), offsets)]), pattern);
  await refused(2, '<ome:TiffData IFD="0" FirstZ="0"/>', [1, 2], /maps no page to z plane 2/);
  await refused(2, '<ome:TiffData IFD="0" FirstZ="0"/><ome:TiffData IFD="1" FirstZ="0"/>', [1, 2], /z plane 1 twice/);
  await refused(2, '<ome:TiffData IFD="0" FirstZ="0"/><ome:TiffData IFD="0" FirstZ="1"/>', [1, 2], /page 1 twice/);
  await refused(2, '<ome:TiffData IFD="0" FirstZ="0"/><ome:TiffData IFD="5" FirstZ="1"/>', [1, 2], /page 6, but the file has 2/);
  await refused(2, '<ome:TiffData IFD="0" FirstZ="0" PlaneCount="3"/>', [1, 2, 3], /z plane 3, but its Pixels declare 2/);
  await refused(2, '<ome:TiffData IFD="0" FirstZ="0" FirstC="1"/>', [1, 2], /channel 2/);
  await refused(2, '<ome:TiffData IFD="-1" FirstZ="0"/>', [1, 2], /IFD="-1"/);
  await refused(2, '<ome:TiffData IFD="0" FirstZ="0"><ome:UUID FileName="b.ome.tif">urn:uuid:b</ome:UUID></ome:TiffData>', [1, 2], /another file/, 'urn:uuid:a');
  // Without TiffData the pages are the planes in order, so their counts must agree.
  await refused(3, '', [1, 2], /declares 3 z planes but holds 2 pages/);
  await refused(1, '', [1, 2], /declares 1 z plane but holds 2 pages/);
});

test('big-endian pages decode to native values', async () => {
  const stack = await openTiffStack([file(encodeTiff([{ width: 2, height: 2, data: plane(2, 2, 1000) }], { littleEndian: false }), 'be.tif')]);
  assert.deepEqual([...(await stack.readPlane(0))], [1000, 1001, 1002, 1003]);
});

test('one file per plane is ordered by its number, not as text', async () => {
  const files = [10, 2, 1].map((z) => file(encodeTiff([{ width: 2, height: 1, data: plane(2, 1, z * 10) }]), `plane_${z}.tif`));
  const stack = await openMicroscopyStack(files);
  assert.deepEqual(stack.shape, [3, 1, 2]);
  assert.deepEqual([...(await stack.readPlane(0))], [10, 11]);
  assert.deepEqual([...(await stack.readPlane(2))], [100, 101]);
});

test('a later multi-page file in a TIFF sequence is refused on every read', async () => {
  const page = { width: 2, height: 2, data: plane(2, 2, 0) };
  const stack = await openTiffStack([
    file(encodeTiff([page]), 'a.tif'),
    file(encodeTiff([page, page]), 'b.tif'),
  ]);
  await stack.readPlane(0);
  await assert.rejects(stack.readPlane(1), /b.tif has multiple pages/);
  await assert.rejects(stack.readPlane(1), /b.tif has multiple pages/);
});

test('ImageJ spacing and resolution give the voxel size', async () => {
  const bytes = encodeTiff([{ width: 2, height: 2, data: plane(2, 2, 0), description: 'ImageJ=1.52n\nunit=micron\nspacing=5\n', xResolution: [1, 2], yResolution: [1, 2] }]);
  const stack = await openTiffStack([file(bytes, 'ij.tif')]);
  assert.deepEqual(stack.voxelSizeUm, { z: 5, y: 2, x: 2 });
});

test('plain TIFFs without metadata leave the voxel size unknown', async () => {
  const stack = await openTiffStack([file(encodeTiff([{ width: 2, height: 2, data: plane(2, 2, 0) }]), 'plain.tif')]);
  assert.deepEqual(stack.voxelSizeUm, { z: null, y: null, x: null });
});

test('WhiteIsZero pages are inverted to BlackIsZero', async () => {
  const stack = await openTiffStack([file(encodeTiff([{ width: 2, height: 1, data: Uint8Array.from([0, 200]), photometric: 0 }]), 'inverted.tif')]);
  assert.deepEqual([...(await stack.readPlane(0))], [255, 55]);
});

test('RGB, palette and multi-channel stacks are refused before decoding', async () => {
  const rgb = encodeTiff([{ width: 1, height: 1, data: Uint8Array.from([1, 2, 3]), samples: 3, photometric: 2 }]);
  await assert.rejects(openTiffStack([file(rgb, 'rgb.tif')]), /3 samples per pixel \(RGB\)/);
  const palette = encodeTiff([{ width: 1, height: 1, data: Uint8Array.from([1]), photometric: 3 }]);
  await assert.rejects(openTiffStack([file(palette, 'palette.tif')]), /palette/);
  const twoChannels = OME.replace('SizeC="1"', 'SizeC="2"');
  const channels = encodeTiff([{ width: 3, height: 2, data: plane(3, 2, 0), description: twoChannels }]);
  await assert.rejects(openTiffStack([file(channels, 'two.ome.tif')]), /2 channels/);
  await assert.rejects(openTiffStack([file(new Uint8Array(4), 'notes.txt')]), /\.tif/);
});

test('planes that are too large or of a different size are refused', async () => {
  const big = encodeTiff([{ width: 64, height: 64, data: plane(64, 64, 0) }]);
  await assert.rejects(openTiffStack([file(big, 'big.tif')], { maxPlaneBytes: 1000 }), /coarser level/);
  const files = [
    file(encodeTiff([{ width: 2, height: 2, data: plane(2, 2, 0) }]), 'a1.tif'),
    file(encodeTiff([{ width: 3, height: 2, data: plane(3, 2, 0) }]), 'a2.tif'),
  ];
  const stack = await openTiffStack(files);
  await assert.rejects(stack.readPlane(1), /a2\.tif plane 1 is 3 × 2/);
});

function zarrFiles(root, { axes, levels }) {
  const encoder = new TextEncoder();
  const files = [
    file(encoder.encode(JSON.stringify({ zarr_format: 2 })), '.zgroup', `${root}/.zgroup`),
    file(encoder.encode(JSON.stringify({ multiscales: [{ version: '0.4', axes, datasets: levels.map((level, i) => ({ path: String(i), coordinateTransformations: [{ type: 'scale', scale: level.scale }] })) }] })), '.zattrs', `${root}/.zattrs`),
  ];
  levels.forEach((level, i) => {
    files.push(file(encoder.encode(JSON.stringify({ zarr_format: 2, shape: level.shape, chunks: level.shape, dtype: '<u2', compressor: null, fill_value: 0, order: 'C', filters: null })), '.zarray', `${root}/${i}/.zarray`));
    files.push(file(new Uint8Array(level.data.buffer), level.shape.map(() => '0').join('.'), `${root}/${i}/${level.shape.map(() => '0').join('.')}`));
  });
  return files;
}

test('an OME-Zarr folder lists its levels in microns and reads planes', async () => {
  const axes = [{ name: 'c', type: 'channel' }, { name: 'z', type: 'space', unit: 'micrometer' }, { name: 'y', type: 'space', unit: 'micrometer' }, { name: 'x', type: 'space', unit: 'micrometer' }];
  const full = Uint16Array.from({ length: 2 * 2 * 2 * 3 }, (_, i) => i);
  const coarse = Uint16Array.from({ length: 2 * 1 * 1 * 2 }, (_, i) => 500 + i);
  const files = zarrFiles('brain.ome.zarr', {
    axes,
    levels: [{ shape: [2, 2, 2, 3], scale: [1, 5, 2, 2], data: full }, { shape: [2, 1, 1, 2], scale: [1, 10, 4, 4], data: coarse }],
  });
  await assert.rejects(openMicroscopyStack(files), /2 channels; select a channel explicitly/);
  await assert.rejects(openMicroscopyStack(files, { channel: 0.5 }), /outside/);
  const firstChannel = await openMicroscopyStack(files, { channel: 0 });
  assert.deepEqual([...(await firstChannel.readPlane(0))], [0, 1, 2, 3, 4, 5]);
  const stack = await openMicroscopyStack(files, { channel: 1 });
  assert.equal(stack.kind, 'ome-zarr');
  assert.deepEqual(stack.shape, [2, 2, 3]);
  assert.deepEqual(stack.voxelSizeUm, { z: 5, y: 2, x: 2 });
  assert.deepEqual(stack.levels.map((level) => level.shape), [[2, 2, 3], [1, 1, 2]]);
  assert.deepEqual([...(await stack.readPlane(1))], [18, 19, 20, 21, 22, 23]);
  assert.deepEqual([...(await stack.readPlane(0, 1))], [502, 503]);
  await assert.rejects(openOmeZarrStack(files, { channel: 2 }), /Channel 2 is outside 0-1/);
});

test('NGFF levels need spatial axes', () => {
  assert.throws(() => ngffLevels({ axes: [{ name: 't' }, { name: 'y' }, { name: 'x' }], datasets: [] }), /z, y and x/);
});

test('extra samples drop out only when they are alpha', async () => {
  const twoSamples = (extraSamples) => encodeTiff([{ width: 2, height: 1, data: Uint8Array.from([10, 255, 20, 255]), samples: 2, extraSamples }]);
  const alpha = await openTiffStack([file(twoSamples([2]), 'alpha.tif')]);
  assert.deepEqual([...(await alpha.readPlane(0))], [10, 20]);
  const associated = await openTiffStack([file(twoSamples([1]), 'associated.tif')]);
  assert.deepEqual([...(await associated.readPlane(0))], [10, 20]);
  // ExtraSamples 0 is an unspecified channel, not alpha: two channels.
  await assert.rejects(openTiffStack([file(twoSamples([0]), 'two-channels.tif')]), /2 samples per pixel \(several channels\)/);
});

test('WhiteIsZero is decided for each page', async () => {
  const bytes = encodeTiff([
    { width: 2, height: 1, data: Uint8Array.from([0, 200]) },
    { width: 2, height: 1, data: Uint8Array.from([0, 200]), photometric: 0 },
  ]);
  const stack = await openTiffStack([file(bytes, 'mixed.tif')]);
  assert.deepEqual([...(await stack.readPlane(0))], [0, 200]);
  assert.deepEqual([...(await stack.readPlane(1))], [255, 55]);
  const reversed = await openTiffStack([file(encodeTiff([
    { width: 2, height: 1, data: Uint8Array.from([0, 200]), photometric: 0 },
    { width: 2, height: 1, data: Uint8Array.from([0, 200]) },
  ]), 'reversed.tif')]);
  assert.deepEqual([...(await reversed.readPlane(0))], [255, 55]);
  assert.deepEqual([...(await reversed.readPlane(1))], [0, 200]);
});

test('a size without a unit is not assumed to be in microns', async () => {
  assert.equal(micrometresPerUnit(undefined), null);
  assert.equal(micrometresPerUnit(''), null);
  const bytes = encodeTiff([{ width: 2, height: 2, data: plane(2, 2, 0), description: 'ImageJ=1.52n\nspacing=5\n', xResolution: [1, 2], yResolution: [1, 2] }]);
  const stack = await openTiffStack([file(bytes, 'no-unit.tif')]);
  assert.deepEqual(stack.voxelSizeUm, { z: null, y: null, x: null });
  // OME's schema default is the micrometre.
  const unitless = encodeTiff([0, 100].map((offset, z) => ({ width: 3, height: 2, data: plane(3, 2, offset), description: z === 0 ? OME.replace(/ PhysicalSize[XYZ]Unit="[^"]*"/g, '') : undefined })));
  assert.deepEqual((await openTiffStack([file(unitless, 'unitless.ome.tif')])).voxelSizeUm, { z: 0.005, y: 650, x: 0.65 });
});

test('an OME-Zarr chunk several planes deep is decoded once for all its planes', async () => {
  const axes = [{ name: 'z', type: 'space', unit: 'micrometer' }, { name: 'x', type: 'space', unit: 'micrometer' }, { name: 'y', type: 'space', unit: 'micrometer' }];
  // Stored z, x, y: plane z holds x * 2 + y + 10 * z at [x][y].
  const data = Uint16Array.from({ length: 2 * 3 * 2 }, (_, i) => i);
  const files = zarrFiles('xy.ome.zarr', { axes, levels: [{ shape: [2, 3, 2], scale: [5, 2, 2], data }] });
  const chunk = files.at(-1);
  let reads = 0;
  const read = chunk.arrayBuffer.bind(chunk);
  chunk.arrayBuffer = () => {
    reads++;
    return read();
  };
  const stack = await openOmeZarrStack(files);
  assert.deepEqual(stack.shape, [2, 2, 3]);
  // Rows are y, columns x: plane[y * 3 + x] = stored[z][x][y].
  assert.deepEqual([...(await stack.readPlane(0))], [0, 2, 4, 1, 3, 5]);
  assert.deepEqual([...(await stack.readPlane(1))], [6, 8, 10, 7, 9, 11]);
  assert.equal(reads, 1);
});

test("ngffLevels keeps declared scales in the axes' own units, and none for a dataset without a scale", () => {
  const levels = ngffLevels({
    axes: ["z", "y", "x"].map((name) => ({ name, type: "space" })),
    datasets: [{ path: "0", coordinateTransformations: [{ type: "scale", scale: [10.2, 10.2, 10.2] }] }, { path: "1" }],
  });
  assert.deepEqual(levels[0].scale, { z: 10.2, y: 10.2, x: 10.2 });
  assert.deepEqual(levels[0].voxelSizeUm, { z: null, y: null, x: null });
  assert.deepEqual(levels[1].scale, { z: null, y: null, x: null });
});

test('the shared OME parser reads single-quoted attributes and refuses several image series', async () => {
  const quoted = OME.replace(/"/g, "'");
  const stack = await openTiffStack([file(encodeTiff([{ width: 3, height: 2, data: plane(3, 2, 0), description: quoted }, { width: 3, height: 2, data: plane(3, 2, 100) }]), 'quoted.ome.tif')]);
  assert.deepEqual(stack.voxelSizeUm, { z: 5, y: 0.65, x: 0.65 });
  const twoSeries = OME.replace('</ome:Image>', '</ome:Image><ome:Image ID="Image:1"><ome:Pixels SizeX="3" SizeY="2" SizeZ="1" SizeC="1" SizeT="1" Type="uint16"></ome:Pixels></ome:Image>');
  const bytes = encodeTiff([0, 100, 200].map((offset, z) => ({ width: 3, height: 2, data: plane(3, 2, offset), description: z === 0 ? twoSeries : undefined })));
  await assert.rejects(openTiffStack([file(bytes, 'series.ome.tif')]), /holds 2 image series/);
});
