// Whole mosaics with exact ground truth (test/synthetic.js): the approximate grid is up to
// 12 px off, and every tile must come back within 0.5 px of its true position.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maxPositionDifference, stitch } from '../src/core/pipeline.js';
import { syntheticMosaic } from './synthetic.js';

test('a 3 × 3 2D mosaic is recovered to a fraction of a pixel', () => {
  const { tiles, approximate, truth } = syntheticMosaic({ columns: 3, rows: 3, shape: [192, 160], overlap: 0.2 });
  const result = stitch(tiles, approximate);
  const error = maxPositionDifference(result.positions, truth);
  assert.ok(error < 0.5, `largest position error ${error.toFixed(3)} px`);
  assert.ok(error < 0.2, `largest position error ${error.toFixed(3)} px`);
  // Every edge-sharing neighbour pair is used; only small diagonal overlaps may be rejected.
  const neighbours = result.links.filter((link) => link.j - link.i === 1 || link.j - link.i === 3);
  assert.ok(neighbours.every((link) => link.status === 'used'));
});

test('a 2 × 2 3D mosaic is recovered to a fraction of a voxel, z included', () => {
  const { tiles, approximate, truth } = syntheticMosaic({ columns: 2, rows: 2, shape: [96, 80, 32], overlap: 0.25, jitter: 5, depth: 3, seed: 8 });
  const result = stitch(tiles, approximate);
  const error = maxPositionDifference(result.positions, truth);
  assert.ok(error < 0.5, `largest position error ${error.toFixed(3)} voxels`);
});

test('a featureless tile is left on the layout instead of being dragged by noise', () => {
  const { tiles, approximate, truth } = syntheticMosaic({ columns: 3, rows: 2, shape: [160, 128], overlap: 0.2, seed: 12 });
  tiles[5] = { shape: tiles[5].shape, data: tiles[5].data.map((_, i) => 100 + ((i * 7919) % 13) - 6) };
  const result = stitch(tiles, approximate);
  assert.ok(result.links.filter((link) => link.j === 5 || link.i === 5).every((link) => link.status !== 'used'));
  const others = maxPositionDifference(result.positions.slice(0, 5), truth.slice(0, 5));
  assert.ok(others < 0.5, `largest error of the linked tiles ${others.toFixed(3)} px`);
});
