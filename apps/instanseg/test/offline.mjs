import assert from "node:assert/strict";
import { expect } from "@playwright/test";

// The installed desktop app refuses a non-microscopy fixture, then segments the bundled
// 512 x 512 H&E brightfield OME-TIFF example on CPU and verifies upstream nucleus count parity.
export async function verifyOffline(page, { fixture, download }) {
  await page.locator("#imageInput").setInputFiles(fixture);
  await expect(page.locator("#statusText")).toContainText("not a TIFF, OME-TIFF, or PNG image", { timeout: 60000 });
  await expect(page.locator("#runButton")).toBeDisabled();
  await page.getByLabel("Input", { exact: true }).selectOption("he-brightfield-512");
  await expect(page.locator("#runButton")).toBeEnabled({ timeout: 120000 });
  await page.locator("#advancedSettings").evaluate((section) => { section.open = true; });
  await page.locator("#backend").selectOption("wasm");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText(/^Segmented \d+ nuclei · median area /, { timeout: 300000 });
  const csv = await download('#resultList .nd-volume-toggle:has-text("Nuclei morphometry") .nd-download-btn');
  assert.equal(csv.filename, "he_brightfield_512_instanseg_nuclei.csv");
  const rows = csv.bytes.toString("utf8").trim().split("\n");
  assert.equal(rows[0], "id,centroid_x_px,centroid_y_px,area_px,area_um2,equiv_diameter_um,bbox_x,bbox_y,bbox_w,bbox_h");
  const count = rows.length - 1;
  assert.equal(count, 1115, `unexpected nucleus count ${count} (expected 1115)`);
  const tiff = await download('#resultList .nd-volume-toggle:has-text("Nuclei labels") .nd-download-btn');
  assert.equal(tiff.filename, "he_brightfield_512_instanseg_labels.tif");
  assert.ok(tiff.bytes.byteLength > 512 * 512 * 2, "label TIFF holds 16-bit 512 x 512 pixels");
  return { filename: tiff.filename, nucleiCount: count };
}
