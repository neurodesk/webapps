import { test } from "node:test";
import assert from "node:assert/strict";
// Loads the WebAssembly module synchronously, so the engine's own init() has nothing to fetch.
import "@neurodesk/samsrf/node";
import { readSurfaceMesh } from "../src/engine.js";
import { freeSurferSurface, giftiSurface } from "../../../packages/samsrf/test/fixtures.js";

const vertices = [0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0, 4];
const faces = [0, 1, 2, 0, 2, 3, 0, 3, 1, 1, 3, 2];
// The volume-geometry block FreeSurfer's own tools append after the faces.
const tags = Uint8Array.from([0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 20, ...new TextEncoder().encode("valid = 1  # volume info valid\n")]);

test("the viewer draws the surface the analysis reads, with or without FreeSurfer's trailing tags", async () => {
  const tagless = freeSurferSurface(vertices, faces);
  for (const [name, bytes] of [["lh.white", tagless], ["lh.white", Uint8Array.from([...tagless, ...tags])], ["lh.white.surf.gii", giftiSurface(vertices, faces)]]) {
    const mesh = await readSurfaceMesh({ name, bytes });
    assert.ok(mesh.vertices instanceof Float32Array, name);
    assert.deepEqual([...mesh.vertices], vertices, name);
    assert.deepEqual([...mesh.faces], faces, name);
  }
  await assert.rejects(readSurfaceMesh({ name: "lh.white", bytes: new TextEncoder().encode("not a surface") }), /^Error: lh\.white: FreeSurfer: unknown surface magic number/);
  await assert.rejects(readSurfaceMesh({ name: "lh.white", bytes: tagless.subarray(0, tagless.length - 1) }), /^Error: lh\.white: FreeSurfer: file ends while reading faces/);
});
