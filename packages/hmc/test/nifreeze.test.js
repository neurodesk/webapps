import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createNiftiFromData } from "@neurodesk/webapp-components/file-io/nifti";
import { correctNiFreeze, nifreezeOrder } from "../src/nifreeze.js";
import { readSeries, IDENTITY } from "../src/pipeline.js";
import { loadHmcNode, gzip } from "../src/node.js";
import { makeSeries } from "./synthetic.js";

const fixture = JSON.parse(readFileSync(new URL("../../../exes/dwi/hmc/tests/fixtures/clip.json", import.meta.url), "utf8")).cases.float64;

function identityRuntime(hmc) {
  return {
    workers: 1, gzip,
    spawn: () => ({
      onmessage: null, terminate() {},
      postMessage(message) {
        const outputs = message.argv[0] === "--apply"
          ? { "resampled.nii": message.inputs["volume.nii"] }
          : { "out0GenericAffine.mat": hmc.writeMat(IDENTITY) };
        queueMicrotask(() => this.onmessage?.({ data: { id: message.id, outputs } }));
      },
    }),
  };
}

test("the trivial loop clips shared float bzero in visit order and keeps every output volume", async () => {
  const dims = [...fixture.shape].reverse();
  const values = Float32Array.from([...fixture.input, ...fixture.input, ...fixture.input]);
  const header = (await readSeries(makeSeries().nifti)).headerBytes;
  const series = await readSeries(createNiftiFromData(values, header, { dims: [...dims, 3] }));
  const hmc = await loadHmcNode();
  const predictions = [];
  const result = await correctNiFreeze({
    series, model: "trivial", seed: 1234, visitOrder: [1, 0],
    bvals: [0, 1000, 1000], bvecs: [[0, 1, 0], [0, 0, 1], [0, 0, 0]],
    mask: new Uint8Array(fixture.input.length).fill(1),
    hmc, runtime: identityRuntime(hmc), fileName: "sub-01_dwi.nii.gz",
    onPrediction: ({ index, volume }) => predictions.push({ index, values: [...volume] }),
  });
  assert.deepEqual(predictions, [{ index: 1, values: fixture.first }, { index: 0, values: fixture.second }]);
  assert.deepEqual(result.registered, [false, true, true]);
  assert.equal(result.transforms.length, 3);
  const metadata = JSON.parse(new TextDecoder().decode(result.files[result.names.sidecar]));
  assert.equal(metadata.HeadMotionCorrection.Model, "trivial");
  assert.deepEqual(metadata.HeadMotionCorrection.Mask, {
    Source: "unspecified", Bytes: 360, Voxels: 360,
    SHA256: "76b2875461618e970a037f35eeb94af3911e11353a7e620c81e49b9756cda47b",
  });
  assert.deepEqual(metadata.HeadMotionCorrection.VisitOrder, [1, 0]);
  assert.equal(new TextDecoder().decode(result.files[result.names.motion]).trim().split("\n").length, 4);
});

test("the GP module uses the float64 b0 median and its reduced registration mask", async () => {
  const hmc = await loadHmcNode();
  const dims = [3, 3, 3];
  const nvox = 27;
  const frames = 10;
  const bvals = [0, 50, ...Array(8).fill(1000)];
  const bvecs = [Array(frames).fill(0), Array(frames).fill(0), Array(frames).fill(0)];
  const data = new Float32Array(nvox * frames);
  for (let i = 0; i < nvox; i++) {
    data[i] = i ? 500 + i : 0;
    data[nvox + i] = i ? 700 + i : 0;
  }
  for (let v = 2; v < frames; v++) {
    const z = -0.9 + 1.8 * (v - 2) / 7;
    const phase = 2.399963 * (v - 2);
    const r = Math.sqrt(1 - z * z);
    const g = [r * Math.cos(phase), r * Math.sin(phase), z];
    for (let axis = 0; axis < 3; axis++) bvecs[axis][v] = g[axis];
    for (let i = 0; i < nvox; i++) data[v * nvox + i] = Math.round((600 + 9 * i) * Math.exp(-0.8 * (1 + g[0] ** 2)));
  }
  const options = { data, dims, frames, bvals, bvecs, mask: new Uint8Array(nvox).fill(1), model: "gp" };
  const model = hmc.createNifreezeModel(options);
  try {
    assert.deepEqual(model.b0Volumes, [0, 1]);
    assert.deepEqual(model.dwiVolumes, [2, 3, 4, 5, 6, 7, 8, 9]);
    assert.deepEqual([...model.bzero], [0, ...Array.from({ length: 26 }, (_, i) => 601 + i)]);
    assert.deepEqual([...model.mask], [0, ...Array(26).fill(1)]);
    const prediction = model.predict(0);
    assert.equal(prediction.volume.length, nvox);
    assert.equal(prediction.volume[0], 0);
    assert.ok(prediction.volume.every(value => Number.isInteger(value) && value >= 0 && value <= 255));
    assert.equal(prediction.fit.theta.length, 3);
    assert.throws(() => hmc.createNifreezeModel(options), /already active/);
  } finally { model.release(); }
  assert.throws(() => model.predict(0), /released/);
  hmc.createNifreezeModel(options).release();
});

test("visit order and registration argv are reproducible and record an explicit ANTs seed", async () => {
  assert.deepEqual(nifreezeOrder(8, 1234), nifreezeOrder(8, 1234));
  assert.deepEqual([...nifreezeOrder(8, 1234)].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7]);
  const hmc = await loadHmcNode();
  const args = hmc.nifreezeArguments(1234);
  assert.deepEqual(args.slice(-2), ["--random-seed", "1234"]);
  assert.deepEqual(args.slice(4, 6), ["--float", "1"]);
  assert.equal(args[args.indexOf("--output") + 1], "out");
  assert.throws(() => hmc.nifreezeArguments(0), /positive 32-bit signed integer/);
  assert.throws(() => hmc.nifreezeArguments(0x80000000), /positive 32-bit signed integer/);
});
