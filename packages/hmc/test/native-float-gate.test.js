import assert from "node:assert/strict";
import test from "node:test";
import { loadHmcNode } from "../src/node.js";
import { nativeFloatGate } from "../validation/nifreeze-gate.mjs";

test("the accepted world-centre gate retains a failing QSIPrep-pivot diagnostic", async () => {
  const hmc = await loadHmcNode();
  const grid = { shape: [3, 3, 3], affine: [[1, 0, 0, 100], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]] };
  const transform = (angle, y = 0, x = 0) => hmc.writeMat({
    parameters: [Math.cos(angle), -Math.sin(angle), 0, Math.sin(angle), Math.cos(angle), 0, 0, 0, 1, x, y, 0],
    fixed: [-101, -1, 1],
  }, { precision: "double" });
  const identity = transform(0);
  const registration = {
    volume: 0, rawVolume: 1, wasm: transform(0.001), nativeFloat: identity,
    nativeDouble: identity, secondSeed: transform(0.002, -0.2, 0.01),
  };
  const report = nativeFloatGate({ hmc, grid, cases: [registration] });
  assert.equal(report.pass, true);
  assert.equal(report.world.failingCells, 0);
  assert.ok(report.qsiprep.failingCells > 0);
  assert.ok(report.qsiprep.rows[0].failingAxes.includes("ty"));
  const outside = nativeFloatGate({ hmc, grid, cases: [{ ...registration, wasm: transform(0.001, 10) }] });
  assert.equal(outside.pass, false);
  assert.ok(outside.world.rows[0].failingAxes.includes("ty"));
});

test("an empty registration set cannot pass", () => {
  assert.throws(() => nativeFloatGate({ cases: [] }), /requires registration cases/);
});
