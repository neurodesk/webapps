import { test } from "node:test";
import assert from "node:assert/strict";
import { Tilt } from "../src/tilt.js";

test("tilt steers relative to the neutral pose with a dead zone and a soft curve", () => {
  const tilt = new Tilt({ dead: 3, range: 22 });
  tilt.update({ beta: 40, gamma: 5 });
  assert.deepEqual([tilt.yaw, tilt.pitch], [0, 0], "the first sample is neutral");
  tilt.update({ beta: 40, gamma: 7 });
  assert.equal(tilt.yaw, 0, "inside the dead zone");
  tilt.update({ beta: 40, gamma: 15 });
  assert.ok(tilt.yaw > 0 && tilt.yaw < 0.4, "a gentle roll right turns right gently");
  tilt.update({ beta: 40, gamma: 40 });
  assert.equal(tilt.yaw, 1, "full authority beyond the range");
  tilt.update({ beta: 20, gamma: 5 });
  assert.ok(tilt.pitch < -0.5, "tipping the top away (toward flat) pitches down");
  tilt.update({ beta: 60, gamma: 5 });
  assert.ok(tilt.pitch > 0.5, "tipping the top back toward you pitches up");
  tilt.reset();
  tilt.update({ beta: 0, gamma: 0 });
  assert.deepEqual([tilt.yaw, tilt.pitch], [0, 0], "recentred");
});

test("landscape orientations map the device axes into the screen frame", () => {
  const landscape = new Tilt();
  landscape.update({ beta: 10, gamma: 30 }, 90);
  landscape.update({ beta: 40, gamma: 30 }, 90);
  assert.ok(landscape.yaw > 0.5, "rolling right in landscape turns right");
  const flipped = new Tilt();
  flipped.update({ beta: 10, gamma: 30 }, 270);
  flipped.update({ beta: 40, gamma: 30 }, 270);
  assert.ok(flipped.yaw < -0.5, "the same motion turns left when the screen is rotated the other way");
  const ignored = new Tilt();
  ignored.update({ beta: null, gamma: null });
  const tipped = new Tilt();
  tipped.update({ beta: 10, gamma: -45 }, 90);
  tipped.update({ beta: 10, gamma: -15 }, 90);
  assert.ok(tipped.pitch < -0.5, "tipping the top of a landscape screen away pitches down");
  assert.equal(ignored.samples, 0, "events without angles are ignored");
});

// Orientation angles for a phone whose screen is tipped `incline` degrees up
// from flat and then twisted `twist` degrees clockwise like a steering wheel,
// built from the device-frame up vector so the test does not reuse Euler maths.
function pose(incline, twist, angle = 0) {
  const rad = Math.PI / 180;
  const i = incline * rad;
  const t = twist * rad;
  // Screen-frame up vector: tilting up raises screen-y, twisting clockwise
  // swings up toward screen-left.
  const sx = -Math.sin(i) * Math.sin(t);
  const sy = Math.sin(i) * Math.cos(t);
  const sz = Math.cos(i);
  // Screen frame back to device frame for screen.orientation.angle.
  const a = angle * rad;
  const ux = sx * Math.cos(a) + sy * Math.sin(a);
  const uy = -sx * Math.sin(a) + sy * Math.cos(a);
  const beta = Math.atan2(uy, Math.hypot(ux, sz) * Math.sign(sz || 1)) / rad;
  const gamma = Math.atan(-ux / sz) / rad;
  return { beta, gamma };
}

test("steering-wheel twist steers the same at any holding angle", () => {
  for (const angle of [0, 90, 270]) {
    for (const incline of [45, 70, 85]) {
      const tilt = new Tilt();
      tilt.update(pose(incline, 0, angle), angle);
      tilt.update(pose(incline, 15, angle), angle);
      assert.ok(
        tilt.yaw > 0.1 && tilt.yaw < 0.5,
        `a 15 degree twist at ${incline} degrees (screen ${angle}) turns right gently, got ${tilt.yaw}`,
      );
      assert.ok(Math.abs(tilt.pitch) < 0.05, `no pitch from a twist at ${incline} degrees`);
    }
  }
});

test("holding a landscape phone past vertical does not flip the controls", () => {
  for (const angle of [90, 270]) {
    const tilt = new Tilt();
    tilt.update(pose(85, 0, angle), angle);
    tilt.update(pose(95, 0, angle), angle);
    assert.ok(tilt.pitch > 0 && tilt.pitch < 0.4, `tipping back past vertical climbs gently, got ${tilt.pitch}`);
    assert.ok(Math.abs(tilt.yaw) < 0.05, `and does not turn, got ${tilt.yaw}`);
  }
});
