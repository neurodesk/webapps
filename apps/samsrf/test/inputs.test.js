import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyFile, displaySurface, emptyInputs, mergeInputs, missingInputs, sortFiles } from "../src/inputs.js";

const file = (name) => ({ name });

test("files of a SamSrf data folder find their slots by name", () => {
  const cases = {
    "lh_uBars1.gii": { slot: "runs" },
    "aps_Bars.mat": { slot: "apertures" },
    "aps_Bars.nii.gz": { slot: "apertures" },
    "bars.gif": { slot: "apertures" },
    "lh.V123.label": { slot: "roi" },
    "lh.V1_seed.label": { slot: "seed" },
    "lh_benson.gii": { slot: "template" },
    "lh.white": { slot: "surfaces", role: "white" },
    "lh.inflated": { slot: "surfaces", role: "inflated" },
    "lh.inflated.gii": { slot: "surfaces", role: "inflated" },
    "lh.midthickness.surf.gii": { slot: "surfaces", role: "mesh" },
    "lh.curv": { slot: "surfaces", role: "curv" },
    "lh.area": { slot: "surfaces", role: "area" },
    "2dGaussian.json": { slot: "model" },
    "hrf_sub01.mat": { slot: "subjectHrf" },
    "HRF_sub01.MAT": { slot: "subjectHrf" },
    "sub01_hrf.mat": { slot: "apertures" },
  };
  for (const [name, expected] of Object.entries(cases)) assert.deepEqual(classifyFile(name), expected, name);
  assert.equal(classifyFile("notes.txt"), null);
});

test("runs keep MATLAB character order and unknown files are reported", () => {
  const { filled, ignored } = sortFiles(["lh_uBars10.gii", "lh_uBars2.gii", "lh_uBars1.gii", "README.md"].map(file));
  assert.deepEqual(filled.runs.map(({ name }) => name), ["lh_uBars1.gii", "lh_uBars10.gii", "lh_uBars2.gii"]);
  assert.deepEqual(ignored, ["README.md"]);
});

test("a later drop replaces only the slots it fills", () => {
  const first = mergeInputs(emptyInputs(), sortFiles(["lh_uBars1.gii", "aps_Bars.mat", "lh.white"].map(file)).filled);
  const second = mergeInputs(first, sortFiles(["lh.inflated", "lh.V123.label"].map(file)).filled);
  assert.equal(second.apertures.name, "aps_Bars.mat");
  assert.equal(second.roi.name, "lh.V123.label");
  assert.deepEqual(Object.keys(second.surfaces), ["white", "inflated"]);
  assert.equal(displaySurface(second.surfaces).name, "lh.inflated", "the inflated surface is drawn when there is one");
});

test("each analysis names what it still needs", () => {
  const inputs = emptyInputs();
  assert.deepEqual(missingInputs("prf", {}, inputs), ["runs", "apertures"]);
  assert.deepEqual(missingInputs("cf", {}, inputs), ["runs", "a template map", "a seed label", "a surface area file"]);
  inputs.runs = [file("lh_uBars1.gii")];
  inputs.apertures = file("aps_Bars.mat");
  assert.deepEqual(missingInputs("rc", {}, inputs), []);
  Object.assign(inputs, { template: file("t.gii"), seed: file("s.label"), surfaces: { area: file("lh.area") } });
  assert.deepEqual(missingInputs("cf", { Smoothing: 2 }, inputs), ["a white surface"], "smoothing needs geodesic distances");
});

test("a model that names a subject HRF fit needs that file, and a folder brings it with the apertures", () => {
  const { filled } = sortFiles(["lh_uBars1.gii", "aps_Bars.mat", "hrf_sub01.mat"].map(file));
  assert.equal(filled.apertures.name, "aps_Bars.mat");
  assert.equal(filled.subjectHrf.name, "hrf_sub01.mat");
  const inputs = mergeInputs(emptyInputs(), { runs: filled.runs, apertures: filled.apertures });
  for (const analysis of ["prf", "rc"]) {
    assert.deepEqual(missingInputs(analysis, { Hrf: "hrf_sub01" }, inputs), ["the subject HRF hrf_sub01.mat"]);
    assert.deepEqual(missingInputs(analysis, { Hrf: "hrf_sub01" }, mergeInputs(inputs, { subjectHrf: filled.subjectHrf })), []);
  }
  assert.deepEqual(missingInputs("rc", { Hrf: "lh_hrf_fits" }, inputs), [], "a vertex-wise HRF map is left to the engine, which refuses it");
  assert.equal(emptyInputs().subjectHrf, null);
});


test("folder drops reject ambiguous single-file inputs before choosing anatomy", () => {
  for (const [names, slot] of [
    [["lh.white", "rh.white"], "white file"],
    [["lh_benson.gii", "rh_benson.gii"], "template map"],
    [["a.label", "b.label"], "ROI label"],
    [["a.json", "b.json"], "model JSON"],
    [["aps_a.mat", "aps_b.mat"], "apertures file"],
    [["lh.V1_seed.label", "lh.V2_seed.label"], "seed label"],
    [["hrf_a.mat", "hrf_b.mat"], "subject HRF fit"],
  ]) {
    assert.throws(() => sortFiles(names.map(file)), { message: `Choose one ${slot}: ${names[0]} and ${names[1]} are ambiguous.` });
  }
  assert.throws(() => sortFiles(["lh_run.gii", "rh_run.gii"].map(file)), /different hemispheres/);
});

test("inputs can switch hemispheres one slot at a time, with Run blocked until consistent", () => {
  const left = mergeInputs(emptyInputs(), sortFiles(["lh_run.gii", "aps.mat", "lh.V123.label"].map(file)).filled);
  const mixed = mergeInputs(left, { runs: [file("rh_run.gii")] });
  assert.equal(mixed.runs[0].name, "rh_run.gii");
  assert.match(missingInputs("prf", {}, mixed).join(", "), /matching hemispheres/);
  const right = mergeInputs(mixed, { roi: file("rh.V123.label") });
  assert.deepEqual(missingInputs("prf", {}, right), []);
});
