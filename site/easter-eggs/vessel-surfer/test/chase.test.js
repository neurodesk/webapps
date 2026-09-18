import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { TunnelCamera, clearSight } from "../src/chase.js";
import { sampleMask } from "../src/mask.js";
import { routePose, advanceRoute } from "../src/network.js";
import { volume, network, metadata } from "../test-fixtures/human.js";

test("default routes are real human pial artery data and every route sample stays inside its rendered surface", () => {
  assert.equal(metadata.subject, "arteries_seg_TOF_hm_xpace_140um_MoCoOn_20200220145234_7_biasCor_noiseCor_VT450_lVT370_VENP10.nii.gz");
  assert.equal(metadata.paperDoi, "10.7554/eLife.71186");
  assert.equal(metadata.source, "https://doi.org/10.17605/OSF.IO/NR6GC");
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
    new URL("../public/data/source.nii.gz", import.meta.url),
  );
  const expected =
    "2fd0f6a79977e9985e68bb5de80633518cd2c571fd1bd1151705fc2dc0eabc55";
  assert.equal(createHash("sha256").update(bytes).digest("hex"), expected);
  assert.equal(metadata.sourceSha256, expected);
});

test("rendered junction obstruction is detected even when the volume ray is clear", () => {
  // Somewhere in the graph a route bends around a rendered corner that the
  // trilinear field alone would see through. The triangle guard must veto it.
  const fieldOnly = { ...volume, surfaceClear: undefined };
  let vetoes = 0;
  let checked = 0;
  for (let edge = 0; edge < network.edges.length && vetoes === 0; edge++) {
    const route = { edge, reverse: false, progress: 0.1 };
    const p = routePose(network, route).position;
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
    checked++;
    if (!clearSight(volume, p, ahead)) vetoes++;
  }
  assert.ok(checked > 0);
  assert.ok(vetoes > 0, "the actual wall must veto a volume-only view somewhere");
});
