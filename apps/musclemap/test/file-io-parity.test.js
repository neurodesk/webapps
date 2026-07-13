// Parity tests for the file-io tier extractions:
//   - isNiftiFile: shared detector must match MuscleMap's original rule (.nii / .nii.gz).
//   - downloadBlob/downloadFile: shared helpers must reproduce MuscleMap's original download
//     side effects (createObjectURL -> anchor[href,download] -> click -> remove -> revokeObjectURL).
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
  isNiftiFile,
  downloadBlob,
  downloadFile,
} from "../../../packages/components/src/file-io/index.js";

// MuscleMap's ORIGINAL isNiftiFile rule (from FileIOController before extraction), inlined here.
const originalIsNiftiFile = (file) => {
  const name = file.name.toLowerCase();
  return name.endsWith(".nii") || name.endsWith(".nii.gz");
};

test("shared isNiftiFile matches MuscleMap's original rule across filenames", () => {
  const names = [
    "scan.nii",
    "scan.nii.gz",
    "SCAN.NII.GZ",
    "Volume.Nii",
    "series.dcm",
    "meta.json",
    "noextension",
    "weird.niigz",
    "a.nii.gz.bak",
  ];
  for (const name of names) {
    const file = { name };
    assert.equal(isNiftiFile(file), originalIsNiftiFile(file), `mismatch for ${name}`);
  }
});

test("shared downloadBlob/downloadFile reproduce the original anchor-download side effects", () => {
  const dom = new JSDOM("<!doctype html><body></body>");
  const prevDoc = globalThis.document;
  const prevURL = globalThis.URL;
  const created = [];
  const revoked = [];
  const clicks = [];
  try {
    globalThis.document = dom.window.document;
    globalThis.URL = dom.window.URL;
    globalThis.URL.createObjectURL = (b) => {
      created.push(b);
      return `blob:mock/${created.length}`;
    };
    globalThis.URL.revokeObjectURL = (u) => revoked.push(u);
    // Avoid jsdom's "navigation not implemented" and capture the click intent.
    dom.window.HTMLAnchorElement.prototype.click = function () {
      clicks.push({ href: this.href, download: this.download });
    };

    const blob = new dom.window.Blob(["a,b\n1,2"], { type: "text/csv" });
    downloadBlob(blob, "musclemap_metrics.csv");

    assert.equal(created.length, 1, "createObjectURL called once");
    assert.equal(created[0], blob, "object URL created from the blob");
    assert.equal(clicks.length, 1, "anchor clicked once");
    assert.equal(clicks[0].download, "musclemap_metrics.csv", "download filename set");
    assert.match(clicks[0].href, /^blob:mock\//, "href is the object URL");
    assert.equal(revoked.length, 1, "object URL revoked");
    assert.equal(dom.window.document.querySelector("a"), null, "anchor removed from DOM");

    // downloadFile(file) downloads under file.name.
    const file = new dom.window.File(["x"], "segmentation.nii.gz", {
      type: "application/octet-stream",
    });
    downloadFile(file);
    assert.equal(clicks.length, 2);
    assert.equal(clicks[1].download, "segmentation.nii.gz");
  } finally {
    globalThis.document = prevDoc;
    globalThis.URL = prevURL;
  }
});
