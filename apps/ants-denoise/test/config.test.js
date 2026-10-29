// DOM-independent unit test (Node, no browser). Browser behaviour is covered by the
// Playwright test in e2e/ — Node tests must not import modules that touch `document`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { DENOISE_WASM_SHA256 } from "@neurodesk/ants-denoise/pin";
import { APP, SETTINGS, denoiseSettings, denoisedName, provenance, volumeRefusal } from "../src/config.js";

test("app id is lowercase kebab-case", () => {
  assert.match(APP.id, /^[a-z][a-z0-9-]*$/);
});

test("app config is frozen", () => {
  assert.ok(Object.isFrozen(APP));
  assert.ok(Object.isFrozen(SETTINGS));
});

test("the defaults are DenoiseImage's: Gaussian noise, patch radius 1, search radius 2", () => {
  assert.deepEqual(denoiseSettings(), { noiseModel: "Gaussian", patchRadius: 1, searchRadius: 2 });
  assert.deepEqual(denoiseSettings({ noiseModel: "Rician", searchRadius: 3 }), { noiseModel: "Rician", patchRadius: 1, searchRadius: 3 });
});

test("the form offers exactly the automation contract's settings and defaults", async () => {
  const { document } = new JSDOM(await readFile(new URL("../index.html", import.meta.url), "utf8")).window;
  assert.deepEqual([...document.querySelectorAll("#noiseModel option")].map((option) => option.value), SETTINGS.noiseModel.values);
  assert.equal(document.querySelector("#noiseModel").value, SETTINGS.noiseModel.default);
  for (const key of ["patchRadius", "searchRadius"]) {
    const field = document.getElementById(key);
    assert.deepEqual([Number(field.min), Number(field.max), Number(field.value)], [SETTINGS[key].min, SETTINGS[key].max, SETTINGS[key].default], key);
  }
});

test("settings outside the offered range are refused", () => {
  assert.throws(() => denoiseSettings({ noiseModel: "gaussian" }), /Gaussian or Rician/);
  for (const value of [0, 3, 1.5, Number.NaN]) assert.throws(() => denoiseSettings({ patchRadius: value }), /Patch radius must be a whole number from 1 to 2/);
  for (const value of [0, 4, 2.5, Number.NaN]) assert.throws(() => denoiseSettings({ searchRadius: value }), /Search radius must be a whole number from 1 to 3/);
});

test("only a single 3D volume is accepted", () => {
  assert.equal(volumeRefusal({ dimensionality: 3, frames: 1, dims: [240, 240, 81] }), null);
  assert.match(volumeRefusal({ dimensionality: 3, frames: 65, dims: [96, 96, 60, 65] }), /65 volumes.+dwidenoise/);
  assert.match(volumeRefusal({ dimensionality: 2, frames: 1, dims: [256, 256] }), /256 × 256, not a 3D volume/);
});

test("the denoised image keeps the input's BIDS entities and suffix", () => {
  assert.equal(denoisedName("MSLesSeg_P57_T1_FLAIR.nii.gz"), "MSLesSeg_P57_T1_desc-denoised_FLAIR.nii.gz");
  assert.equal(denoisedName("sub-01_desc-preproc_T1w.nii"), "sub-01_desc-denoised_T1w.nii.gz");
  assert.equal(denoisedName("T1.nii.gz"), "T1_desc-denoised.nii.gz");
});

test("the provenance names the module build and the one-thread native command for the same output", () => {
  const settings = { noiseModel: "Rician", patchRadius: 2, searchRadius: 3 };
  const record = provenance({ input: "sub-01_T1w.nii.gz", settings, mask: { name: "sub-01_mask.nii.gz", voxels: 42 } });
  assert.equal(record.module.wasmSha256, DENOISE_WASM_SHA256);
  assert.equal(record.module.threads, 1);
  assert.deepEqual(record.settings, { ...settings, shrinkFactor: 1 });
  assert.deepEqual(record.mask, { name: "sub-01_mask.nii.gz", voxels: 42 });
  assert.equal(record.nativeCommand, "ITK_GLOBAL_DEFAULT_NUMBER_OF_THREADS=1 DenoiseImage -d 3 -i sub-01_T1w.nii.gz -x sub-01_mask.nii.gz -n Rician -s 1 -p 2 -r 3 -o sub-01_desc-denoised_T1w.nii.gz -v 0");
  assert.equal(provenance({ input: "T1.nii", settings: denoiseSettings() }).mask, null);
});
