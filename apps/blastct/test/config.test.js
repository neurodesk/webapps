import test from "node:test";
import assert from "node:assert/strict";
import { APP, CT_BRAIN_WINDOW, labelColormap, legendOf, normalizeBackend, outputName, stemName } from "../src/config.js";

test("BLAST-CT app metadata, CT display window, and naming helpers", () => {
  assert.equal(APP.id, "blastct");
  assert.equal(APP.title, "BLAST-CT");
  assert.deepEqual(CT_BRAIN_WINDOW, { min: 0, max: 80 });
  assert.equal(normalizeBackend("wasm"), "wasm");
  assert.equal(normalizeBackend("auto"), "auto");
  assert.equal(normalizeBackend("invalid"), "auto");
  assert.equal(stemName("scan_0_head_ct.nii.gz"), "scan_0_head_ct");
  assert.equal(stemName("patient scan 1.nii"), "patient_scan_1");
  assert.equal(outputName("scan_0_head_ct.nii.gz", "segmentation.nii.gz"), "scan_0_head_ct_blastct_segmentation.nii.gz");
  assert.equal(outputName("scan_0_head_ct.nii.gz", "volumes.csv"), "scan_0_head_ct_blastct_volumes.csv");
});

test("labelColormap and legendOf cover background + 4 TBI lesion classes", () => {
  const cmap = labelColormap();
  assert.deepEqual(cmap.I, [0, 1, 2, 3, 4]);
  assert.deepEqual(cmap.A, [0, 255, 255, 255, 255]);
  assert.equal(cmap.labels.length, 5);
  assert.match(cmap.labels[1], /IPH/);
  assert.match(cmap.labels[2], /EAH/);
  assert.match(cmap.labels[3], /Oedema/);
  assert.match(cmap.labels[4], /IVH/);

  const legend = legendOf({
    classes: [
      { id: 1, volumeMl: 48.09 },
      { id: 2, volumeMl: 23.6 },
      { id: 3, volumeMl: 62.72 },
      { id: 4, volumeMl: 0.33 },
    ],
  });
  assert.equal(legend.labels.length, 4);
  assert.deepEqual(legend.metrics.labelVolumes, { 1: 48.09, 2: 23.6, 3: 62.72, 4: 0.33 });
});
