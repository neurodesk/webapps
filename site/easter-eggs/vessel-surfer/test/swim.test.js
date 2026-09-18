import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { steer, swim } from "../src/swim.js";
import { volume, network } from "../test-fixtures/human.js";
import { routePose } from "../src/network.js";
import { clearSight } from "../src/chase.js";
import { insideMask } from "../src/mask.js";
test("direct steering follows screen right/up and stays stable through vertical turns", () => {
  const heading = new THREE.Vector3(0, 0, 1),
    up = new THREE.Vector3(0, 1, 0);
  const right = heading.clone().cross(up);
  steer(heading, up, 0.3, 0.2);
  assert.ok(heading.dot(right) > 0);
  assert.ok(heading.y > 0);
  for (let i = 0; i < 2000; i++) steer(heading, up, 0.02, 0.03);
  assert.ok(Math.abs(heading.dot(up)) < 1e-10);
  assert.ok(Math.abs(heading.length() - 1) < 1e-10);
});
test("free swimming stops before real walls, can reverse, and does not teleport through them", () => {
  const start = routePose(network, network.start).position;
  for (const direction of [
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(0, 0, 1),
  ]) {
    const next = swim(volume, start, direction.clone().multiplyScalar(50));
    assert.ok(next.distanceTo(start) < 50);
    assert.ok(insideMask(volume, next.toArray()));
    assert.ok(clearSight(volume, start, next));
    const back = swim(
      volume,
      next,
      start.clone().sub(next).multiplyScalar(0.5),
    );
    assert.ok(back.distanceTo(start) <= next.distanceTo(start));
  }
});
