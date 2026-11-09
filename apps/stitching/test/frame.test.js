import { test } from "node:test";
import assert from "node:assert/strict";
import { displayFrame, largestMove, placeInFrame, tileOutlinePolygons } from "../src/frame.js";
import { fuseTiles } from "../src/core/fusion.js";

const shapes = [[6, 4], [6, 4]];

test("the display frame holds the tiles under both the layout and the registered positions", () => {
  const layout = [[0, 0], [4, 0]];
  const registered = [[0, 0], [3.4, -1.5]];
  assert.deepEqual(displayFrame(shapes, [layout]), { origin: [0, 0], shape: [10, 4] });
  assert.deepEqual(displayFrame(shapes, [layout, registered]), { origin: [0, -2], shape: [10, 6] });
});

test("an image placed in the frame keeps every pixel at its frame position and type", () => {
  const tile = { shape: [6, 4], data: Uint16Array.from({ length: 24 }, (_, i) => i + 1) };
  const registered = [[0, 0], [3, -2]];
  const frame = displayFrame(shapes, [[[0, 0], [4, 0]], registered]);
  const fused = fuseTiles([tile, tile], registered);
  const placed = placeInFrame({ ...fused, data: Uint16Array.from(fused.data, Math.round) }, frame);
  assert.equal(placed.constructor, Uint16Array);
  assert.equal(placed.length, 10 * 6);
  for (let y = 0; y < fused.shape[1]; y++) {
    for (let x = 0; x < fused.shape[0]; x++) {
      const fy = y + fused.origin[1] - frame.origin[1];
      assert.equal(placed[fy * 10 + x], Math.round(fused.data[y * fused.shape[0] + x]), `pixel ${x}, ${y}`);
    }
  }
  // The column right of the registered mosaic stays empty.
  for (let y = 0; y < 6; y++) assert.equal(placed[y * 10 + 9], 0);
});

test("an image outside the frame is refused", () => {
  assert.throws(() => placeInFrame({ shape: [4, 4], origin: [8, 0], data: new Float32Array(16) }, { origin: [0, 0], shape: [10, 4] }), /does not fit/);
});

test("outlines are each tile's pixel edges in the display NIfTI's world coordinates", () => {
  const frame = { origin: [0, -2], shape: [10, 6] };
  const outlines = tileOutlinePolygons([[6, 4], [6, 4]], [[0, 0], [3.4, -1.5]], frame, [0.5, 2, 1]);
  assert.deepEqual(outlines.map(({ tile, slicePosition }) => [tile, slicePosition]), [[0, 0], [1, 0]]);
  // Tile 0 covers frame rows 2-5 (y from 5 down to 2 after the flip) and columns 0-5.
  assert.deepEqual(outlines[0].outer, [{ x: -0.25, y: 7 }, { x: 2.75, y: 7 }, { x: 2.75, y: -1 }, { x: -0.25, y: -1 }]);
  // Tile 1 starts 3.4 px right and 0.5 px below the frame's first row.
  const [a, , c] = outlines[1].outer;
  assert.ok(Math.abs(a.x - 1.45) < 1e-12 && Math.abs(a.y - 10) < 1e-12);
  assert.ok(Math.abs(c.x - 4.45) < 1e-12 && Math.abs(c.y - 2) < 1e-12);
});

test("a 3D tile is outlined on every plane it covers and nowhere else", () => {
  const frame = { origin: [0, 0, 0], shape: [5, 5, 6] };
  const outlines = tileOutlinePolygons([[3, 3, 2]], [[1, 1, 2.6]], frame, [1, 1, 0.5]);
  assert.deepEqual(outlines.map((o) => o.slicePosition), [1.5, 2]);
});

test("the largest move is the longest distance between a tile's layout and registered position", () => {
  assert.equal(largestMove([[0, 0], [10, 0]], [[0, 0], [13, 4]]), 5);
});
