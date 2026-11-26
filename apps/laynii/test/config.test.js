import assert from "node:assert/strict";
import test from "node:test";
import {
  APP,
  SETTINGS,
  layniiSettings,
  outputFileName,
  profileSourceLabel,
  provenance,
  renderProfileSvg,
  stemName,
  volumeRefusal,
} from "../src/config.js";

test("APP and SETTINGS expose LayNii defaults", () => {
  assert.equal(APP.id, "laynii");
  assert.equal(SETTINGS.nrLayers.default, 3);
  assert.equal(SETTINGS.equivol.default, false);
  assert.equal(SETTINGS.iterSmooth.default, 100);
});

test("layniiSettings normalizes defaults and rejects out-of-range parameters", () => {
  assert.deepEqual(layniiSettings(), {
    nrLayers: 3,
    equivol: false,
    iterSmooth: 100,
    thickness: false,
    curvature: false,
    inclBorders: false,
    equalCounts: false,
    noSmooth: false,
  });
  assert.throws(() => layniiSettings({ nrLayers: 1 }), /from 2 to 100/);
  assert.throws(() => layniiSettings({ nrLayers: 101 }), /from 2 to 100/);
  assert.throws(() => layniiSettings({ iterSmooth: 0 }), /from 1 to 2000/);
});

test("volumeRefusal rejects 4D and oversized volumes", () => {
  assert.equal(volumeRefusal({ dimensionality: 3, frames: 1, dims: [130, 114, 107] }), null);
  assert.match(volumeRefusal({ dimensionality: 4, frames: 12, dims: [64, 64, 32] }), /12 volumes/);
  assert.match(volumeRefusal({ dimensionality: 3, frames: 1, dims: [300, 300, 100] }), /browser limit/);
});

test("outputFileName, profileSourceLabel, and provenance match native LayNii commands", () => {
  assert.equal(stemName("Ding2016_occip_rim.nii.gz"), "Ding2016_occip_rim");
  assert.equal(outputFileName("Ding2016_occip_rim.nii.gz", "layers_equidist"), "Ding2016_occip_rim_layers_equidist.nii.gz");
  assert.equal(profileSourceLabel("equivol"), "equivolume");
  assert.equal(profileSourceLabel("equidist"), "equidistant");
  assert.equal(profileSourceLabel("equicount"), "equal-count");
  const prov = provenance({
    rimName: "sc_rim.nii.gz",
    signalName: "sc_BOLD_act.nii.gz",
    settings: layniiSettings({ nrLayers: 10, equivol: true, thickness: true }),
    profileSource: "equivol",
  });
  assert.match(prov.nativeCommand, /^LN2_LAYERS -rim sc_rim\.nii\.gz -nr_layers 10 -equivol -iter_smooth 100 -thickness -output sc_rim\.nii\.gz && LN2_PROFILE -input sc_BOLD_act\.nii\.gz -layers sc_rim_layers_equivol\.nii\.gz -output sc_BOLD_act_profile\.txt$/);
});

test("renderProfileSvg emits accessible token-styled SVG and leaves gaps for empty layers", () => {
  const svg = renderProfileSvg([
    { layer: 1, mean: 10.2, std: 1.5, voxels: 100 },
    { layer: 2, mean: 20.4, std: 2.0, voxels: 120 },
    { layer: 3, mean: 35.1, std: 3.1, voxels: 90 },
  ]);
  assert.match(svg, /^<svg /);
  assert.match(svg, /Layer 1 \(WM\)/);
  assert.match(svg, /Layer 3 \(CSF\)/);
  assert.equal(/#[0-9a-f]{3,8}\b/i.test(svg), false);

  // Empty middle layer (voxels === 0) must not emit a circle or connect across the gap.
  const gapped = renderProfileSvg([
    { layer: 1, mean: 10, std: 1, voxels: 50 },
    { layer: 2, mean: 12, std: 1, voxels: 50 },
    { layer: 3, mean: 0, std: 0, voxels: 0 },
    { layer: 4, mean: 20, std: 1, voxels: 50 },
    { layer: 5, mean: 24, std: 1, voxels: 50 },
  ]);
  assert.equal((gapped.match(/<circle /g) || []).length, 4);
  assert.equal((gapped.match(/<polygon /g) || []).length, 2);
  assert.doesNotMatch(gapped, /Layer 3:/);
});
