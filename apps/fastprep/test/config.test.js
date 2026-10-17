import { test } from "node:test";
import assert from "node:assert/strict";
import { bidsPath, datasetPaths, reportWithLinks } from "../src/config.js";

test("a chosen dataset folder's own name is dropped", () => {
  assert.deepEqual(datasetPaths(["demo/dataset_description.json", "demo/sub-01/anat/sub-01_T1w.nii.gz"]), [
    "dataset_description.json",
    "sub-01/anat/sub-01_T1w.nii.gz",
  ]);
  assert.deepEqual(datasetPaths(["sub-01/func/a.nii.gz", "dataset_description.json"]), ["sub-01/func/a.nii.gz", "dataset_description.json"]);
});

test("loose files are placed by their BIDS name", () => {
  assert.equal(bidsPath("sub-01_T1w.nii.gz"), "sub-01/anat/sub-01_T1w.nii.gz");
  assert.equal(bidsPath("sub-01_ses-2_task-motor_run-1_bold.json"), "sub-01/ses-2/func/sub-01_ses-2_task-motor_run-1_bold.json");
  assert.equal(bidsPath("sub-01_task-motor_events.tsv"), "sub-01/func/sub-01_task-motor_events.tsv");
  assert.equal(bidsPath("sub-01_dir-AP_epi.nii.gz"), "sub-01/fmap/sub-01_dir-AP_epi.nii.gz");
  assert.equal(bidsPath("dataset_description.json"), "dataset_description.json");
  assert.deepEqual(datasetPaths(["sub-01_T1w.nii.gz", "dataset_description.json"]), ["sub-01/anat/sub-01_T1w.nii.gz", "dataset_description.json"]);
});

test("report links resolve to in-memory files; anchors and unknown links stay", () => {
  const enc = (s) => new TextEncoder().encode(s);
  const outputs = [
    ["sub-01.html", enc('<img src="sub-01/figures/00.png"><a href="#steps">x</a><a href="sub-01_task.html">t</a><a href="missing.nii.gz">m</a>')],
    ["sub-01/figures/00.png", enc("png")],
    ["sub-01_task.html", enc('<img src="sub-01/figures/00.png"><a href="sub-01.html">back</a>')],
  ];
  const made = [];
  const html = reportWithLinks("sub-01.html", outputs, (bytes) => `blob:${made.push(bytes) - 1}`);
  // the figure is made once; the task page's link back to the page being built returns through history
  assert.equal(html, '<img src="blob:0"><a href="#steps">x</a><a href="blob:1">t</a><a href="missing.nii.gz">m</a>');
  assert.equal(made.length, 2);
  assert.equal(made[1], '<img src="blob:0"><a href="javascript:history.back()">back</a>');
});
