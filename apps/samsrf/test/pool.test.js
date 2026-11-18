import { test } from "node:test";
import assert from "node:assert/strict";
import { runAnalysis, shardRanges, workerCount } from "../src/pool.js";
// Loads the WebAssembly module synchronously, so the engine's own init() has nothing to fetch.
import { hrf } from "@neurodesk/samsrf/node";
import * as engine from "../src/engine.js";
import { matFile } from "../../../packages/samsrf/test/fixtures.js";

test("shards cover every unit once, several per worker", () => {
  const ranges = shardRanges(1003, 3);
  assert.equal(ranges.length, 12);
  assert.equal(ranges[0][0], 0);
  assert.equal(ranges.at(-1)[1], 1003);
  ranges.slice(1).forEach(([start], index) => assert.equal(start, ranges[index][1]));
  assert.deepEqual(shardRanges(2, 4), [[0, 1], [1, 2]]);
  assert.equal(workerCount(1), 1);
  assert.equal(workerCount(64), 8);
});

// A Worker stand-in that runs worker.js's protocol against the engine in this thread.
function fakeWorker(log) {
  let job = null;
  const worker = {
    terminated: false,
    terminate() { this.terminated = true; },
    postMessage(message) {
      log.push(message.type);
      queueMicrotask(async () => {
        const send = (data) => !worker.terminated && worker.onmessage({ data });
        try {
          let value;
          if (message.type === "prepare") value = job = await engine.createJob(message.inputs);
          if (message.type === "job") job = message.job;
          if (message.type === "run") value = await engine.runShard(job, message.start, message.end, (done) => send({ type: "progress", done }));
          if (message.type === "merge") value = await engine.mergeShards(job, message.shards);
          send({ type: "done", value });
        } catch (error) {
          send({ type: "error", message: error.message });
        }
      });
    },
  };
  return worker;
}

// Synthetic inputs in the formats the engine reads: one ASCII GIfTI run of 10 vertices and
// 4 x 4 NIfTI apertures. Vertices 2, 5 and 7 (the ROI) follow one aperture pixel each, so
// reverse correlation without an HRF finds them.
const PIXELS = 16;
const VOLUMES = 40;
const frames = Array.from({ length: VOLUMES }, (_, volume) => Array.from({ length: PIXELS }, (_, pixel) => ((volume * 7 + pixel * 5) % 11) < 4 ? 1 : 0));

function niftiApertures() {
  const bytes = new Uint8Array(352 + PIXELS * VOLUMES * 4);
  const view = new DataView(bytes.buffer);
  view.setInt32(0, 348, true);
  [3, 4, 4, VOLUMES, 1, 1, 1, 1].forEach((dim, index) => view.setInt16(40 + 2 * index, dim, true));
  view.setInt16(70, 16, true);
  view.setInt16(72, 32, true);
  for (let index = 0; index < 8; index++) view.setFloat32(76 + 4 * index, 1, true);
  view.setFloat32(108, 352, true);
  bytes.set(new TextEncoder().encode("n+1\0"), 344);
  frames.forEach((frame, volume) => frame.forEach((value, pixel) => view.setFloat32(352 + 4 * (volume * PIXELS + pixel), value, true)));
  return { name: "aps_test.nii", bytes };
}

function giftiRun(vertices) {
  const course = (vertex, volume) => ([2, 5, 7].includes(vertex) ? frames[volume][vertex] : Math.sin(volume * (vertex + 1)));
  const arrays = Array.from({ length: VOLUMES }, (_, volume) => [
    `<DataArray Intent="NIFTI_INTENT_TIME_SERIES" DataType="NIFTI_TYPE_FLOAT32" ArrayIndexingOrder="RowMajorOrder" Dimensionality="1" Dim0="${vertices}" Encoding="ASCII" Endian="LittleEndian">`,
    `<Data>${Array.from({ length: vertices }, (_, vertex) => course(vertex, volume)).join(" ")}</Data>`,
    "</DataArray>",
  ].join("\n"));
  const text = ['<?xml version="1.0" encoding="UTF-8"?>', `<GIFTI Version="1.0" NumberOfDataArrays="${VOLUMES}">`, ...arrays, "</GIFTI>"].join("\n");
  return { name: "lh_bars1.gii", bytes: new TextEncoder().encode(text) };
}

const label = { name: "lh.roi.label", bytes: new TextEncoder().encode("#!ascii label\n3\n2 0 0 0 0\n5 0 0 0 0\n7 0 0 0 0\n") };
const model = { Name: "pRF", Scaling_Factor: 9.5, TR: 1, Hrf: 1, Aperture_File: "aps_test" };
const inputs = { analysis: "rc", model, runs: [giftiRun(10)], apertures: niftiApertures(), roi: label, surfaces: {}, template: null, seed: null, normalise: true, average: true };

test("an analysis prepares once, fits every shard and merges full-length maps", async () => {
  const log = [];
  const workers = [];
  const progress = [];
  const result = await runAnalysis(inputs, {
    workers: 2,
    createWorker: () => { const worker = fakeWorker(log); workers.push(worker); return worker; },
    onProgress: (fraction) => progress.push(fraction),
  });
  assert.equal(log.filter((type) => type === "prepare").length, 1);
  assert.equal(log.filter((type) => type === "merge").length, 1);
  assert.equal(result.outName, "lh_pRF_Rcp");
  assert.ok(result.maps.every(({ values }) => values.length === 10));
  const r2 = result.maps.find(({ name }) => name === "R^2").values;
  assert.deepEqual([...r2].map((value, vertex) => value !== 0 ? vertex : -1).filter((vertex) => vertex >= 0), [2, 5, 7], "only ROI vertices are fitted");
  assert.ok(result.files.every(({ map }) => result.maps.some(({ name }) => name === map)));
  assert.equal(progress.at(-1), 1);
  assert.ok(workers.every((worker) => worker.terminated), "the pool ends its workers");
});

test("cancelling rejects with AbortError and terminates the workers", async () => {
  const controller = new AbortController();
  const workers = [];
  const running = runAnalysis(inputs, { signal: controller.signal, createWorker: () => { const worker = fakeWorker([]); workers.push(worker); return worker; } });
  controller.abort();
  await assert.rejects(running, { name: "AbortError" });
  assert.ok(workers.every((worker) => worker.terminated));
});

test("an engine error reaches the caller", async () => {
  await assert.rejects(runAnalysis({ ...inputs, runs: [] }, { createWorker: () => fakeWorker([]) }), /at least one run/);
});

// fP of an old-school SamSrf HRF fit: peak and undershoot delays, their ratio, and the amplitude.
const FP = [5.5, 15.5, 5, 2];
const hrfFit = (variables = { fP: { dims: [1, 4], data: FP } }) => ({ name: "hrf_test.mat", bytes: matFile(variables) });
const analyse = (overrides, onLog) => runAnalysis({ ...inputs, ...overrides }, { createWorker: () => fakeWorker([]), onLog });
const fileBytes = (result) => result.files.map(({ name, bytes }) => [name, Buffer.from(bytes).toString("base64")]);

test("a subject HRF fit gives the engine SamSrf's old-school kernel", async () => {
  const lines = [];
  const subject = await analyse({ model: { ...model, Hrf: "hrf_test" }, subjectHrf: hrfFit() }, (line) => lines.push(line));
  const kernel = await analyse({ model: { ...model, Hrf: Array.from(hrf.oldSchool(model.TR, FP)) } });
  const canonical = await analyse({ model: { ...model, Hrf: 0 } });
  assert.deepEqual(fileBytes(subject), fileBytes(kernel));
  assert.notDeepEqual(fileBytes(subject), fileBytes(canonical));
  assert.ok(lines.includes(`Subject HRF hrf_test.mat: fP ${FP.join(", ")}`), lines.join("\n"));
});

test("a subject HRF fit that is missing or malformed stops the run with the file named", async () => {
  const named = { ...model, Hrf: "hrf_test" };
  await assert.rejects(analyse({ model: named }), /Add the subject HRF hrf_test\.mat/);
  await assert.rejects(analyse({ model: named, subjectHrf: { name: "hrf_test.mat", bytes: new TextEncoder().encode("not a MAT file") } }), /^Error: hrf_test\.mat: /);
  await assert.rejects(analyse({ model: named, subjectHrf: hrfFit({ beta: { dims: [1, 4], data: FP } }) }), /hrf_test\.mat: .*fP/);
  await assert.rejects(analyse({ model: named, subjectHrf: hrfFit({ fP: { dims: [1, 3], data: FP.slice(0, 3) } }) }), /hrf_test\.mat: .*fP has 3 values/);
  await assert.rejects(analyse({ model: { ...model, Hrf: "lh_hrf_fits" }, subjectHrf: hrfFit() }), /Hrf lh_hrf_fits is a vertex-wise HRF fit map: the caller must load it/);
});
