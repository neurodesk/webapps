import assert from "node:assert/strict";
import test from "node:test";
import { APP, LABEL_COLORS, THRESHOLD_RANGE, labelColormap, legendOf, normalizeThreshold } from "../src/config.js";

test("APP and THRESHOLD_RANGE expose AURORA defaults", () => {
  assert.equal(APP.id, "aurora");
  assert.equal(THRESHOLD_RANGE.default, 0.5);
  assert.equal(normalizeThreshold("0.5"), 0.5);
  assert.equal(normalizeThreshold(0.35), 0.35);
  assert.throws(() => normalizeThreshold(0), /between 0\.05 and 0\.95/);
  assert.throws(() => normalizeThreshold(1), /between 0\.05 and 0\.95/);
});

test("labelColormap and legendOf cover both AURORA regions", () => {
  const cmap = labelColormap();
  assert.deepEqual(cmap.I, [0, 1, 2]);
  assert.equal(cmap.R.length, 3);
  assert.equal(cmap.A[0], 0);
  assert.equal(cmap.A[1], 255);
  assert.equal(cmap.A[2], 255);
  assert.ok(LABEL_COLORS[1] && LABEL_COLORS[2]);

  const { labels, metrics } = legendOf([
    { id: "1", name: "Peritumoral oedema", voxels: 1000, ml: 1.0 },
    { id: "2", name: "Metastasis (enhancing + necrosis)", voxels: 2500, ml: 2.5 },
    { id: "WL", name: "Whole lesion (labels 1 + 2)", voxels: 3500, ml: 3.5 },
  ]);
  assert.equal(labels.length, 2);
  assert.deepEqual(metrics.labelVolumes, { 1: 1.0, 2: 2.5 });
});
