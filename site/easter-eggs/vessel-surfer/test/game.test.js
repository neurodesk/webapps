import { test } from "node:test";
import assert from "node:assert/strict";
import { advanceRoute, routePose } from "../src/network.js";
import { network } from "../test-fixtures/human.js";
import { decodeMask, insideMask } from "../src/mask.js";

function fixture(empty = false) {
  const buffer = new ArrayBuffer(352 + 32 ** 3),
    v = new DataView(buffer);
  v.setInt32(0, 348, true);
  [3, 32, 32, 32, 1, 1, 1, 1].forEach((x, i) =>
    v.setInt16(40 + i * 2, x, true),
  );
  v.setInt16(70, 2, true);
  v.setInt16(72, 8, true);
  [1, 1, 1, 2].forEach((x, i) => v.setFloat32(76 + i * 4, x, true));
  v.setFloat32(108, 352, true);
  new Uint8Array(buffer, 344, 4).set([110, 43, 49, 0]);
  if (!empty)
    for (let z = 3; z < 29; z++)
      for (let y = 12; y < 20; y++)
        for (let x = 12; x < 20; x++)
          v.setUint8(352 + x + 32 * (y + 32 * z), 1);
  return buffer;
}
test("long voyages cross junctions without teleporting or leaving the route", () => {
  const n = network;
  let r = { ...network.start };
  for (let i = 0; i < 5000; i++) {
    const previous = routePose(n, r).position;
    r = advanceRoute(n, r, 0.2, i % 5);
    const p = routePose(n, r);
    assert.ok(p.position.distanceTo(previous) < 0.3);
    assert.ok(r.progress >= 0 && r.progress < 1);
    assert.ok(Math.abs(p.direction.length() - 1) < 1e-5);
  }
});
test("mask decode preserves spacing, spawns inside, and keeps all targets reachable", async () => {
  const mask = await decodeMask(fixture());
  assert.equal(mask.scale[2] / mask.scale[0], 2);
  assert.ok(insideMask(mask, mask.spawn));
  for (const p of mask.targets) assert.ok(insideMask(mask, p));
  assert.equal(insideMask(mask, [10000, 0, 0]), false);
});
test("invalid and empty masks have actionable errors", async () => {
  await assert.rejects(decodeMask(new ArrayBuffer(1024)), /NIfTI/);
  await assert.rejects(decodeMask(fixture(true)), /No positive/);
});
