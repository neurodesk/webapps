import { openGame } from "./open-game.js";
import { test, expect } from "@playwright/test";
for (const width of [1440, 390])
  test(`voyage at ${width}px`, async ({ page }) => {
    test.setTimeout(120000);
    await page.setViewportSize({ width, height: 900 });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await openGame(page);
    await expect(page.locator("#ocean")).toHaveAttribute("data-state", "ready");
    await expect(page.locator("#navigation-map")).toBeHidden();
    await page.getByText("Controls", { exact: true }).click();
    await page.locator("#speed").fill("1.5");
    await expect(page.locator("#speed-value")).toHaveText("1.5×");
    await page.screenshot({ path: test.info().outputPath(`vessel-surfer-${width}-menu.png`) });
    await page.evaluate(() => {
      window.tunnelFailures = [];
      function checkTunnel() {
        const d = document.querySelector("#ocean").dataset;
        if (
          d.state === "running" &&
          (d.cameraInside !== "true" || d.clearView !== "true")
        )
          window.tunnelFailures.push({ ...d });
        requestAnimationFrame(checkTunnel);
      }
      requestAnimationFrame(checkTunnel);
    });
    await page.locator("#play").click();
    await expect(page.locator("#menu")).toBeHidden();
    await expect(page.locator("#navigation-map")).toBeVisible();
    await expect(page.locator("#ocean")).toHaveAttribute("data-state", "running");
    await expect
      .poll(async () =>
        Number(await page.locator("#ocean").getAttribute("data-distance")),
      )
      .toBeGreaterThan(0.5);
    await page.screenshot({ path: test.info().outputPath(`vessel-surfer-${width}-dive.png`) });
    await page.keyboard.press("Space");
    await expect(page.locator("#ocean")).toHaveAttribute("data-state", "paused");
    await expect(page.locator("#menu")).toContainText("Paused");
    await expect(page.locator("#ocean")).toHaveAttribute(
      "data-source",
      "human-pial-arteries",
    );
    await expect(page.locator("#ocean")).toHaveAttribute(
      "data-camera-inside",
      "true",
    );
    await expect(page.locator("#ocean")).toHaveAttribute(
      "data-clear-view",
      "true",
    );
    const eye = JSON.parse(
      await page.locator("#ocean").getAttribute("data-camera-position"),
    );
    const position = JSON.parse(
      await page.locator("#ocean").getAttribute("data-position"),
    );
    expect(eye).toEqual(position);
    const distance = await page.locator("#ocean").getAttribute("data-distance");
    await page.waitForTimeout(300);
    expect(await page.locator("#ocean").getAttribute("data-distance")).toBe(
      distance,
    );
    await page.screenshot({ path: test.info().outputPath(`vessel-surfer-${width}-paused.png`) });
    await page.locator("#play").click();
    await expect(page.locator("#ocean")).toHaveAttribute("data-state", "running");
    await page.keyboard.press("Escape");
    await expect(page.locator("#ocean")).toHaveAttribute("data-state", "paused");
    await page.locator("#reset").click();
    await expect(page.locator("#ocean")).toHaveAttribute("data-state", "running");
    await expect
      .poll(async () =>
        Number(await page.locator("#ocean").getAttribute("data-elapsed")),
      )
      .toBeLessThan(2);
    await page.locator("#quick-play").click();
    await expect(page.locator("#ocean")).toHaveAttribute("data-state", "paused");
    await page.locator("#menu-button").click();
    await expect(page.locator("#ocean")).toHaveAttribute("data-state", "ready");
    await expect(page.locator("#score")).toHaveText("0:00.0");
    await expect(page.locator("#speed")).toHaveValue("1.5");
    await expect(page.locator('input[type="file"]')).toHaveCount(0);
    await expect(page.getByText("Surf your own vessel mask", { exact: true })).toHaveCount(0);
    await expect(page.locator("#play")).toBeEnabled();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => window.tunnelFailures)).toEqual([]);
  });
