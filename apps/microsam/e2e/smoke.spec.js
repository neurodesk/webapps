// Real browser smoke test against `vite preview` (see playwright.config.js): app boot, the shared
// app bar and cross-origin isolation, which threaded ONNX Runtime needs.
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

const automation = JSON.parse(readFileSync(new URL("../automation.json", import.meta.url), "utf8"));

test("app boots on the workspace with prompting disabled", async ({ page }) => {
  await page.goto("./");
  await expect(page.locator("#viewer")).toBeVisible();
  await expect(page.locator("#statusText")).toHaveText("Drag and drop files");
  await expect(page.locator("#embedButton")).toBeDisabled();
  await expect(page.locator("#positiveTool")).toBeDisabled();
  await expect(page.locator("#technicalLog")).toHaveClass(/collapsed/);
});

test("shared app bar owns information actions and theme", async ({ page }) => {
  await page.goto("./");
  const bar = page.locator(".nd-app-bar:visible");
  await expect(bar).toHaveCount(1);
  await expect(page.locator("#controls > #aboutBtn")).toBeHidden();
  await bar.getByRole("button", { name: "About", exact: true }).click();
  await expect(page.locator("#infoDialog")).toBeVisible();
  await expect(page.locator("#infoDialog").getByRole("heading", { name: `About ${automation.title}`, exact: true })).toBeVisible();
  await page.locator("#infoDialog").getByRole("button", { name: "Close" }).click();
  await bar.locator("[data-neurodesk-theme-toggle]").click();
  await expect(page.locator("html")).toHaveAttribute("data-neurodesk-theme", "light");
});

test("page is cross-origin isolated (COOP/COEP active)", async ({ page }) => {
  await page.goto("./");
  expect(await page.evaluate(() => self.crossOriginIsolated === true)).toBe(true);
});

test("the build ships the licence notices", async ({ request }) => {
  const notice = await request.get("NOTICE");
  expect(notice.ok()).toBe(true);
  const text = await notice.text();
  for (const name of ["micro-sam (MIT)", "Pillow (MIT-CMU)", "CC BY 4.0", "Apache License, Version 2.0"]) expect(text).toContain(name);
  expect((await request.get("LICENSE")).ok()).toBe(true);
});
