// The registration and the candidate-to-atlas mapping against brainreg's own outputs on the
// example brain (validation/brainreg-reference.json pins them on Hugging Face). Stack points are
// injected as candidates, so the whole default path (register, map candidates to atlas
// coordinates, assign regions) runs on the real example.
import test from 'node:test';
import assert from 'node:assert/strict';
import { comparePoints, divisionOf, loadBrainreg, medianMapDistanceUm, wholeBrainDice } from '../validation/brainreg-compare.mjs';
import { loadAtlas, openExample, runExample } from '../validation/run-example.mjs';
import { downsampledShape, stackToGrid } from '../src/space.js';

const brainreg = await loadBrainreg();
const atlas = await loadAtlas();
const { stack, voxelSizeUm } = await openExample('brainreg-test-brain');
const [A, S] = brainreg.shape;
const brainregId = ([a, s, r]) => brainreg.registeredAtlas[a + A * (s + S * r)];

// Stack voxels on a 9-voxel lattice that brainreg places inside the brain, as cellfinder's (x, y, z).
const target = downsampledShape(stack.shape, voxelSizeUm, 50);
const points = [];
for (let z = 4; z < stack.shape[0]; z += 9) {
  for (let y = 4; y < stack.shape[1]; y += 9) {
    for (let x = 4; x < stack.shape[2]; x += 9) {
      if (brainregId(stackToGrid([z, y, x], stack.shape, target, 'psl').map(Math.round))) points.push([x, y, z]);
    }
  }
}

// Points at least two grid voxels inside one major division of brainreg's labels: their division
// does not depend on where exactly the two registrations put a boundary.
function interior(row, table) {
  const [a, s, r] = row.grid.map(Math.round);
  const division = divisionOf(brainregId([a, s, r]), table);
  if (!division) return false;
  for (let da = -2; da <= 2; da++) {
    for (let ds = -2; ds <= 2; ds++) {
      for (let dr = -2; dr <= 2; dr++) {
        if (divisionOf(brainregId([a + da, s + ds, r + dr]), table) !== division) return false;
      }
    }
  }
  return true;
}

function assertMapsLikeBrainreg(result, label) {
  assert.equal(result.assigned.length, points.length);
  const rows = comparePoints(result.assigned, brainreg, { annotation: atlas.annotationData, table: result.table });
  const distances = rows.map((row) => row.distance).sort((p, q) => p - q);
  const median = distances[distances.length >> 1];
  const share = (selected, key) => selected.filter((row) => row[key]).length / selected.length;
  // brainreg-reference.json: the two maps differ by a median of 94 µm, about two atlas voxels.
  assert.ok(median <= 2, `${label}: median ${median.toFixed(2)} atlas voxels from brainreg`);
  assert.ok(share(rows, 'hemisphere') >= 0.95, `${label}: hemisphere agrees for ${share(rows, 'hemisphere')}`);
  const inside = rows.filter((_, i) => interior(result.assigned[i], result.table));
  assert.ok(inside.length > 2000, `${label}: ${inside.length} interior points`);
  assert.ok(share(inside, 'division') >= 0.95, `${label}: major division agrees for ${share(inside, 'division')}`);
  return rows;
}

const first = await runExample('brainreg-test-brain', { cells: points });

test('the registration agrees with brainreg: whole-brain Dice >= 0.97, median distance <= 100 µm', () => {
  const dice = wholeBrainDice(first.labels, brainreg.registeredAtlas);
  assert.ok(dice >= 0.97, `whole-brain Dice ${dice}`);
  const distance = medianMapDistanceUm(first.coordinates, brainreg);
  assert.ok(distance <= 100, `median map distance ${distance} µm`);
});

test("injected stack points map to brainreg's atlas coordinates, hemisphere and division", () => {
  assertMapsLikeBrainreg(first, 'psl');
  // Every mapped point is counted in the region table.
  const counted = first.rows.reduce((sum, row) => sum + row.count, 0);
  assert.equal(counted, first.assigned.filter((row) => row.index).length);
});

test('the same brain in another orientation maps the same points to the same place', async () => {
  // Planes become the columns reversed (l -> r), rows the planes reversed (p -> a), columns the
  // rows (s): orientation ras, voxels 40 × 50 × 40 µm, so the anisotropic axis moves to y.
  const [Z, H, W] = stack.shape;
  const volume = [];
  for (let z = 0; z < Z; z++) volume.push(await stack.readPlane(z));
  const reoriented = {
    shape: [W, Z, H],
    dtype: stack.dtype,
    async readPlane(plane) {
      const out = new Uint16Array(Z * H);
      const x = W - 1 - plane;
      for (let row = 0; row < Z; row++) {
        const source = volume[Z - 1 - row];
        for (let column = 0; column < H; column++) out[row * H + column] = source[column * W + x];
      }
      return out;
    },
  };
  const moved = points.map(([x, y, z]) => [y, Z - 1 - z, W - 1 - x]);
  const second = await runExample('brainreg-test-brain', { stack: reoriented, voxelSizeUm: [voxelSizeUm[2], voxelSizeUm[0], voxelSizeUm[1]], orientation: 'ras', cells: moved });
  assert.deepEqual(second.grid.shape, first.grid.shape);
  assert.deepEqual(second.spacingUm, first.spacingUm);
  second.gridPoints.forEach((point, i) => point.forEach((v, axis) => assert.ok(Math.abs(v - first.gridPoints[i][axis]) < 1e-9, `point ${i} axis ${axis}`)));
  assertMapsLikeBrainreg(second, 'ras');
  const shifts = second.assigned.map((row, i) => (row.atlas && first.assigned[i].atlas ? Math.hypot(...row.atlas.map((v, axis) => v - first.assigned[i].atlas[axis])) : Infinity));
  const sorted = shifts.sort((p, q) => p - q);
  assert.ok(sorted[Math.floor(sorted.length * 0.95)] < 0.5, `95th percentile shift ${sorted[Math.floor(sorted.length * 0.95)]} atlas voxels`);
});
