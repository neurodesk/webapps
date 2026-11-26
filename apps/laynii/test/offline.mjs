import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { expect } from "@playwright/test";
import { loadLaynii } from "@neurodesk/laynii/node";
import { makeCorticalSlabRim, makeDepthGradientSignal, niftiFile } from "../e2e/fixtures.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Offline desktop check: feeds a synthetic cortical slab rim + signal map and checks
// that the browser downloads equidistant layers matching @neurodesk/laynii in Node byte for byte.
export async function verifyOffline(page, { download }) {
  const rimBytes = makeCorticalSlabRim();
  const sigBytes = makeDepthGradientSignal();
  await page.locator("#imageInput").setInputFiles(niftiFile("slab_rim.nii", rimBytes));
  await expect(page.locator("#statusText")).toHaveText("slab_rim.nii loaded", { timeout: 60000 });
  await page.locator("#signalInput").setInputFiles(niftiFile("slab_sig.nii", sigBytes));
  await expect(page.locator("#statusText")).toHaveText("Signal map slab_sig.nii loaded", { timeout: 60000 });
  await expect(page.locator("#runButton")).toBeEnabled();
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText("Layers and profile ready", { timeout: 180000 });
  const result = await download('#resultList .nd-volume-toggle:has-text("Equidistant layers") .nd-download-btn');
  assert.equal(result.filename, "slab_rim_layers_equidist.nii.gz");
  const expected = await (await loadLaynii()).runLayersAndProfile({ rim: rimBytes, signal: sigBytes, nrLayers: 3 });
  assert.equal(sha256(gunzipSync(result.bytes)), sha256(expected.layersEquidist));
  return { filename: result.filename, bytes: result.bytes.length };
}
