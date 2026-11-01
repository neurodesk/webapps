import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { readMatTransform, writeMatTransform } from "../src/index.js";

const fixtures = new URL("../../../exes/dwi/hmc/tests/fixtures/", import.meta.url);
const expected = JSON.parse(await readFile(new URL("expected.json", fixtures), "utf8"));

test("native float and double transforms read exactly from byte-offset views", async () => {
  for (const name of ["ants-float.mat", "ants-double.mat"]) {
    const bytes = await readFile(new URL(name, fixtures));
    const padded = new Uint8Array(bytes.length + 10);
    padded.set(bytes, 5);
    const want = expected[name];
    assert.deepEqual(readMatTransform(padded.subarray(5, -5)), {
      transform: want.name,
      parameters: want.parameters,
      fixed: want.fixed,
    });
  }
});

test("writeMatTransform writes an ITK double transform byte for byte", async () => {
  const bytes = new Uint8Array(await readFile(new URL("ants-double.mat", fixtures)));
  assert.deepEqual(writeMatTransform(readMatTransform(bytes)), bytes);
  assert.throws(() => writeMatTransform({ transform: "AffineTransform_double_3_3", parameters: [NaN], fixed: [] }), /not finite/);
});

test("zero-size fixed matrices remain supported in both precisions", async () => {
  for (const [name, fixedAt] of [["ants-float.mat", 94], ["ants-double.mat", 143]]) {
    const bytes = await readFile(new URL(name, fixtures));
    for (const [rows, columns] of [[0, 1], [1, 0], [0, 0]]) {
      const empty = Uint8Array.from(bytes.subarray(0, fixedAt + 26));
      const view = new DataView(empty.buffer);
      view.setInt32(fixedAt + 4, rows, true);
      view.setInt32(fixedAt + 8, columns, true);
      const want = expected[name];
      assert.deepEqual(readMatTransform(empty), { transform: want.name, parameters: want.parameters, fixed: [] });
    }
  }
});

test("malformed matrix headers are refused without stalling the caller", async () => {
  const header = (fields, tail = []) => {
    const bytes = new Uint8Array(20 + tail.length);
    const view = new DataView(bytes.buffer);
    fields.forEach((value, index) => view.setInt32(index * 4, value, true));
    bytes.set(tail, 20);
    return bytes;
  };
  const cases = [
    [header([0, 0, 0, 0, -20]), /name length/],
    [header([0, 0, 0, 0, 0]), /name length/],
    [header([0, -1, 1, 0, 2], [65, 0]), /dimensions/],
    [header([0, 1, -1, 0, 2], [65, 0]), /dimensions/],
    [header([0, 0, 0, 0, 2147483647]), /Truncated MATLAB matrix name/],
    [header([0, 0, 0, 0, 2], [65]), /Truncated MATLAB matrix name/],
    [header([0, 0, 0, 0, 2], [65, 65]), /matrix name/],
    [header([0, 2147483647, 2147483647, 0, 2], [65, 0]), /Truncated MATLAB matrix/],
    [header([10, 2, 1, 0, 2], [65, 0, 0, 0, 0, 0]), /Truncated MATLAB matrix/],
  ];
  // A worker keeps the non-advancing-offset regression bounded even if validation is removed.
  const worker = new Worker(`
    const { parentPort, workerData } = require("node:worker_threads");
    (async () => {
      const { readMatTransform } = await import(workerData.module);
      parentPort.postMessage({ ready: true });
      const errors = workerData.cases.map((bytes) => {
        try {
          readMatTransform(bytes);
          return null;
        } catch (error) {
          return error.message;
        }
      });
      parentPort.postMessage({ errors });
    })().catch((error) => { throw error; });
  `, { eval: true, workerData: { module: new URL("../src/index.js", import.meta.url).href, cases: cases.map(([bytes]) => bytes) } });
  let timer;
  try {
    const errors = await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("MAT parser worker did not start.")), 10000);
      worker.on("error", reject);
      worker.on("message", (message) => {
        clearTimeout(timer);
        if (message.ready) timer = setTimeout(() => reject(new Error("readMatTransform stalled on a malformed header.")), 1000);
        else resolve(message.errors);
      });
    });
    assert.equal(errors.length, cases.length);
    errors.forEach((error, index) => assert.match(error, cases[index][1], `malformed header ${index}`));
  } finally {
    clearTimeout(timer);
    await worker.terminate();
  }
});
