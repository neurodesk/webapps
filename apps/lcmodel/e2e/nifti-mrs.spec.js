import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

test("NIfTI-MRS PRESS example fits with its water reference and exports correct timing", async ({ page }) => {
  test.setTimeout(300000);
  await page.goto("/");
  await page.getByRole("combobox", { name: "Example", exact: true }).selectOption("nifti-mrs-press");
  await expect(page.locator("#datasetSummary")).toContainText("TE 35 ms", { timeout: 120000 });
  await expect(page.locator("#datasetSummary")).toContainText("with water");
  await expect(page.locator("#basisSelect")).toHaveValue("press-3t-te35-shaped");
  await expect(page.locator("#waterScaling")).toBeChecked();
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Fit done", { timeout: 180000 });
  await expect(page.locator("#concHeader")).toHaveText("Conc. (mM)");
  await expect(page.locator(".lcm-plot .lcm-fit")).toHaveCount(1);
  const downloads = page.locator("#resultList .nd-volume-toggle");
  const downloadText = async (name) => {
    const pending = page.waitForEvent("download");
    await downloads.filter({ hasText: name }).getByRole("button", { name: "Download" }).click();
    return readFileSync(await (await pending).path(), "utf8");
  };
  const csv = await downloadText("Concentrations");
  expect(csv).toContain("Metabolite,Concentration,SD (%),/Cr+PCr");
  const rows = csv.trim().split("\n").slice(1).map((line) => line.split(","));
  const concentration = (name) => Number(rows.find((row) => row[0] === name)[1]);
  expect(concentration("NAA")).toBeCloseTo(7.95, 2);
  expect(concentration("Cr+PCr")).toBeCloseTo(6.41, 2);
  const raw = await downloadText("Spectrum for LCModel");
  expect(raw).toMatch(/echot= 35\.00/);
  const water = await downloadText("Water reference");
  expect(water).toMatch(/echot= 35\.00/);
});
