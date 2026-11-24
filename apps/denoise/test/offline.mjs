import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { expect } from "@playwright/test";
import { stackTiff } from "../src/config.js";
import { denoiseVolume } from "../src/core/denoise.js";
import { createNormalRng, createRng } from "../src/core/rng.js";

function sha256(typedArray) {
  return createHash("sha256")
    .update(new Uint8Array(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength))
    .digest("hex");
}

function syntheticNoisyTiff() {
  const dims = [1, 48, 48];
  const [, ny, nx] = dims;
  const randn = createNormalRng(createRng(17));
  const data = new Float32Array(ny * nx);
  for (let y = 0; y < ny; y += 1) {
    for (let x = 0; x < nx; x += 1) {
      const signal = 40 + 200 * Math.exp(-((y - 24) ** 2 + (x - 24) ** 2) / 90);
      data[y * nx + x] = signal + 18 * randn();
    }
  }
  return {
    dims,
    data,
    buffer: Buffer.from(stackTiff(data, dims, { x: 0.1, y: 0.1, z: 0.25 })),
  };
}

// The installed desktop suite denoises a noisy TIFF with Aydin FGR-GBDT and downloads
// the exact Float32 volume computed by the Node core.
export async function verifyOffline(page, { download }) {
  const sample = syntheticNoisyTiff();
  await page.locator("#imageInput").setInputFiles({
    name: "cells.tif",
    mimeType: "image/tiff",
    buffer: sample.buffer,
  });
  await expect(page.locator("#runButton")).toBeEnabled({ timeout: 60000 });
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText("Image denoised", { timeout: 180000 });

  const result = await download('#resultList .nd-volume-toggle:has-text("Denoised (NIfTI)") .nd-download-btn');
  assert.match(result.filename, /_denoised\.nii\.gz$/);
  const want = denoiseVolume(sample.data, sample.dims);
  const raw = gunzipSync(result.bytes);
  const offset = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getFloat32(108, true);
  const got = new Float32Array(raw.buffer.slice(raw.byteOffset + offset, raw.byteOffset + raw.byteLength));
  assert.equal(sha256(got), sha256(want.denoised));
  return { filename: result.filename, bytes: result.bytes.length };
}
