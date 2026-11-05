import test from 'node:test';
import assert from 'node:assert/strict';
import {
  micronsPerUnit,
  ngffLevels,
  openMicroscopyStack,
  openOmeZarrStack,
  openTiffStack,
  parseImageJDescription,
  parseOmeXml,
} from '../src/file-io/microscopy-stack.js';
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

test('OME-XML with a namespace prefix gives sizes in microns', () => {
  const ome = parseOmeXml(OME);
  assert.deepEqual(ome.voxelSizeUm, { z: 5, y: 0.65, x: 0.65 });
  assert.equal(ome.sizes.c, 1);
  assert.equal(parseOmeXml('ImageJ=1.52\nspacing=4'), null);
  assert.deepEqual(parseImageJDescription('ImageJ=1.52n\nimages=3\nslices=3\nunit=micron\nspacing=4.5\n'), { spacing: 4.5, unit: 'micron', channels: 1, frames: 1 });
  assert.equal(micronsPerUnit('nm'), 0.001);
  assert.equal(micronsPerUnit('furlong'), null);
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
  assert.equal(micronsPerUnit(undefined), null);
  assert.equal(micronsPerUnit(''), null);
  const bytes = encodeTiff([{ width: 2, height: 2, data: plane(2, 2, 0), description: 'ImageJ=1.52n\nspacing=5\n', xResolution: [1, 2], yResolution: [1, 2] }]);
  const stack = await openTiffStack([file(bytes, 'no-unit.tif')]);
  assert.deepEqual(stack.voxelSizeUm, { z: null, y: null, x: null });
  // OME's schema default is the micrometre.
  assert.deepEqual(parseOmeXml(OME.replace(/ PhysicalSize[XYZ]Unit="[^"]*"/g, '')).voxelSizeUm, { z: 0.005, y: 650, x: 0.65 });
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
