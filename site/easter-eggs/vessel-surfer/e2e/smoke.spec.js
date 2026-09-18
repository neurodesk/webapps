import { openGame } from "./open-game.js";
import { test, expect } from "@playwright/test";
for (const width of [1440, 390])
  test(`voyage at ${width}px`, async ({ page }) => {
    test.setTimeout(90000);
    await page.setViewportSize({ width, height: 900 });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    let game = await openGame(page);
    await expect(game.locator("#play")).toBeEnabled({ timeout: 30000 });
    await expect(game.locator(".nd-imaging-app-header:visible")).toHaveCount(1);
    await game.getByText("Helm controls", { exact: true }).click();
    await game.locator("#speed").fill("1.5");
    await game.getByText("Helm controls", { exact: true }).click();
    await game.getByText("Helm controls", { exact: true }).click();
    await expect(game.locator("#speed")).toHaveValue("1.5");
    await page.screenshot({
      path: `/tmp/vessel-surfer-${width}-network.png`,
      fullPage: false,
    });
    await game.evaluate(() => {
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
    await game.locator("#play").click();
    await expect(game.locator("#ocean")).toHaveAttribute(
      "data-state",
      "running",
    );
    await expect
      .poll(async () =>
        Number(await game.locator("#ocean").getAttribute("data-distance")),
      )
      .toBeGreaterThan(0.5);
    await game.locator("#play").click();
    await expect(game.locator("#ocean")).toHaveAttribute(
      "data-state",
      "paused",
    );
    await expect(game.locator("#ocean")).toHaveAttribute(
      "data-source",
      "IXI322-human-MRA",
    );
    await expect(game.locator("#ocean")).toHaveAttribute(
      "data-camera-inside",
      "true",
    );
    await expect(game.locator("#ocean")).toHaveAttribute(
      "data-clear-view",
      "true",
    );
    const eye = JSON.parse(
      await game.locator("#ocean").getAttribute("data-camera-position"),
    );
    const position = JSON.parse(
      await game.locator("#ocean").getAttribute("data-position"),
    );
    expect(eye).toEqual(position);
    const distance = await game.locator("#ocean").getAttribute("data-distance");
    await page.waitForTimeout(300);
    expect(await game.locator("#ocean").getAttribute("data-distance")).toBe(
      distance,
    );
    await page.screenshot({
      path: `/tmp/vessel-surfer-${width}-dive.png`,
      fullPage: false,
    });
    await game.locator("#play").click();
    await game.locator("#view").click();
    await expect(game.locator("#ocean")).toHaveAttribute(
      "data-state",
      "paused",
    );
    await game.locator("#play").click();
    await expect(game.locator("#view")).toHaveText("Network view");
    await game.locator("#reset").click();
    await expect(game.locator("#score")).toHaveText("0:00.0");
    await expect(game.locator("#ocean")).toHaveAttribute("data-state", "ready");
    await game.locator("#dataset summary").click();
    await game.locator("#mask").setInputFiles({
      name: "invalid.nii",
      mimeType: "application/octet-stream",
      buffer: Buffer.alloc(512),
    });
    await expect(game.locator("#load-status")).toContainText("not a NIfTI");
    await expect(game.locator("#play")).toBeEnabled({ timeout: 30000 });
    expect(
      await game.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(errors).toEqual([]);
    expect(await game.evaluate(() => window.tunnelFailures)).toEqual([]);
  });
