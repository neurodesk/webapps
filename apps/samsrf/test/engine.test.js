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

test("the viewer refuses a quad surface, which it cannot draw", async () => {
  const be16 = (value) => [(value >> 8) & 0xff, value & 0xff];
  const be24 = (value) => [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
  // FreeSurfer's quad format: hundredths of a millimetre per coordinate and four vertices per face.
  const quads = Uint8Array.from([...be24(16777215), ...be24(4), ...be24(1), ...[0, 0, 0, 150, 0, 0, 0, -225, 0, 0, 0, 300].flatMap(be16), ...[0, 1, 2, 3].flatMap(be24)]);
  await assert.rejects(readSurfaceMesh({ name: "lh.white", bytes: quads }), /^Error: lh\.white: the viewer draws triangle meshes only\.$/);
});
