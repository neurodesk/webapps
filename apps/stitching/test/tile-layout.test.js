import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  compareNames,
  formatTileConfiguration,
  gridCell,
  gridPositions,
  overlappingPairs,
  parseTileConfiguration,
  positionsFromConfiguration,
  positionsFromStage,
} from '../src/core/tile-layout.js';

const fiji = (name) => readFileSync(new URL(`../validation/fiji/${name}`, import.meta.url), 'utf8');

test('the 4 × 4, 18 % grid equals the TileConfiguration.txt that Fiji wrote for the example', () => {
  const configuration = parseTileConfiguration(fiji('TileConfiguration.txt'));
  const names = configuration.entries.map((entry) => entry.name);
  assert.deepEqual([...names].sort(compareNames), names);
  const positions = gridPositions({ count: 16, columns: 4, rows: 4, overlap: 0.18, shape: [1392, 1040] });
  assert.deepEqual(positions, positionsFromConfiguration(configuration, names, 2));
  assert.equal(formatTileConfiguration(2, names.map((name, k) => ({ name, position: positions[k] }))), fiji('TileConfiguration.txt'));
});

test("Fiji's registered TileConfiguration parses with its sub-pixel coordinates", () => {
  const { dims, entries } = parseTileConfiguration(fiji('TileConfiguration.registered.txt'));
  assert.equal(dims, 2);
  assert.equal(entries.length, 16);
  assert.deepEqual(entries[1], { name: 'img_r001_c002.tif', position: [1119.544600192594, -4.43340221967039] });
});

test('grid types and first-tile corners place tiles in acquisition order', () => {
  const cells = (options) => Array.from({ length: 6 }, (_, k) => gridCell(k, { columns: 3, rows: 2, ...options })).map(({ column, row }) => `${column}${row}`);
  assert.deepEqual(cells({ type: 'row' }), ['00', '10', '20', '01', '11', '21']);
  assert.deepEqual(cells({ type: 'snake-row' }), ['00', '10', '20', '21', '11', '01']);
  assert.deepEqual(cells({ type: 'column' }), ['00', '01', '10', '11', '20', '21']);
  assert.deepEqual(cells({ type: 'snake-column' }), ['00', '01', '11', '10', '20', '21']);
  assert.deepEqual(cells({ type: 'row', start: 'bottom-right' }), ['21', '11', '01', '20', '10', '00']);
  assert.deepEqual(cells({ type: 'snake-row', start: 'top-right' }), ['20', '10', '00', '01', '11', '21']);
});

test('a grid that does not hold the loaded tiles is refused', () => {
  assert.throws(() => gridPositions({ count: 5, columns: 2, rows: 2, overlap: 0.1, shape: [10, 10] }), /holds 4 tiles, but 5/);
  assert.throws(() => gridPositions({ count: 4, columns: 2, rows: 2, overlap: 1, shape: [10, 10] }), /overlap/);
});

test('3D TileConfiguration files round-trip and must list exactly the loaded tiles', () => {
  const text = formatTileConfiguration(3, [{ name: 'a.tif', position: [0, 0, 0] }, { name: 'b.tif', position: [410.25, -3, 1.5] }]);
  assert.equal(text, '# Define the number of dimensions we are working on\ndim = 3\n\n# Define the image coordinates\na.tif; ; (0.0, 0.0, 0.0)\nb.tif; ; (410.25, -3.0, 1.5)\n');
  const configuration = parseTileConfiguration(text);
  assert.deepEqual(positionsFromConfiguration(configuration, ['b.tif', 'a.tif'], 3), [[410.25, -3, 1.5], [0, 0, 0]]);
  assert.throws(() => positionsFromConfiguration(configuration, ['a.tif', 'c.tif'], 3), /does not list c\.tif/);
  assert.throws(() => positionsFromConfiguration(configuration, ['a.tif', 'b.tif'], 2), /3D but the tiles are 2D/);
  assert.throws(() => parseTileConfiguration('dim = 2\na.tif; 1; (0, 0)\n'), /multi-series/);
  assert.throws(() => parseTileConfiguration('dim = 2\na.tif; ; (0, x)\n'), /not a number/);
});

test('stage positions become pixel positions relative to the first corner', () => {
  const positions = positionsFromStage([{ x: 1000, y: 500 }, { x: 1065, y: 499.35 }], [{ x: 0.65, y: 0.65 }, { x: 0.65, y: 0.65 }], 2);
  assert.ok(Math.abs(positions[1][0] - 100) < 1e-9 && Math.abs(positions[0][1] - 1) < 1e-9);
  assert.throws(() => positionsFromStage([{ x: 1, y: 1 }, null], [{ x: 1, y: 1 }, { x: 1, y: 1 }], 2), /Tile 2 has no OME stage position/);
  assert.throws(() => positionsFromStage([{ x: 1, y: 1 }], [{ x: null, y: 1 }], 2), /pixel size/);
});

test('3D stage positions use every tile\'s z, or none, never z 0 for a tile that lacks one', () => {
  const sizes = [{ x: 1, y: 1, z: 2 }, { x: 1, y: 1, z: 2 }];
  assert.deepEqual(positionsFromStage([{ x: 0, y: 0, z: 10 }, { x: 90, y: 0, z: 14 }], sizes, 3), [[0, 0, 0], [90, 0, 2]]);
  assert.deepEqual(positionsFromStage([{ x: 0, y: 0, z: null }, { x: 90, y: 0, z: null }], sizes, 3), [[0, 0, 0], [90, 0, 0]]);
  assert.throws(() => positionsFromStage([{ x: 0, y: 0, z: 10 }, { x: 90, y: 0, z: null }], sizes, 3), /Tile 2 has no stage z position/);
});

test('only overlapping pairs are registered, diagonal neighbours included', () => {
  const shapes = Array(4).fill([100, 80]);
  assert.deepEqual(overlappingPairs(shapes, [[0, 0], [90, 0], [0, 70], [90, 70]]), [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]]);
  assert.deepEqual(overlappingPairs(shapes, [[0, 0], [100, 0], [0, 80], [100, 80]]), []);
});
