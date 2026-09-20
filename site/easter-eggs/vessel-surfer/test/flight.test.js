import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { Flight } from "../src/flight.js";
import { volume } from "../test-fixtures/human.js";
import { clearSight } from "../src/chase.js";
import { insideMask } from "../src/mask.js";
import { surfaceGuard } from "../src/surface-guard.js";

// Captured from the paused Narrows run, 49.649 seconds and six bumps.
const captured = () => ({
  position: new THREE.Vector3(-26.86085189093897, -9.460235333352498, 64.30564228940501),
  heading: new THREE.Vector3(-0.34974248153986287, 0.1589208490422777, -0.9232683035532089),
  up: new THREE.Vector3(0.05629683013555178, 0.9872913266810774, 0.14861528581208344),
});

test("the captured wall stall recovers without input or crossing the lumen wall", () => {
  const { position, heading, up } = captured();
  const start = position.clone();
  const flight = new Flight();
  for (let frame = 0; frame < 600; frame++) {
    const previous = position.clone();
    const result = flight.step(volume, position, heading, up, { dt: 1 / 60 });
    if (frame === 0) assert.equal(result.blocked, true, "captured throttle stop is visible");
    assert.ok(insideMask(volume, position.toArray()), "eye stays inside");
    assert.ok(clearSight(volume, previous, position), "movement never crosses a wall");
  }
  assert.ok(position.distanceTo(start) > 0.14,
    `must escape by at least one voxel; moved ${position.distanceTo(start)} mm`);
});

// A closed lumen with the eye looking straight at its end wall. All four
// side probes have identical clearance, so their steering differences cancel.
const closedLumen = {
  n: 24,
  scale: [0.5, 0.5, 0.5],
  field: new Float32Array(24 ** 3).fill(1),
  ...surfaceGuard(new THREE.BoxGeometry(4, 4, 10), true),
};

test("a symmetric wall stop is reported and escapes without player input", () => {
  const position = new THREE.Vector3(0, 0, 4.9);
  const start = position.clone();
  const heading = new THREE.Vector3(0, 0, 1);
  const up = new THREE.Vector3(0, 1, 0);
  const flight = new Flight();
  const first = flight.step(closedLumen, position, heading, up, { dt: 1 / 60 });
  assert.equal(first.blocked, true, "zero throttle at a wall is still blocked");
  for (let frame = 0; frame < 600; frame++) {
    const previous = position.clone();
    flight.step(closedLumen, position, heading, up, { dt: 1 / 60 });
    assert.ok(insideMask(closedLumen, position.toArray()));
    assert.ok(clearSight(closedLumen, previous, position));
  }
  assert.ok(position.distanceTo(start) > 0.5, "must escape the wall within ten seconds");
});

for (const dt of [1 / 30, 1 / 144]) {
  test(`wall recovery is bounded at ${Math.round(1 / dt)} fps`, () => {
    const position = new THREE.Vector3(0, 0, 4.9);
    const start = position.clone();
    const heading = new THREE.Vector3(0, 0, 1);
    const up = new THREE.Vector3(0, 1, 0);
    const flight = new Flight();
    for (let time = 0; time < 10; time += dt) {
      const previous = position.clone();
      flight.step(closedLumen, position, heading, up, { dt, cruise: 0.25 });
      assert.ok(clearSight(closedLumen, previous, position));
    }
    assert.ok(position.distanceTo(start) > 0.5);
  });
}

for (const input of [
  { braking: true },
  { reversing: true },
  { playerDemand: { yaw: -1, pitch: 0 } },
  { turnRequest: true },
]) {
  test(`manual control cancels recovery: ${JSON.stringify(input)}`, () => {
    const position = new THREE.Vector3(0, 0, 4.9);
    const heading = new THREE.Vector3(0, 0, 1);
    const up = new THREE.Vector3(0, 1, 0);
    const flight = new Flight();
    let result;
    for (let i = 0; i < 125; i++) {
      result = flight.step(closedLumen, position, heading, up, { dt: 1 / 60 });
    }
    assert.ok(result.recovering);
    result = flight.step(closedLumen, position, heading, up, { dt: 1 / 60, ...input });
    assert.equal(result.recovering, false);
    if (input.braking) {
      assert.equal(result.moved, 0);
      assert.equal(result.blocked, false);
    }
    if (input.reversing) assert.ok(result.speed < 0);
    if (input.turnRequest) assert.ok(result.turning);
    flight.reset();
    assert.equal(flight.escape, null);
    assert.equal(flight.stalledFor, 0);
    assert.equal(flight.uturn.active, false);
  });
}
