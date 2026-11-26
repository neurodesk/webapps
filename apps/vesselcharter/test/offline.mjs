import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { expect } from '@playwright/test';
import { characterizeVesselNifti } from '@neurodesk/vesselcharter';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const LAUSANNE_FIXTURE = fileURLToPath(
  new URL(
    '../../vesselboost/test/fixtures/upstream-reference/lausanne-tof-crop-192x192x64_vesselboost-manual_0429.nii.gz',
    import.meta.url,
  ),
);

// Runs VesselCharter offline on the Lausanne TOF VesselBoost mask fixture and verifies
// that the browser app's downloaded JSON, CSV, decompressed NIfTI, and MZ3 outputs match
// the pure Node package byte-for-byte.
export async function verifyOffline(page, { download }) {
  await page.locator('#imageInput').setInputFiles(LAUSANNE_FIXTURE);
  await expect(page.locator('#runButton')).toBeEnabled({ timeout: 60000 });
  await page.locator('#runButton').click();
  await expect(page.locator('#outputSection')).toHaveJSProperty('open', true, { timeout: 120000 });

  const summaryDl = await download('#resultList .nd-volume-toggle:has-text("Summary Metrics") .nd-download-btn');
  const segmentsDl = await download('#resultList .nd-volume-toggle:has-text("Segments Table") .nd-download-btn');
  const junctionsDl = await download('#resultList .nd-volume-toggle:has-text("Junctions Table") .nd-download-btn');
  const diameterDl = await download('#resultList .nd-volume-toggle:has-text("Diameter Map") .nd-download-btn');
  const skeletonDl = await download('#resultList .nd-volume-toggle:has-text("Skeleton Topology") .nd-download-btn');
  const meshDl = await download('#resultList .nd-volume-toggle:has-text("3D Vessel Tree") .nd-download-btn');

  const expected = await characterizeVesselNifti({
    vesselBytes: await readFile(LAUSANNE_FIXTURE),
    baseName: 'lausanne-tof-crop-192x192x64_vesselboost-manual_0429.nii.gz',
  });

  assert.equal(summaryDl.filename, expected.artifacts.summary.name);
  assert.equal(sha256(summaryDl.bytes), sha256(expected.artifacts.summary.bytes));
  assert.equal(segmentsDl.filename, expected.artifacts.segments.name);
  assert.equal(sha256(segmentsDl.bytes), sha256(expected.artifacts.segments.bytes));
  assert.equal(junctionsDl.filename, expected.artifacts.junctions.name);
  assert.equal(sha256(junctionsDl.bytes), sha256(expected.artifacts.junctions.bytes));
  assert.equal(diameterDl.filename, expected.artifacts.diameterMap.name);
  assert.equal(sha256(gunzipSync(diameterDl.bytes)), sha256(gunzipSync(expected.artifacts.diameterMap.bytes)));
  assert.equal(skeletonDl.filename, expected.artifacts.skeletonLabels.name);
  assert.equal(sha256(gunzipSync(skeletonDl.bytes)), sha256(gunzipSync(expected.artifacts.skeletonLabels.bytes)));
  assert.equal(meshDl.filename, expected.artifacts.vesselMesh.name);
  assert.equal(sha256(meshDl.bytes), sha256(expected.artifacts.vesselMesh.bytes));

  return { filename: summaryDl.filename, bytes: summaryDl.bytes.length };
}
