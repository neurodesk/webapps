import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { expect } from "@playwright/test";

// The installed desktop app segments the bundled BLAST-CT head CT example on CPU
// and verifies upstream biomedia-mira/blast-ct v2.1.0 (v2 multi-centre model, checkpoint 1) counts.
export async function verifyOffline(page, { download }) {
  await page.getByLabel("Input", { exact: true }).selectOption("scan-0-head-ct");
  await expect(page.locator("#runButton")).toBeEnabled({ timeout: 120000 });
  await page.locator("#advancedSettings").evaluate((section) => { section.open = true; });
  await page.locator("#backend").selectOption("wasm");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText(/^Segmentation complete · /, { timeout: 600000 });

  const segmentation = await download('#resultList .nd-volume-toggle:has-text("Lesion labels") .nd-download-btn');
  assert.equal(segmentation.filename, "scan_0_head_ct_blastct_segmentation.nii.gz");
  const nifti = gunzipSync(segmentation.bytes);
  assert.deepEqual([nifti.readInt16LE(42), nifti.readInt16LE(44), nifti.readInt16LE(46)], [201, 201, 149]);
  assert.equal(nifti.readInt16LE(70), 2, "the labels are uint8");
  assert.equal(nifti.readInt16LE(252), 1, "qform_code preserved from input");
  assert.equal(nifti.readInt16LE(254), 1, "sform_code preserved from input");

  const voxels = nifti.subarray(352);
  const counts = [0, 0, 0, 0, 0];
  for (let i = 0; i < voxels.length; i++) {
    if (voxels[i] < 5) counts[voxels[i]]++;
  }
  assert.ok(Math.abs(counts[1] - 48087) <= 50, `unexpected IPH count ${counts[1]} (expected ~48087)`);
  assert.ok(Math.abs(counts[2] - 23595) <= 50, `unexpected EAH count ${counts[2]} (expected ~23595)`);
  assert.ok(Math.abs(counts[3] - 62721) <= 50, `unexpected Oedema count ${counts[3]} (expected ~62721)`);
  assert.ok(Math.abs(counts[4] - 327) <= 50, `unexpected IVH count ${counts[4]} (expected ~327)`);

  return {
    filename: segmentation.filename,
    counts: { iph: counts[1], eah: counts[2], oedema: counts[3], ivh: counts[4] },
  };
}
