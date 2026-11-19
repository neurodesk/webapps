import { test } from "node:test";
import assert from "node:assert/strict";
// Loads the WebAssembly module synchronously, so the engine's own init() has nothing to fetch.
import { hrf } from "@neurodesk/samsrf/node";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJob, mergeShards, readSurfaceMesh, runShard } from "../src/engine.js";
import { freeSurferSurface, giftiRun, giftiSurface, matFile } from "../../../packages/samsrf/test/fixtures.js";

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

test("a subject HRF fit gives the app's engine and the samsrf command line the same maps, byte for byte", async (t) => {
  const work = mkdtempSync(join(tmpdir(), "samsrf-engine-test-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const volumes = 60;
  const fP = [5.5, 15.5, 5, 2];
  const pixel = (p) => Float64Array.from({ length: volumes }, (_, n) => Number((n + 3 * p) % 8 < 2));
  const kernel = hrf.oldSchool(1, fP);
  const files = {
    "lh_run.gii": giftiRun([0, 1, 2].map((v) => Array.from(hrf.convolve(pixel(v), kernel), (value, n) => value + 0.05 * Math.sin(7 * n + v)))),
    "aps.mat": matFile({ ApFrm: { dims: [2, 2, volumes], data: Array.from({ length: volumes }, (_, n) => [0, 1, 2, 3].map((p) => pixel(p)[n])).flat() } }),
    "hrf_subject.mat": matFile({ fP: { dims: [1, 4], data: fP } }),
  };
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(work, name), bytes);
  const model = {
    Name: "Subject", Prf_Function: "@(P,ApWidth) prf_gaussian_rf(P(1), P(2), P(3), ApWidth)", Param_Names: ["x0", "y0", "Sigma"],
    Scaled_Param: [1, 1, 1], Only_Positive: [0, 0, 1], Scaling_Factor: 1, TR: 1, Hrf: "hrf_subject", Aperture_File: "aps",
    Polar_Search_Space: false, Param1: [-0.5, 0.5], Param2: [-0.5, 0.5], Param3: [0.5, 1], Coarse_Fit_Only: true,
  };
  writeFileSync(join(work, "model.json"), JSON.stringify(model));
  const named = (name) => ({ name, bytes: new Uint8Array(files[name]) });
  const job = await createJob({
    analysis: "prf", model, runs: [named("lh_run.gii")], apertures: named("aps.mat"), roi: null, surfaces: {},
    template: null, seed: null, subjectHrf: named("hrf_subject.mat"), normalise: true, average: true,
  });
  assert.ok(job.summary.includes("Subject HRF hrf_subject.mat: fP 5.5, 15.5, 5, 2"));
  const shards = [await runShard(job, 0, 1, () => {}), await runShard(job, 1, job.units, () => {})];
  const result = await mergeShards(job, shards);

  const bin = join(dirname(fileURLToPath(import.meta.resolve("@neurodesk/samsrf/package.json"))), "bin", "samsrf.js");
  const output = join(work, "out");
  const cli = spawnSync(process.execPath, [bin, "prf", join(work, "model.json"), output, "--runs", join(work, "lh_run.gii"), "--apertures", join(work, "aps.mat"), "--hrf", join(work, "hrf_subject.mat")], { encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr);
  assert.deepEqual(readdirSync(output).filter((name) => name.endsWith(".gii")).sort(), result.files.map(({ name }) => name).sort());
  for (const { name, bytes } of result.files) assert.ok(Buffer.from(bytes).equals(readFileSync(join(output, name))), name);
  assert.ok(result.maps.find(({ name }) => name === "R^2").values.every((value) => value > 0.8));
});
