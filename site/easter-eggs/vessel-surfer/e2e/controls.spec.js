import { openGame } from "./open-game.js";
import { test, expect } from "@playwright/test";
test("focused buttons accept flight keys, held inputs brake independently, and steering changes heading immediately", async ({
  page,
}) => {
  test.setTimeout(90000);
  let game = await openGame(page);
  await expect(game.locator("#play")).toBeEnabled({ timeout: 30000 });
  await game.locator("#play").click();
  await game.locator("#quick-play").focus();
  await page.keyboard.down("Shift");
  await expect(game.locator("#brake")).toHaveAttribute("aria-pressed", "true");
  const position = await game.locator("#ocean").getAttribute("data-position");
  await page.waitForTimeout(200);
  expect(await game.locator("#ocean").getAttribute("data-position")).toBe(
    position,
  );
  await game.locator("#brake").hover();
  await page.mouse.down();
  await page.mouse.up();
  await expect(game.locator("#brake")).toHaveAttribute("aria-pressed", "true");
  const initialHeading = JSON.parse(
    await game.locator("#ocean").getAttribute("data-heading"),
  );
  await page.keyboard.down("ArrowRight");
  await expect
    .poll(async () =>
      JSON.parse(
        await game.locator("#ocean").getAttribute("data-heading"),
      ).reduce((sum, v, i) => sum + v * initialHeading[i], 0),
    )
    .toBeLessThan(0.98);
  await page.keyboard.up("ArrowRight");
  const rightHeading = JSON.parse(
    await game.locator("#ocean").getAttribute("data-heading"),
  );
  expect(
    rightHeading.reduce((sum, v, i) => sum + v * initialHeading[i], 0),
  ).toBeLessThan(0.98);
  expect(await game.locator("#ocean").getAttribute("data-position")).toBe(
    position,
  );
  await page.keyboard.down("ArrowUp");
  await expect
    .poll(async () =>
      JSON.parse(
        await game.locator("#ocean").getAttribute("data-heading"),
      ).reduce((sum, v, i) => sum + v * rightHeading[i], 0),
    )
    .toBeLessThan(0.98);
  await page.keyboard.up("ArrowUp");
  const upHeading = JSON.parse(
    await game.locator("#ocean").getAttribute("data-heading"),
  );
  expect(
    upHeading.reduce((sum, v, i) => sum + v * rightHeading[i], 0),
  ).toBeLessThan(0.98);
  await expect(game.locator("#ocean")).toHaveAttribute(
    "data-camera-inside",
    "true",
  );
  await page.keyboard.up("Shift");
  await expect(game.locator("#brake")).toHaveAttribute("aria-pressed", "false");
  await expect
    .poll(() => game.locator("#ocean").getAttribute("data-position"))
    .not.toBe(position);
  // Keyboard activation of a hold button acts for the whole press.
  await game.locator("#brake").focus();
  await page.keyboard.down(" ");
  await expect(game.locator("#brake")).toHaveAttribute("aria-pressed", "true");
  const stopped = await game.locator("#ocean").getAttribute("data-position");
  await page.waitForTimeout(200);
  expect(await game.locator("#ocean").getAttribute("data-position")).toBe(
    stopped,
  );
  await page.keyboard.up(" ");
  await expect(game.locator("#brake")).toHaveAttribute("aria-pressed", "false");
  await game.locator("#play").click();
  await game.locator("#reverse").click();
  await expect(game.locator("#ocean")).toHaveAttribute(
    "data-camera-inside",
    "true",
  );
  await page.screenshot({
    path: "/tmp/vessel-swim-desktop.png",
    fullPage: false,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "/tmp/vessel-swim-phone.png",
    fullPage: false,
  });
});
