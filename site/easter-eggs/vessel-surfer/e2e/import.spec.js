import { openGame } from "./open-game.js";
import { fixtureMask } from "./fixture-mask.js";
import { test, expect } from "@playwright/test";
test("a local segmentation loads, is explored on a phone, and the brain can be restored", async ({
  page,
}) => {
  test.setTimeout(120000);
  await page.setViewportSize({ width: 390, height: 844 });
  await openGame(page);
  await page.getByText("Surf your own vessel mask", { exact: true }).click();
  await page.locator("#mask").setInputFiles({
    name: "vessel-fixture.nii",
    mimeType: "application/octet-stream",
    buffer: fixtureMask(),
  });
  await expect(page.locator("#load-status")).toContainText("Loaded");
  await expect(page.locator("#source-label")).toContainText("vessel-fixture.nii");
  await expect(page.locator("#ocean")).toHaveAttribute("data-source", "local-mask");
  expect(await page.locator("#mask").evaluate((el) => el.files[0].name)).toBe(
    "vessel-fixture.nii",
  );
  await page.locator("#play").click();
  await expect(page.locator("#ocean")).toHaveAttribute("data-state", "running");
  await expect
    .poll(async () =>
      Number(await page.locator("#ocean").getAttribute("data-distance")),
    )
    .toBeGreaterThan(0.1);
  await expect(page.locator("#ocean")).toHaveAttribute("data-camera-inside", "true");
  await page.keyboard.down("Shift");
  await page.waitForTimeout(100);
  const stopped = await page.locator("#ocean").getAttribute("data-position");
  await page.keyboard.down("ArrowRight");
  await page.waitForTimeout(300);
  await page.keyboard.up("ArrowRight");
  expect(await page.locator("#ocean").getAttribute("data-position")).toBe(stopped);
  const heading = JSON.parse(
    await page.locator("#ocean").getAttribute("data-heading"),
  );
  expect(Math.abs(heading[0])).toBeGreaterThan(0.05);
  await page.keyboard.up("Shift");
  await page.screenshot({ path: test.info().outputPath("vessel-import-phone.png") });
  await page.keyboard.press("Escape");
  await expect(page.locator("#ocean")).toHaveAttribute("data-state", "paused");
  await page.locator("#menu-button").click();
  await page.locator("#demo").click();
  await expect(page.locator("#ocean")).toHaveAttribute("data-source", "human-pial-arteries", {
    timeout: 60000,
  });
  await expect(page.locator("#play")).toBeEnabled();
  await expect(page.locator("#source-label")).toContainText("Bollmann");
  await expect(page.locator("#mission-text")).not.toContainText("Practice");
});
