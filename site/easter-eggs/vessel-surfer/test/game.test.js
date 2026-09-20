import { test } from "node:test";
import assert from "node:assert/strict";
import { advanceRoute, routePose } from "../src/network.js";
import { network } from "../test-fixtures/human.js";

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
