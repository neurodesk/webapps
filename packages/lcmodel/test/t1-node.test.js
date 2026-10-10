import test from "node:test";
import assert from "node:assert/strict";
import { syntheticNifti } from "../../../test-utils/nifti-fixture.mjs";
import { readT1, correctFromT1 } from "../src/t1-node.js";

const image = () => {
  const bytes = syntheticNifti({ dims: [4, 4, 4], spacing: [1, 1, 1], gzip: false });
  bytes.fill(0, 296, 328);
  bytes.writeFloatLE(1, 300);
  bytes.writeFloatLE(1, 320);
  return bytes;
};

test("T1 reading accepts gzip and refuses multiple images and a time series", async () => {
  const t1 = await readT1([{ name: "structural.nii.gz", bytes: syntheticNifti() }]);
  assert.deepEqual(t1.dims, [4, 4, 4]);
  await assert.rejects(readT1([{ name: "a.nii", bytes: image() }, { name: "b.nii", bytes: image() }]), /hold 2 images/);
  const dynamic = image();
  dynamic.writeInt16LE(4, 40);
  dynamic.writeInt16LE(2, 48);
  await assert.rejects(readT1([{ name: "dynamic.nii", bytes: dynamic }]), /single 3D volume/);
});

test("each dataset measures its own voxel on one segmentation and records its source", async () => {
  const t1 = await readT1([{ name: "structural.nii", bytes: image() }]);
  const gm = Float32Array.from({ length: 64 }, (_, index) => index % 4 < 2 ? 0.6004 : 0.2004);
  const wm = Float32Array.from({ length: 64 }, (_, index) => index % 4 < 2 ? 0.2702 : 0.6702);
  const segmentation = { ...t1, maps: { gm, wm, csf: new Float32Array(64) }, version: "0.1.20260925", backend: "cpu" };
  const run = (x, stem) => {
    const header = { fieldT: 3, teMs: 35, trMs: 2000, voxel: { affine: [[1, 0, 0, x], [0, 1, 0, 1], [0, 0, 1, 1], [0, 0, 0, 1]] } };
    const entry = { fit: { rows: [{ name: "NAA", concentration: 10 }], water: true, lcm: {}, ratioTo: "Cr" } };
    const files = correctFromT1(segmentation, entry, header, stem, true);
    return { entry, files, document: JSON.parse(files.find(file => file.name.endsWith(".json")).body) };
  };
  const first = run(0, "first");
  const second = run(3, "second");
  assert.equal(first.document.fractions.gm, 0.6 / 0.999);
  assert.ok(Math.abs(second.document.fractions.gm - 0.2 / 0.999) < 1e-12);
  assert.notEqual(first.document.concentrations[0].corrected, second.document.concentrations[0].corrected);
  assert.equal(first.document.fractionSource.backend, "cpu");
  assert.equal(first.document.fractionSource.t1, "structural.nii");
  assert.equal(first.document.fractionSource.version, "0.1.20260925");
  assert.equal(first.entry.fit.correction.source.kind, "segmentation");
  assert.ok(first.files.some(file => file.name === "first_voxel_mask.nii"));
  assert.ok(second.files.some(file => file.name === "second_voxel_mask.nii"));
});

test("DICOM series convert with the bundled dcm2niix and reject two series", async () => {
  const { dicomSeries } = await import("../../../test-utils/dicom-fixture.mjs");
  const files = options => dicomSeries(options).map(({ name, buffer }) => ({ name, bytes: buffer }));
  const t1 = await readT1(files({ extension: "" }));
  assert.deepEqual(t1.dims, [16, 16, 4]);
  assert.match(t1.name, /\.nii$/);
  await assert.rejects(readT1([...files({ series: 1 }), ...files({ series: 2 })]), /hold 2 images/);
});
