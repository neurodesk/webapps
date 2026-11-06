// DOM-independent unit test (Node, no browser). Browser behaviour is covered by the
// Playwright tests in e2e/; Node tests must not import modules that touch `document`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { APP, assignSequences, labelColormap, legendOf, modelChoice, sequenceFromName } from "../src/config.js";
import { MODELS } from "@neurodesk/gliomoda/models";

test("app config is frozen", () => {
  assert.ok(Object.isFrozen(APP));
});

test("sequences are read from BraTS, BraTS Toolkit and common file names", () => {
  const cases = {
    "BraTS-GLI-00001-000-t1c.nii.gz": "t1c",
    "BraTS-GLI-00001-000-t2f.nii.gz": "t2f",
    "BraTS-GLI-00001-000-t1n.nii.gz": "t1n",
    "BraTS-GLI-00001-000-t2w.nii.gz": "t2w",
    "BraTS2021_00000_t1ce.nii.gz": "t1c",
    "BraTS2021_00000_flair.nii.gz": "t2f",
    "BraTS2021_00000_t1.nii.gz": "t1n",
    "BraTS2021_00000_t2.nii.gz": "t2w",
    "TCGA-DU-7294_fla_bet.nii.gz": "t2f",
    "sub-01_ce-gadolinium_T1w.nii": "t1c",
    "sub-01_T1w.nii.gz": "t1n",
    "sub-01_FLAIR.nii.gz": "t2f",
    "case12.nii.gz": null,
    "t2star.nii.gz": null,
  };
  for (const [name, role] of Object.entries(cases)) assert.equal(sequenceFromName(name), role, name);
});

test("named files keep their sequence and unnamed files fill the free ones in order", () => {
  assert.deepEqual(assignSequences(["a_flair.nii.gz", "scan1.nii.gz", "scan2.nii.gz"]), {
    t2f: "a_flair.nii.gz",
    t1c: "scan1.nii.gz",
    t1n: "scan2.nii.gz",
  });
  assert.throws(() => assignSequences(["a_t1c.nii", "b_t1ce.nii"]), /both T1c images/);
  assert.throws(() => assignSequences(["1", "2", "3", "4", "5"]), /at most four/);
});

test("each sequence combination maps to its manifest model or says it has none", () => {
  const ids = MODELS.map(({ id }) => id);
  const roles = ["t1c", "t2f", "t1n", "t2w"];
  const missing = [];
  for (let mask = 1; mask < 16; mask++) {
    const chosen = roles.filter((_, k) => mask & (1 << k));
    const { id, hint } = modelChoice(chosen, ids);
    if (id) assert.equal(id, chosen.join("-"));
    else missing.push(hint);
  }
  assert.deepEqual(missing, [
    "GlioMODA has no T1 model. Add or remove a sequence.",
    "GlioMODA has no T1c + FLAIR + T1 model. Add or remove a sequence.",
    "GlioMODA has no T1c + FLAIR + T2 model. Add or remove a sequence.",
    "GlioMODA has no T1 + T2 model. Add or remove a sequence.",
  ]);
  assert.deepEqual(modelChoice(roles, ids, { resEncL: true }), { id: "t1c-t2f-t1n-t2w_ResEncL", hint: "Model: T1c + FLAIR + T1 + T2 (ResEncL)" });
  assert.equal(modelChoice(["t1c", "t2f"], ids, { resEncL: true }).id, "t1c-t2f");
  assert.equal(modelChoice(["t2w", "t1c"], ids).hint, "Model: T1c + T2");
  assert.equal(modelChoice([], ids).hint, "Load at least one of T1c, FLAIR, T1 or T2.");
});

test("the colour map and legend cover the three BraTS labels", () => {
  const colormap = labelColormap();
  assert.deepEqual(colormap.I, [0, 1, 2, 3]);
  assert.equal(colormap.A[0], 0);
  const { labels, metrics } = legendOf([{ id: "1", ml: 1.5 }, { id: "2", ml: 20 }, { id: "3", ml: 0.25 }, { id: "WT", ml: 21.75 }]);
  assert.deepEqual(labels.map(({ index }) => index), [1, 2, 3]);
  assert.deepEqual(metrics.labelVolumes, { 1: 1.5, 2: 20, 3: 0.25 });
});
