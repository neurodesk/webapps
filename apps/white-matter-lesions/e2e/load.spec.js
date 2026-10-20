// Loading an image reads its header from the first bytes, not from a copy of the whole file.
import { test, expect } from "@playwright/test";

// A 3D FLAIR stand-in: 256 × 256 × 64 int16 voxels, 1 mm, scanner-aligned sform.
function flair([nx, ny, nz]) {
  const bytes = Buffer.alloc(352 + nx * ny * nz * 2);
  bytes.writeInt32LE(348, 0);
  [3, nx, ny, nz, 1, 1, 1, 1].forEach((size, axis) => bytes.writeInt16LE(size, 40 + 2 * axis));
  bytes.writeInt16LE(4, 70);
  bytes.writeInt16LE(16, 72);
  [1, 1, 1, 1].forEach((size, axis) => bytes.writeFloatLE(size, 76 + 4 * axis));
  bytes.writeFloatLE(352, 108);
  bytes.writeInt16LE(1, 254);
  [[1, 0, 0, -nx / 2], [0, 1, 0, -ny / 2], [0, 0, 1, -nz / 2]].forEach((row, index) => row.forEach((value, column) => bytes.writeFloatLE(value, 280 + 16 * index + 4 * column)));
  bytes.write("n+1\0", 344, "latin1");
  for (let voxel = 0; voxel < nx * ny * nz; voxel++) bytes.writeInt16LE(voxel % 1000, 352 + 2 * voxel);
  return bytes;
}

test("the dimensions come from the header without reading the whole file", async ({ page }) => {
  // Every Blob read on this page, with whether the dimensions were already shown. The viewer and
  // the worker read the voxels after that; the header check before it must not.
  await page.addInitScript(() => {
    window.blobReads = [];
    const { arrayBuffer } = Blob.prototype;
    Blob.prototype.arrayBuffer = function () {
      window.blobReads.push({ size: this.size, dimsShown: !document.getElementById("fileInfo").hidden });
      return arrayBuffer.call(this);
    };
  });
  await page.goto("./");
  const bytes = flair([256, 256, 64]);
  await page.locator("#imageInput").setInputFiles({ name: "flair.nii", mimeType: "application/octet-stream", buffer: bytes });
  await expect(page.locator("#fileInfo")).toHaveText("flair.nii · 256 × 256 × 64 voxels", { timeout: 60000 });
  const beforeDims = await page.evaluate(() => window.blobReads.filter((read) => !read.dimsShown).map((read) => read.size));
  expect(beforeDims.every((size) => size <= 352), `read ${beforeDims.join(", ")} bytes before the dimensions were known`).toBe(true);
});
