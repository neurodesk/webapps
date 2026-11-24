import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { writeLabelTiff } from "@neurodesk/webapp-components/file-io/tiff";

// Nine bright discs (radius 14 px, soft edges, ~28 px diameter) on a dim background: a
// synthetic 16-bit fluorescence image that Cellpose cyto3 (default diameter 30 px) segments
// into 9 cells offline with the bundled model.
export function syntheticCells() {
  const size = 180;
  const image = new Int32Array(size * size);
  const centres = [];
  for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) centres.push([30 + 60 * row, 30 + 60 * col]);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let value = 200 + ((x * 7 + y * 13) % 17);
      for (const [cy, cx] of centres) {
        const r = Math.hypot(y - cy, x - cx);
        value += 3000 / (1 + Math.exp((r - 14) * 1.2));
      }
      image[y * size + x] = Math.round(value);
    }
  }
  return { name: "synthetic-cells.tif", mimeType: "image/tiff", buffer: Buffer.from(writeLabelTiff(image, size, size)) };
}

// The installed desktop app segments the synthetic image with the bundled cyto3 model and
// returns a label TIFF and a CSV table with one row per cell.
export async function verifyOffline(page, { download }) {
  await page.locator("#imageInput").setInputFiles(syntheticCells());
  await expect(page.locator("#runButton")).toBeEnabled({ timeout: 60000 });
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText("9 cells segmented", { timeout: 300000 });
  const row = (name) => `#resultList .nd-volume-toggle:has-text("${name}") .nd-download-btn`;
  const table = await download(row("Object table"));
  assert.equal(table.filename, "synthetic-cells_cellpose_cells.csv");
  const rows = table.bytes.toString("utf8").trim().split("\n").slice(1).map((line) => line.split(",").map(Number));
  assert.equal(rows.length, 9);
  for (const [, x, y, area] of rows) {
    assert.ok(Math.abs((x - 30) % 60) < 2 || Math.abs((x - 30) % 60 - 60) < 2, `centroid x ${x}`);
    assert.ok(Math.abs((y - 30) % 60) < 2 || Math.abs((y - 30) % 60 - 60) < 2, `centroid y ${y}`);
    assert.ok(area > 500 && area < 780, `area ${area} of a radius-14 disc`);
  }
  const labels = await download(row("Instance labels"));
  assert.equal(labels.filename, "synthetic-cells_cellpose_labels.tif");
  return { filename: table.filename, cells: rows.length };
}
