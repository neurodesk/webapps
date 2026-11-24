import assert from "node:assert/strict";
import test from "node:test";
import {
  APP,
  TUMOUR_TYPE_LABELS,
  brainColormap,
  formatRegionName,
  formatTractName,
  geometryMatches,
  modeHint,
  runButtonLabel,
  statusSummary,
  tumourColormap,
} from "../src/config.js";

test("APP identity and tumour types are defined", () => {
  assert.equal(APP.id, "tumour-report");
  assert.equal(APP.title, "Brain Tumour Report");
  assert.equal(TUMOUR_TYPE_LABELS.glioblastoma, "Glioblastoma (T1c)");
  assert.equal(TUMOUR_TYPE_LABELS.meningioma, "Meningioma (T1c)");
  assert.equal(TUMOUR_TYPE_LABELS.metastasis, "Brain metastasis (T1c)");
});

test("modeHint stays within the 90-character visible-help limit", () => {
  const cases = [
    { hasT1c: false, hasMask: false, computeMniReport: true, skullStripped: false },
    { hasT1c: true, hasMask: false, computeMniReport: true, skullStripped: false },
    { hasT1c: true, hasMask: false, computeMniReport: false, skullStripped: true },
    { hasT1c: true, hasMask: true, computeMniReport: true, skullStripped: false },
    { hasT1c: true, hasMask: true, computeMniReport: false, skullStripped: false },
  ];
  for (const params of cases) {
    const hint = modeHint(params);
    assert.ok(hint.length > 0 && hint.length <= 90, `hint too long (${hint.length}): ${hint}`);
  }
});

test("runButtonLabel adapts to supplied-mask mode", () => {
  assert.equal(runButtonLabel({ hasMask: false }), "Segment & characterize");
  assert.equal(runButtonLabel({ hasMask: true }), "Characterize mask");
});

test("colormaps declare transparent background and visible label", () => {
  for (const map of [tumourColormap(), brainColormap()]) {
    assert.equal(map.A[0], 0);
    assert.ok(map.A[1] > 0);
    assert.equal(map.labels.length, 2);
  }
});

test("region and tract names format cleanly", () => {
  assert.equal(formatRegionName("frontal_left"), "Frontal (L)");
  assert.equal(formatRegionName("parietal_right"), "Parietal (R)");
  assert.equal(formatRegionName("brain_stem_"), "Brain stem");
  assert.equal(formatTractName("Cortico_Spinal_left"), "Cortico Spinal (L)");
  assert.equal(formatTractName("Anterior_Commissure"), "Anterior Commissure");
});

test("statusSummary handles empty, single and multifocal reports", () => {
  assert.equal(statusSummary({ morphometry: { lesionCount: 0, totalVolumeMl: 0 } }), "Report ready · No lesions segmented");
  assert.equal(statusSummary({ morphometry: { lesionCount: 1, totalVolumeMl: 4.56 } }), "Report ready · 1 lesion · 4.6 mL");
  assert.equal(statusSummary({ morphometry: { lesionCount: 3, totalVolumeMl: 12.18 } }), "Report ready · 3 lesions · 12.2 mL");
});

test("geometryMatches compares dims and full 4x4 affine matrices", () => {
  const base = [[1, 0, 0, -10], [0, 1, 0, -20], [0, 0, 1, -30], [0, 0, 0, 1]];
  const translated = [[1, 0, 0, 32], [0, 1, 0, -20], [0, 0, 1, -30], [0, 0, 0, 1]];
  const scaled = [[2, 0, 0, -10], [0, 1, 0, -20], [0, 0, 1, -30], [0, 0, 0, 1]];
  assert.equal(geometryMatches({ dims: [64, 64, 40], affine: base }, { dims: [64, 64, 40], affine: base }), true);
  assert.equal(geometryMatches({ dims: [64, 64, 40], affine: base }, { dims: [64, 64, 41], affine: base }), false);
  assert.equal(geometryMatches({ dims: [64, 64, 40], affine: base }, { dims: [64, 64, 40], affine: translated }), false);
  assert.equal(geometryMatches({ dims: [64, 64, 40], affine: base }, { dims: [64, 64, 40], affine: scaled }), false);
});
