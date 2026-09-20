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
  tilt.update({ beta: 60, gamma: 5 });
  assert.ok(tilt.pitch < -0.5, "leaning the top away pitches down");
  tilt.update({ beta: 20, gamma: 5 });
  assert.ok(tilt.pitch > 0.5, "leaning the top toward you pitches up");
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
  assert.equal(ignored.samples, 0, "events without angles are ignored");
});
