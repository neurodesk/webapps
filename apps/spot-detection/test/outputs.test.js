import { test } from "node:test";
import assert from "node:assert/strict";
import { cellCounts, cellIds, cellsCsv, spotsCsv } from "../src/outputs.js";
import { analyse } from "../src/pipeline.js";
import { syntheticImage } from "../src/synthetic.js";

test("a 2D label image assigns spots in every plane; label 0 is outside", () => {
  const labels = { data: Uint16Array.from([0, 1, 1, 2, 2, 0]), shape: [2, 3] };
  const ids = cellIds([[0, 0, 1], [3, 1, 0], [1, 1, 2], [2, 0, 0]], labels, [4, 2, 3]);
  assert.deepEqual(ids, [1, 2, 0, 0]);
  assert.deepEqual(cellCounts(ids, labels), { cells: [{ id: 1, spots: 1, area: 2 }, { id: 2, spots: 1, area: 2 }], outside: 2 });
  assert.equal(cellsCsv(cellCounts(ids, labels)), "cell_id,spots,area_px\n1,1,2\n2,1,2\n0,2,\n");
});

test("labels on another grid are refused", () => {
  assert.throws(() => cellIds([[0, 0]], { data: new Uint16Array(4), shape: [2, 2] }, [3, 3]), /must match the image/);
});

test("the spots CSV has one row per spot with position, voxel, intensity and LoG response", () => {
  const image = { data: Uint16Array.from([1, 2, 3, 4]), shape: [2, 2], dtype: "uint16" };
  const filtered = { data: Uint16Array.from([0, 0, 0, 7]) };
  const csv = spotsCsv({ spots: [[1, 1]], subpixel: [[1.23456, 0.9]], image, filtered, ids: [5] });
  assert.equal(csv, "spot_id,y,x,y_px,x_px,intensity,log_response,cell_id\n1,1.2346,0.9000,1,1,4,7,5\n");
});

test("analysis of a 3D stack in its maximum projection detects in 2D", () => {
  const image = syntheticImage([6, 40, 48], 15, 5);
  const labels = { data: new Uint16Array(40 * 48).fill(1), shape: [40, 48] };
  const result = analyse(image, { voxelSize: [300, 103, 103], spotRadius: [350, 150, 150], projection: true, labels });
  assert.deepEqual(result.image.shape, [40, 48]);
  assert.equal(result.sigma.length, 2);
  assert.ok(result.spots.length > 5);
  assert.equal(result.cells.cells[0].spots, result.spots.length);
  assert.match(result.spotsCsv, /^spot_id,y,x,y_px,x_px,intensity,log_response,cell_id\n/);
});
