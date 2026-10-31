import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { APP, conversionOptions, resultRows, shortLabel } from "../src/config.js";

test("app id is lowercase kebab-case and frozen", () => {
  assert.match(APP.id, /^[a-z][a-z0-9-]*$/);
  assert.ok(Object.isFrozen(APP));
});

test("conversion options trim labels and coerce flags", () => {
  assert.deepEqual(conversionOptions({ subject: " 01 ", anonymize: 1 }), {
    subject: "01", session: "", anonymize: true, shiftDates: false, keepDerivatives: false,
  });
});

test("result rows list the ZIP first, then files by path; only NIfTI is viewable", () => {
  const tree = new Map([["sub-1/anat/sub-1_T1w.json", new Blob(["{}"])], ["sub-1/anat/sub-1_T1w.nii.gz", new Blob(["x"])]]);
  const rows = resultRows(tree, new File([], "bids.zip"));
  assert.deepEqual(Object.keys(rows), ["bids.zip", "sub-1/anat/sub-1_T1w.json", "sub-1/anat/sub-1_T1w.nii.gz"]);
  assert.deepEqual(Object.values(rows).map((row) => row.viewable), [false, false, true]);
  assert.equal(rows["sub-1/anat/sub-1_T1w.nii.gz"].file.name, "sub-1_T1w.nii.gz");
});

test("short labels keep the folder and drop entities the folders state", () => {
  assert.equal(shortLabel("sub-01/ses-1/anat/sub-01_ses-1_acq-tfl3_T1w.nii.gz"), "anat/acq-tfl3_T1w.nii.gz");
  assert.equal(shortLabel("sub-01/func/sub-01_task-rest_bold.json"), "func/task-rest_bold.json");
  assert.equal(shortLabel("README"), "README");
});

// @niivue/reproin is the reproin-rs v0.1.20261030 release tarball, pinned by URL and pnpm-lock integrity.
test("the released runtime bundles the published converter and keeps provenance", () => {
  const root = new URL(".", import.meta.resolve("@niivue/reproin"));
  assert.equal(JSON.parse(readFileSync(new URL("package.json", root), "utf8")).version, "0.1.20261030");
  // @niivue/dcm2niix 1.4.20261029, unchanged; only its worker keeps the hidden provenance file the post-pass needs.
  assert.equal(createHash("sha256").update(readFileSync(new URL("dcm2niix/dcm2niix.jpeg.wasm", root))).digest("hex"), "782c20d8e213c0ae14e0de9ae7164ac1e23a13bb8450528d36d8f832201ce178");
  assert.match(readFileSync(new URL("dcm2niix/worker.jpeg.js", root), "utf8"), /\.reproin_provenance\.tsv/);
});
