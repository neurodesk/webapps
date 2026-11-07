import { test } from "node:test";
import assert from "node:assert/strict";
import { APP, classifyFiles, outputNames, runSettings, runSummary, workerVolume } from "../src/config.js";

const file = (name) => ({ name });

test("app id is lowercase kebab-case and the config is frozen", () => {
  assert.match(APP.id, /^[a-z][a-z0-9-]*$/);
  assert.ok(Object.isFrozen(APP));
});

test("files split into one MRI and sections in natural name order", () => {
  const { mri, sections } = classifyFiles([file("s10.tif"), file("brain.nii.gz"), file("s2.PNG"), file("s1.jpeg")]);
  assert.equal(mri.name, "brain.nii.gz");
  assert.deepEqual(sections.map((entry) => entry.name), ["s1.jpeg", "s2.PNG", "s10.tif"]);
  assert.equal(classifyFiles([file("a.tiff")]).mri, null);
  assert.throws(() => classifyFiles([file("a.nii"), file("b.nii.gz")]), /one MRI/);
  assert.throws(() => classifyFiles([file("notes.txt")]), /notes.txt is not/);
});

test("output names keep the section's name without its extension", () => {
  const names = outputNames("slide 150.ome.tif");
  assert.equal(names.warped, "slide_150_warped_rgba.nii.gz");
  assert.equal(names.affine, "slide_150_affine.mat");
  assert.equal(outputNames("x.jpg").registration, "x_registration.json");
});

test("run settings check the slice range, section spacing and options", () => {
  const dims = [100, 80, 60];
  const settings = runSettings({ axis: "2", index: "30", step: "2", tiltA: "1", tiltB: "-2", contrast: "eosin", orientation: "5", pixelSize: "", refinePlane: false, deformable: true }, dims, 3);
  assert.deepEqual(settings.plane, { axis: 2, index: 30, step: 2, tilt: [1, -2] });
  assert.equal(settings.options.orientation, 5);
  assert.equal(settings.options.pixelSize, null);
  assert.equal(settings.options.refinePlane, false);
  assert.throws(() => runSettings({ axis: 2, index: 60 }, dims), /between 0 and 59/);
  assert.throws(() => runSettings({ axis: 2, index: 50, step: 5 }, dims, 3), /last section is outside/);
  assert.throws(() => runSettings({ axis: 2, index: 1, tiltA: 40 }, dims), /−30 and 30/);
  assert.throws(() => runSettings({ axis: 2, index: 1, pixelSize: -3 }, dims), /positive/);
  assert.throws(() => runSettings({ axis: 2, index: 1, contrast: "red" }, dims), /Unknown contrast/);
  assert.throws(() => runSettings({ axis: 4, index: 1 }, dims), /i, j or k/);
});

test("an MRI grid above the colour-copy limit leaves out only that output, with a warning", () => {
  const dims = [100, 80, 60];
  const full = runSettings({ axis: 2, index: 30 }, dims);
  assert.equal(full.volumeOutput, true);
  assert.deepEqual(full.warnings, []);
  const limited = runSettings({ axis: 2, index: 30 }, dims, 1, { maxVolumeBytes: 100 * 80 * 60 * 4 - 1 });
  assert.equal(limited.volumeOutput, false);
  assert.match(limited.warnings[0], /too large for a colour copy.*written without it/);
  assert.deepEqual(limited.plane, full.plane);
  assert.deepEqual(limited.options, full.options);
});

test("the worker gets shared voxels as they are and a transferred copy otherwise", (t) => {
  const shared = new Float32Array(new SharedArrayBuffer(16));
  const sharedVolume = { dims: [2, 2, 1], data: shared };
  assert.deepEqual(workerVolume(sharedVolume), { volume: sharedVolume, transfer: [] });
  const data = Float32Array.of(1, 2, 3, 4);
  const posted = workerVolume({ dims: [2, 2, 1], data });
  assert.notEqual(posted.volume.data, data);
  assert.deepEqual(posted.transfer, [posted.volume.data.buffer]);
  // A page that is not cross-origin isolated has no SharedArrayBuffer constructor.
  const original = Object.getOwnPropertyDescriptor(globalThis, "SharedArrayBuffer");
  delete globalThis.SharedArrayBuffer;
  t.after(() => Object.defineProperty(globalThis, "SharedArrayBuffer", original));
  const isolated = workerVolume({ dims: [2, 2, 1], data });
  assert.deepEqual(Array.from(isolated.volume.data), [1, 2, 3, 4]);
  assert.deepEqual(isolated.transfer, [isolated.volume.data.buffer]);
});

test("the end-of-run status says when the MRI-grid copy was skipped", () => {
  const reports = [{ nmi: { final: 0.31234 } }, { nmi: { final: 0.25 } }];
  const dims = [100, 80, 60];
  assert.equal(runSummary(reports, runSettings({ axis: 2, index: 30 }, dims, 2)), "Registered 2 sections; NMI 0.312, 0.250");
  const skipped = runSummary(reports.slice(0, 1), runSettings({ axis: 2, index: 30 }, dims, 1, { maxVolumeBytes: 1 }));
  assert.match(skipped, /^Registered 1 section; NMI 0\.312; MRI grid too large, its colour copy was skipped$/);
});
