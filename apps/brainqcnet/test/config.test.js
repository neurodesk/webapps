// DOM-independent unit test (Node, no browser). Browser behaviour is covered by the
// Playwright tests in e2e/; Node tests must not import modules that touch `document`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { summarize } from "@neurodesk/brainqcnet/summary";
import { APP, SETTINGS, mapName, qualitySettings, reportFiles, verdictRows, verdictStatus, volumeRefusal } from "../src/config.js";

const reference = async (id) => JSON.parse(await readFile(new URL(`../../../packages/brainqcnet/validation/references/${id}.json`, import.meta.url), "utf8"));
const referenceSummary = (slices, options) => summarize(slices.map(({ axis, slice, pred }) => ({ axis, slice, pred })), options);
const tOf = (tot) => Number(tot.split("\n")[1].split(",")[2]);

test("app config is frozen and named for the catalog", () => {
  assert.equal(APP.id, "brainqcnet");
  assert.equal(APP.title, "BrainQCNet");
  assert.ok(Object.isFrozen(APP) && Object.isFrozen(SETTINGS));
});

test("settings default to the BIDS app's options and refuse values it would not take", () => {
  assert.deepEqual(qualitySettings(), { method: "percentage", areas: 3, backend: "auto" });
  assert.deepEqual(qualitySettings({ method: "median", areas: 5, backend: "wasm" }), { method: "median", areas: 5, backend: "wasm" });
  assert.throws(() => qualitySettings({ method: "max" }), /percentage, mean, median/);
  for (const areas of [0, 11, 2.5, Number.NaN]) assert.throws(() => qualitySettings({ areas }), /from 1 to 10/);
  assert.throws(() => qualitySettings({ backend: "webgl" }), /backend/);
});

test("only one 3D volume is accepted", () => {
  assert.equal(volumeRefusal({ dimensionality: 3, frames: 1, dims: [176, 256, 256] }), null);
  assert.match(volumeRefusal({ dimensionality: 4, frames: 20, dims: [64, 64, 30, 20] }), /20 volumes/);
  assert.match(volumeRefusal({ dimensionality: 2, frames: 1, dims: [256, 256] }), /not a 3D volume/);
});

for (const id of ["sub-000103-standard", "sub-000103-headmotion2"]) {
  test(`${id}: each download role carries its own table of the original's`, async () => {
    const { input, slices, files } = await reference(id);
    const t = tOf(files["tot_df.csv"]);
    const tables = reportFiles(input.name, referenceSummary(slices), t);
    const stem = input.name.replace(/\.nii\.gz$/, "");
    assert.deepEqual(Object.fromEntries(Object.entries(tables).map(([role, { name, label, text }]) => [role, [name, label, text]])), {
      table: [`${stem}_table.csv`, "table.csv · every slice", files["table.csv"]],
      summary: [`${stem}_tot_df.csv`, "tot_df.csv · summary", files["tot_df.csv"]],
      xAreas: [`${stem}_x_results_locally.csv`, "x_results_locally.csv · x areas", files["x_results_locally.csv"]],
      yAreas: [`${stem}_y_results_locally.csv`, "y_results_locally.csv · y areas", files["y_results_locally.csv"]],
      zAreas: [`${stem}_z_results_locally.csv`, "z_results_locally.csv · z areas", files["z_results_locally.csv"]],
    });
    assert.equal(mapName(input.name), `${stem}_flaggedslices.nii.gz`);
  });
}

test("the verdict states the original's decision and fractions", async () => {
  const still = referenceSummary((await reference("sub-000103-standard")).slices);
  const motion = referenceSummary((await reference("sub-000103-headmotion2")).slices);
  assert.equal(verdictStatus(still), "No artifact detected · slices flagged 31 %");
  assert.equal(verdictStatus(motion), "Artifact detected · slices flagged 67 %");
  const rows = verdictRows(motion);
  assert.deepEqual(rows.map((row) => row.label), ["Verdict", "Slices flagged", "x slices", "y slices", "z slices"]);
  assert.equal(rows.filter((row) => row.flag).length, 1);
  for (const [index, axis] of ["x", "y", "z"].entries()) {
    const { proba, pred } = motion.axes[axis];
    assert.equal(rows[index + 2].value, `${Math.round(proba * 100)} % · ${pred ? "artifact" : "no artifact"}`);
  }
  const median = verdictRows(referenceSummary((await reference("sub-000103-standard")).slices, { method: "median" }));
  assert.equal(median[1].label, "Median prediction");
  assert.match(median[1].value, /^[01]\.\d\d$/);
});

test("a name without BIDS entities keeps its stem", () => {
  assert.equal(mapName("T1.nii"), "T1_flaggedslices.nii.gz");
  assert.equal(reportFiles("scan.nii.gz", referenceSummary([
    ...[0, 1, 2, 3, 4, 5, 6].flatMap((slice) => ["x", "y", "z"].map((axis) => ({ axis, slice, pred: slice % 2 }))),
  ]), 1).table.name, "scan_table.csv");
});
