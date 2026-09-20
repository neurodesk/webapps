import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createRouteArrowGeometry } from "../src/route-arrow.js";
import { humanChallenge } from "../src/navigation-map.js";
import { TRACKS } from "../src/race.js";
import { network, volume } from "../test-fixtures/human.js";

// The outer chevron tip is its vertex furthest from the origin. Inspect the
// actual rendered vertices, so a rotation-sign regression cannot pass merely
// because the route tangent itself is correct.
test("the rendered chevron points along +Z with its face toward +Y", () => {
  const geometry = createRouteArrowGeometry();
  const positions = geometry.getAttribute("position");
  const normals = geometry.getAttribute("normal");
  const tip = new THREE.Vector3();
  for (let i = 0; i < positions.count; i++) {
    const point = new THREE.Vector3().fromBufferAttribute(positions, i);
    if (point.lengthSq() > tip.lengthSq()) tip.copy(point);
    assert.ok(Math.abs(point.y) < 1e-6, "arrow lies flat in XZ");
    assert.ok(normals.getY(i) > 0.999, "face stays directed into the lumen");
  }
  assert.ok(tip.z > 0.5, `tip must point toward +Z, got ${tip.toArray()}`);
  assert.ok(Math.abs(tip.x) < 1e-6, "tip is centred on the route");
  geometry.dispose();
});

for (const track of TRACKS) {
  test(`${track.name} chevrons point toward the next route sample`, () => {
    const geometry = createRouteArrowGeometry();
    const positions = geometry.getAttribute("position");
    const tip = new THREE.Vector3();
    for (let i = 0; i < positions.count; i++) {
      const point = new THREE.Vector3().fromBufferAttribute(positions, i);
      if (point.lengthSq() > tip.lengthSq()) tip.copy(point);
    }
    const { path, directions } = humanChallenge(network, volume, track);
    for (let i = 0; i < path.length - 1; i++) {
      const forward = directions[i];
      const down = new THREE.Vector3(0, -1, 0);
      down.addScaledVector(forward, -down.dot(forward));
      if (down.lengthSq() < 0.05) down.set(1, 0, 0).cross(forward);
      const normal = down.normalize().negate();
      const right = normal.clone().cross(forward).normalize();
      const basis = new THREE.Matrix4().makeBasis(right, normal, forward);
      const arrowDirection = tip.clone().transformDirection(basis);
      const towardNext = path[i + 1].clone().sub(path[i]).normalize();
      assert.ok(arrowDirection.dot(towardNext) > 0.999, `reversed arrow at sample ${i}`);
    }
    geometry.dispose();
  });
}
