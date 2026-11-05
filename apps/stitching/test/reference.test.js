// The committed validation numbers (validation/*.json, written by the scripts beside them)
// must keep meeting the app's accuracy claims.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (name) => JSON.parse(readFileSync(new URL(`../validation/${name}`, import.meta.url), "utf8"));

test("on the example every tile is within 1 px of Fiji's Grid/Collection stitching", () => {
  const reference = read("example-reference.json");
  assert.equal(reference.positions.tiles.length, 16);
  assert.equal(reference.pairs.count, 42);
  assert.ok(reference.positions.largestDifference < 0.5, `${reference.positions.largestDifference} px`);
  assert.ok(reference.pairs.largestDifference < 1, `${reference.pairs.largestDifference} px`);
  for (const tile of reference.positions.tiles) {
    assert.ok(Math.hypot(tile.app[0] - tile.fiji[0], tile.app[1] - tile.fiji[1]) <= reference.positions.largestDifference + 1e-9);
  }
});

test("a mosaic cut from a real tile is recovered within 0.5 px of its known positions", () => {
  const reference = read("synthetic-real.json");
  assert.equal(reference.tiles, 9);
  assert.ok(reference.largestLayoutError > 10, "the layout starts well away from the truth");
  assert.ok(reference.largestError < 0.5, `${reference.largestError} px`);
  assert.ok(reference.errors.every((tile) => tile.error <= reference.largestError));
});
