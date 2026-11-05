import { test } from 'node:test';
import assert from 'node:assert/strict';
import { optimisePositions } from '../src/core/global.js';

const approximate = [[0, 0], [90, 0], [0, 90], [90, 90]];

test('consistent links are solved exactly with the first tile at its layout position', () => {
  const truth = [[0, 0], [91.5, -2.25], [1.25, 88.5], [92.5, 86.0]];
  const links = [[0, 1], [0, 2], [1, 3], [2, 3], [0, 3]].map(([i, j]) => ({ i, j, r: 0.9, offset: truth[j].map((v, d) => v - truth[i][d]) }));
  const { positions, links: out } = optimisePositions(approximate, links);
  positions.forEach((p, k) => p.forEach((v, d) => assert.ok(Math.abs(v - truth[k][d]) < 1e-9)));
  assert.ok(out.every((link) => link.status === 'used' && link.residual < 1e-9));
});

test('an inconsistent link is rejected as an outlier and the rest are kept', () => {
  const grid = [];
  const truth = [];
  for (let row = 0; row < 3; row++) {
    for (let column = 0; column < 3; column++) {
      grid.push([column * 90, row * 90]);
      truth.push([column * 91 + row * 1.5, row * 88 - column * 2]);
    }
  }
  const pairs = [];
  for (let k = 0; k < 9; k++) {
    if (k % 3 < 2) pairs.push([k, k + 1]);
    if (k < 6) pairs.push([k, k + 3]);
  }
  const links = pairs.map(([i, j]) => ({ i, j, r: 0.9, offset: truth[j].map((v, d) => v - truth[i][d]) }));
  const bad = links.findIndex((link) => link.i === 4 && link.j === 5);
  links[bad].offset = [60, 30];
  const result = optimisePositions(grid, links);
  assert.deepEqual(result.links.flatMap((link, k) => (link.status === 'outlier' ? [k] : [])), [bad]);
  result.positions.forEach((p, k) => p.forEach((v, d) => assert.ok(Math.abs(v - truth[k][d]) < 1e-9)));
});

test('low-correlation links are left out and an unlinked tile keeps its layout, moved with the rest', () => {
  const links = [
    { i: 0, j: 1, r: 0.9, offset: [92, 2] },
    { i: 0, j: 2, r: 0.9, offset: [2, 92] },
    { i: 1, j: 3, r: 0.1, offset: [50, 50] },
    { i: 2, j: 3, r: 0.2, offset: [-40, 3] },
  ];
  const result = optimisePositions(approximate, links);
  assert.deepEqual(result.links.map((l) => l.status), ['used', 'used', 'low correlation', 'low correlation']);
  assert.deepEqual(result.components, [[0, 1, 2], [3]]);
  // Tiles 0, 1 and 2 moved by (0, 0), (2, 2) and (2, 2): (4/3, 4/3) on average. Tile 3 moves with them.
  assert.ok(Math.abs(result.positions[3][0] - (90 + 4 / 3)) < 1e-9);
  assert.ok(Math.abs(result.positions[3][1] - (90 + 4 / 3)) < 1e-9);
});
