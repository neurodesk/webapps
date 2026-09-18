import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { Steering, UTurn, aimFromOffset, combineDemand } from "../src/controls.js";
import { assistDemand, probeLumen, throttle } from "../src/assist.js";
import { level, steer } from "../src/swim.js";
import { network, volume } from "../test-fixtures/human.js";
import { routePose } from "../src/network.js";
import { lumenRadius } from "../src/chase.js";

test("pointer offsets have a dead zone, a soft curve and full authority at the rim", () => {
  assert.deepEqual(aimFromOffset(3, -2, 100), { yaw: 0, pitch: 0 });
  const gentle = aimFromOffset(30, 0, 100);
  const firm = aimFromOffset(100, 0, 100);
  assert.ok(gentle.yaw > 0 && gentle.yaw < 0.2);
  assert.ok(Math.abs(firm.yaw - 1) < 1e-9);
  assert.ok(aimFromOffset(0, -100, 100).pitch > 0.99, "screen up pitches up");
  assert.ok(Math.abs(aimFromOffset(0, 400, 100).pitch + 1) < 1e-9, "clamped");
});

test("turn rates ramp toward the demand and decay when released", () => {
  const steering = new Steering({ maxRate: 2, response: 12 });
  const first = steering.update(1, 0, 1 / 60);
  const second = steering.update(1, 0, 1 / 60);
  assert.ok(first.yaw > 0 && second.yaw > first.yaw);
  for (let i = 0; i < 120; i++) steering.update(1, 0, 1 / 60);
  assert.ok(Math.abs(steering.yawRate - 2) < 1e-3);
  steering.update(0, 0, 1 / 60);
  assert.ok(steering.yawRate < 2);
  steering.update(5, -5, 1 / 60);
  assert.ok(steering.yawRate <= 2 && steering.pitchRate >= -2, "demands clamp");
});

test("assist fills unused authority only", () => {
  const assist = { yaw: 1, pitch: 0 };
  assert.deepEqual(combineDemand({ yaw: 0, pitch: 0 }, assist, 0.5), { yaw: 0.5, pitch: 0 });
  assert.deepEqual(combineDemand({ yaw: -1, pitch: 0 }, assist, 0.5), { yaw: -1, pitch: 0 });
  const half = combineDemand({ yaw: 0.5, pitch: 0 }, assist, 0.5);
  assert.ok(Math.abs(half.yaw - 0.75) < 1e-9);
  const opposed = combineDemand({ yaw: -0.2, pitch: 0.1 }, { yaw: 1, pitch: -1 }, 0.6);
  assert.deepEqual(opposed, { yaw: -0.2, pitch: 0.1 }, "never fights the player");
});

test("lumen probes point the assist toward open vessel and ease off before walls", () => {
  const pose = routePose(network, network.start);
  const up = new THREE.Vector3(0, 1, 0);
  up.addScaledVector(pose.direction, -up.dot(pose.direction)).normalize();
  const radius = lumenRadius(volume, pose.position);
  const probe = probeLumen(volume, pose.position, pose.direction, up, radius * 6);
  for (const key of ["ahead", "left", "right", "up", "down"])
    assert.ok(probe[key] >= 0 && probe[key] <= probe.reach, key);
  assert.ok(probe.ahead > radius, "the route continues ahead");
  const open = throttle(probe);
  assert.ok(open > 0.3 && open <= 1);
  assert.equal(throttle({ ...probe, ahead: probe.reach * 0.1 }), 0.3);
  assert.equal(throttle({ ...probe, ahead: 0 }), 0, "nose on the wall stops");
  const demand = assistDemand({ reach: 10, ahead: 5, left: 1, right: 9, up: 5, down: 5 });
  assert.ok(demand.yaw > 0.9 && demand.pitch === 0, "turns toward the open right side");
  const clamped = assistDemand({ reach: 10, ahead: 5, left: 10, right: 0, up: 0, down: 10 });
  assert.deepEqual(clamped, { yaw: -1, pitch: -1 });
});

test("the camera rolls back toward world-up without changing the heading", () => {
  const heading = new THREE.Vector3(1, 0, 0);
  const up = new THREE.Vector3(0, 0, 1);
  for (let i = 0; i < 200; i++) level(heading, up, 1 / 60);
  assert.ok(up.y > 0.999, `levelled: ${up.toArray()}`);
  assert.ok(Math.abs(heading.x - 1) < 1e-9);
  const vertical = new THREE.Vector3(0, 1, 0);
  const side = new THREE.Vector3(1, 0, 0);
  level(vertical, side, 1);
  assert.deepEqual(side.toArray(), [1, 0, 0], "vertical headings keep their roll");
  const rolled = new THREE.Vector3(0, 0, 1);
  const tilted = new THREE.Vector3(Math.SQRT1_2, Math.SQRT1_2, 0);
  steer(rolled, tilted, 0, 0);
  level(rolled, tilted, 10);
  assert.ok(Math.abs(tilted.dot(rolled)) < 1e-9, "up stays perpendicular");
  assert.ok(tilted.y > 0.999);
});

test("a U-turn sweeps exactly half a turn toward the requested side, then ends", () => {
  const turn = new UTurn(2);
  assert.equal(turn.update(1), 0, "idle turns produce no yaw");
  assert.ok(turn.begin(-1));
  assert.ok(!turn.begin(1), "a second request during a turn is ignored");
  let total = 0;
  for (let i = 0; i < 40; i++) total += turn.update(1 / 60);
  assert.ok(turn.active);
  assert.ok(total < 0, "turns left when asked");
  for (let i = 0; i < 100; i++) total += turn.update(1 / 60);
  assert.ok(!turn.active);
  assert.ok(Math.abs(total + Math.PI) < 1e-9, `half a turn: ${total}`);
  const heading = new THREE.Vector3(0, 0, 1);
  const up = new THREE.Vector3(0, 1, 0);
  const right = new UTurn(4);
  right.begin(1);
  while (right.active) steer(heading, up, right.update(1 / 60), 0);
  assert.ok(heading.z < -0.999999, `reversed heading: ${heading.toArray()}`);
  right.begin(1);
  right.cancel();
  assert.ok(!right.active);
});
