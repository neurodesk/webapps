import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { expect } from "@playwright/test";

// The installed desktop app loads the bundled ParaVision 6.0.1 Bruker study,
// converts scan 6 (CAMRI_T2_RARE_2D_ax) to NIfTI-1 + scrubbed JSON sidecar, and
// verifies bit-exact voxel SHA-256 and affine parity with upstream BrkRaw v0.5.7.
const ORACLE_SCAN6_SHA256 = "81748cdb9779ba4453dc3424bd5248474b10dd14e3cd77e87796c920a7dd39ff";

export async function verifyOffline(page, { download }) {
  await page.getByLabel("Input", { exact: true }).selectOption("unc-pv6-phantom");
  await expect(page.locator("#runButton")).toBeEnabled({ timeout: 60000 });
  await expect(page.locator("#scanSelect")).toHaveValue("6:1");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText(/^Converted scan 6 · /, { timeout: 60000 });

  const niftiDl = await download('#resultList .nd-volume-toggle:has-text("NIfTI volume") .nd-download-btn');
  assert.equal(niftiDl.filename, "scan6_reco1.nii.gz");
  const raw = gunzipSync(niftiDl.bytes);
  assert.deepEqual([raw.readInt16LE(42), raw.readInt16LE(44), raw.readInt16LE(46)], [384, 384, 12]);
  assert.equal(raw.readInt16LE(70), 4, "scan 6 is int16");
  assert.equal(raw.readInt16LE(254), 2, "sform_code is 2");
  assert.ok(Math.abs(raw.readFloatLE(280) - (-0.075)) < 1e-5);
  assert.ok(Math.abs(raw.readFloatLE(292) - 14.4) < 1e-4);
  const payloadHash = createHash("sha256").update(raw.subarray(352)).digest("hex");
  assert.equal(payloadHash, ORACLE_SCAN6_SHA256);

  const jsonDl = await download('#resultList .nd-volume-toggle:has-text("Scrubbed metadata") .nd-download-btn');
  assert.equal(jsonDl.filename, "scan6_reco1.json");
  const meta = JSON.parse(jsonDl.bytes.toString("utf8"));
  assert.equal(meta.Manufacturer, "Bruker BioSpin");
  assert.equal(meta.SoftwareVersions, "ParaVision 6.0.1");
  assert.equal(meta.ScrubbedIdentifiers, true);
  assert.equal(Object.hasOwn(meta, "SubjectName"), false);

  return { filename: niftiDl.filename, payloadHash };
}
