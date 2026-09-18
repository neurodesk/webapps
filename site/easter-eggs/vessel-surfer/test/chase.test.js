import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { TunnelCamera, clearSight } from "../src/chase.js";
import { sampleMask } from "../src/mask.js";
import { routePose, advanceRoute } from "../src/network.js";
import { volume, network, metadata } from "../test-fixtures/human.js";

test("default routes are real IXI human data and every route sample stays inside its rendered surface", () => {
  assert.equal(metadata.subject, "IXI322-IOP-0891-MRA.nii.gz");
  assert.equal(metadata.license, "CC-BY-NC-SA-4.0");
  assert.ok(network.edges.length > 100);
  let min = 1;
  for (const edge of network.edges)
    for (let d = 0; d <= edge.length; d += 0.04) {
      const p = edge.curve.getPointAt(d / edge.length);
      const v = sampleMask(volume, p.toArray());
      min = Math.min(min, v);
      assert.ok(
        volume.surfaceInside(p.toArray()),
        `edge ${edge.id} at ${d} leaves rendered triangles`,
      );
      assert.ok(
        v > 0.53,
        `edge ${edge.id}, distance ${d}: outside lumen (${v})`,
      );
    }
  console.log("Minimum route density:", min);
});
test("tunnel eye never leaves the lumen or shortcuts a bend", () => {
  const rig = new TunnelCamera();
  let route = { ...network.start };
  for (let i = 0; i < 4000; i++) {
    route = advanceRoute(network, route, 0.035, i % 5);
    const p = routePose(network, route).position;
    const ahead = routePose(
      network,
      advanceRoute(network, route, 0.06, i % 5),
    ).position;
    if (!clearSight(volume, p, ahead)) continue;
    rig.update(p, ahead, volume, 1 / 60, i === 0);
    assert.ok(
      rig.position.distanceTo(p) < 1e-8,
      "camera must be on route, never offset outside",
    );
    assert.ok(sampleMask(volume, rig.position.toArray()) > 0.53);
    assert.ok(
      clearSight(volume, rig.position, rig.target),
      "view must not look through a wall",
    );
    assert.ok(Math.abs(rig.heading.dot(rig.up)) < 1e-5);
  }
});
test("camera refuses positions outside the segmented lumen", () => {
  const rig = new TunnelCamera();
  assert.throws(
    () =>
      rig.update(
        new THREE.Vector3(500, 500, 500),
        new THREE.Vector3(501, 500, 500),
        volume,
        0.016,
      ),
    /left the vessel/,
  );
});

test("bundled source segmentation matches the published asset checksum", async () => {
  const { readFile } = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");
  const bytes = await readFile(
    new URL("../public/data/ixi322-vessels.nii.gz", import.meta.url),
  );
  const expected =
    "68addc6caedf8fb22c26c0ad8977028fd6eba114e6ef0597e607267ccb45fe1e";
  assert.equal(createHash("sha256").update(bytes).digest("hex"), expected);
  assert.equal(metadata.sourceSha256, expected);
});

test("rendered junction obstruction is detected even when the volume ray is clear", () => {
  const route = advanceRoute(network, network.start, 5, 0);
  const p = routePose(network, route).position;
  const fieldOnly = { ...volume, surfaceClear: undefined };
  let ahead = p.clone();
  for (let distance = 0.02; distance < 4; distance += 0.02) {
    const candidate = routePose(
      network,
      advanceRoute(network, route, distance, 0),
    ).position;
    if (!clearSight(fieldOnly, p, candidate)) break;
    ahead = candidate;
  }
  assert.ok(clearSight(fieldOnly, p, ahead));
  assert.equal(
    clearSight(volume, p, ahead),
    false,
    "the actual wall must veto a volume-only view",
  );
});
