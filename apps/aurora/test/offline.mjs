import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { expect } from "@playwright/test";

// The installed desktop app refuses an off-grid generic fixture, then segments the bundled
// BraTS-MET T1c example on CPU and verifies upstream AuroraInferer(tta=False) label counts.
export async function verifyOffline(page, { fixture, download }) {
  await page.locator("#imageInput").setInputFiles(fixture);
  await expect(page.locator("#statusText")).toContainText("AURORA needs the 240 × 240 × 155, 1 mm BraTS/SRI24 grid", { timeout: 60000 });
  await expect(page.locator("#runButton")).toBeDisabled();
  await page.getByLabel("Input", { exact: true }).selectOption("brats-met-00110");
  await expect(page.locator("#runButton")).toBeEnabled({ timeout: 120000 });
  await page.locator("#advancedSettings").evaluate((section) => { section.open = true; });
  await page.locator("#backend").selectOption("wasm");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText(/^Segmentation complete · /, { timeout: 1800000 });
  const segmentation = await download('#resultList .nd-volume-toggle:has-text("Metastasis labels") .nd-download-btn');
  assert.equal(segmentation.filename, "BraTS-MET-00110-000-t1c_aurora_seg.nii.gz");
  const nifti = gunzipSync(segmentation.bytes);
  assert.deepEqual([nifti.readInt16LE(42), nifti.readInt16LE(44), nifti.readInt16LE(46)], [240, 240, 155]);
  assert.equal(nifti.readInt16LE(70), 2, "the labels are uint8");
  assert.equal(nifti.readInt16LE(252), 1, "qform_code preserved from input");
  assert.equal(nifti.readInt16LE(254), 1, "sform_code preserved from input");
  const voxels = nifti.subarray(352);
  let oedema = 0;
  let metastasis = 0;
  for (let i = 0; i < voxels.length; i++) {
    if (voxels[i] === 1) oedema++;
    else if (voxels[i] === 2) metastasis++;
  }
  assert.ok(Math.abs(oedema - 47078) <= 50, `unexpected oedema count ${oedema} (expected ~47078)`);
  assert.ok(Math.abs(metastasis - 51796) <= 50, `unexpected metastasis count ${metastasis} (expected ~51796)`);
  return { filename: segmentation.filename, counts: { oedema, metastasis } };
}
