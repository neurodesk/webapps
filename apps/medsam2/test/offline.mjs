import assert from "node:assert/strict";
import { expect } from "@playwright/test";

export async function verifyOffline(page, { fixture, download }) {
  await page.locator("#imageInput").setInputFiles(fixture);
  await expect(page.locator("#fileInfo")).toBeVisible({ timeout: 30000 });
  await page.locator("#advancedSettings summary").click();
  await page.locator("#backend").selectOption("wasm");
  await page.locator("#maxRange").fill("1");
  const canvas = page.locator("#promptCanvas");
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + box.width * 0.38, box.y + box.height * 0.38);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.62, box.y + box.height * 0.62, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator("#acceptButton")).toBeEnabled({ timeout: 120000 });
  await page.locator("#acceptButton").click();
  await expect(page.locator("#outputSection")).toHaveAttribute("open", "");
  const result = await download('#resultList .nd-volume-toggle:has-text("3D labels") .nd-download-btn');
  assert.match(result.filename, /_medsam2_seg\.nii$/);
  assert.ok(result.bytes.length > 348);
  return { filename: result.filename, bytes: result.bytes.length };
}
