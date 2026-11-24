import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { expect } from "@playwright/test";

// Offline desktop verification: loads the bundled BEAMSTER native T1c example,
// runs Raidionics v1.3 + Greedy MNI RADS on CPU, and checks the downloaded mask and JSON report.
export async function verifyOffline(page, { download }) {
  await page.getByLabel("Input", { exact: true }).selectOption("beamster-a-038");
  await expect(page.locator("#runButton")).toBeEnabled({ timeout: 120000 });
  await page.locator("#advancedSettings").evaluate((section) => { section.open = true; });
  await page.locator("#backend").selectOption("wasm");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText(/^Report ready · 3 lesions · [\d.]+ mL$/, { timeout: 600000 });

  const mask = await download('#resultList .nd-volume-toggle:has-text("Tumour mask (native)") .nd-download-btn');
  assert.equal(mask.filename, "BEAMSTER_A_038_T1c_tumour_mask.nii.gz");
  const nifti = gunzipSync(mask.bytes);
  assert.deepEqual([nifti.readInt16LE(42), nifti.readInt16LE(44), nifti.readInt16LE(46)], [512, 512, 250]);

  const reportDownload = await download('#resultList .nd-volume-toggle:has-text("Report (JSON)") .nd-download-btn');
  const report = JSON.parse(reportDownload.bytes.toString("utf8"));
  assert.equal(report.morphometry.lesionCount, 3);
  assert.ok(report.rads.laterality.leftPct > 90, "expected left-hemisphere metastasis");
  return { filename: mask.filename, lesions: report.morphometry.lesionCount, totalVolumeMl: report.morphometry.totalVolumeMl };
}
