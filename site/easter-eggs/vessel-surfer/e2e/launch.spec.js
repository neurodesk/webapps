import { test, expect } from "@playwright/test";
import { openGame } from "./open-game.js";

for (const width of [1440, 390]) {
  test(`Grand tour launches without steering at ${width}px`, async ({ page }) => {
    test.setTimeout(60000);
    await page.setViewportSize({ width, height: 900 });
    await page.route("**/scores*", (route) => route.fulfill({
      json: { scores: [], total: 0 },
    }));
    await openGame(page);
    await page.locator('[data-track="pial-arteries-v3-tour"]').click();
    await page.getByText("Controls", { exact: true }).click();
    await page.locator("#speed").fill("3");
    await page.screenshot({ path: test.info().outputPath("grand-tour-menu.png") });
    await page.locator("#play").click();
    const ocean = page.locator("#ocean");
    // Physics caps each frame's delta, while the race clock counts real time.
    // Software rendering on CI therefore needs longer to cover this distance.
    await expect.poll(async () => Number(await ocean.getAttribute("data-distance")),
      { timeout: 30000 }).toBeGreaterThan(10);
    await page.locator("#quick-play").click();
    await expect(ocean).toHaveAttribute("data-bumps", "0");
    await expect(ocean).toHaveAttribute("data-blocked", "false");
    expect(Number(await ocean.getAttribute("data-distance"))).toBeGreaterThan(10);
    await page.screenshot({ path: test.info().outputPath("grand-tour-launch.png") });
  });
}
