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
    const ocean = page.locator("#ocean");
    // Pause at the first frame beyond 10 mm so browser-driver latency cannot
    // turn this launch check into a longer, unsteered flight.
    const launch = await ocean.evaluate((canvas) => new Promise((resolve, reject) => {
      const observer = new MutationObserver(() => {
        const distance = Number(canvas.dataset.distance);
        if (distance <= 10) return;
        const sample = { distance, bumps: canvas.dataset.bumps, blocked: canvas.dataset.blocked };
        observer.disconnect();
        clearTimeout(deadline);
        document.querySelector("#quick-play").click();
        resolve(sample);
      });
      const deadline = setTimeout(() => {
        observer.disconnect();
        reject(new Error("Grand tour did not travel 10 mm within 30 seconds."));
      }, 30000);
      observer.observe(canvas, { attributes: true, attributeFilter: ["data-distance"] });
      document.querySelector("#play").click();
    }));
    expect(launch.distance).toBeGreaterThan(10);
    expect(launch.bumps).toBe("0");
    expect(launch.blocked).toBe("false");
    await expect(ocean).toHaveAttribute("data-state", "paused");
    await expect(ocean).toHaveAttribute("data-bumps", "0");
    await expect(ocean).toHaveAttribute("data-blocked", "false");
    expect(Number(await ocean.getAttribute("data-distance"))).toBeGreaterThan(10);
    await page.screenshot({ path: test.info().outputPath("grand-tour-launch.png") });
  });
}
