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

test('outliers follow Fiji 3.1.8: worst > 2.5 × mean and > 0.95 px, or mean > 3.5 px', async () => {
  const { isOutlierStep } = await import('../src/core/global.js');
  const limits = { maxRatio: 2.5, maxAbsolute: 3.5 };
  // A 2 px worst link against a 0.5 px mean is an outlier although it is below 3.5 px.
  assert.equal(isOutlierStep(2, 0.5, limits), true);
  // Below 0.95 px nothing is removed by the ratio, however small the mean.
  assert.equal(isOutlierStep(0.9, 0.1, limits), false);
  // A mean above 3.5 px removes the worst link even when it is not 2.5 × the mean.
  assert.equal(isOutlierStep(5, 4, limits), true);
  assert.equal(isOutlierStep(3, 2, limits), false);
});

test('a link 2 px off in a 3 × 3 grid is removed although its residual is below 3.5 px', () => {
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
  links[bad].offset = links[bad].offset.map((v, d) => v + [2.5, 0][d]);
  const result = optimisePositions(grid, links);
  assert.deepEqual(result.links.flatMap((link, k) => (link.status === 'outlier' ? [k] : [])), [bad]);
  assert.ok(result.links[bad].residual < 3.5, `${result.links[bad].residual}`);
  result.positions.forEach((p, k) => p.forEach((v, d) => assert.ok(Math.abs(v - truth[k][d]) < 1e-9)));
});

test('overlap weighting: a wrong diagonal link (r = 0.58) in a 3 × 2 grid moves tiles < 0.2 px', () => {
  // 512 px tiles, 51 px overlaps: an edge link is measured on 51 × 512 pixels, a diagonal on
  // 51 × 51. Outlier removal is off so the weights alone decide.
  const step = 461;
  const grid = [];
  const truth = [];
  for (let row = 0; row < 2; row++) {
    for (let column = 0; column < 3; column++) {
      grid.push([column * step, row * step]);
      truth.push([column * step + column * 1.3 - row * 0.7, row * step + row * 1.1 + column * 0.4]);
    }
  }
  const links = [];
  for (let i = 0; i < 6; i++) {
    for (let j = i + 1; j < 6; j++) {
      const columns = Math.abs((i % 3) - (j % 3));
      const rows = Math.abs(Math.floor(i / 3) - Math.floor(j / 3));
      if (columns > 1 || rows > 1) continue;
      const pixels = columns && rows ? 51 * 51 : 51 * 512;
      links.push({ i, j, r: 0.9, pixels, offset: truth[j].map((v, d) => v - truth[i][d]) });
    }
  }
  const bad = links.findIndex((link) => link.i === 1 && link.j === 3);
  links[bad] = { ...links[bad], r: 0.58, offset: links[bad].offset.map((v, d) => v + [4, -4][d]) };
  const largestError = ({ positions }) => Math.max(...positions.map((p, k) => Math.hypot(...p.map((v, d) => v - truth[k][d]))));
  const off = { maxRatio: 100, maxAbsolute: 10000 };
  const weighted = largestError(optimisePositions(grid, links, off));
  const correlationOnly = largestError(optimisePositions(grid, links.map(({ pixels: _pixels, ...link }) => link), off));
  assert.ok(weighted < 0.2, `${weighted} px`);
  assert.ok(correlationOnly > 1, `r-only weights: ${correlationOnly} px`);
});
