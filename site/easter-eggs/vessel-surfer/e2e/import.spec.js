import { openGame } from "./open-game.js";
import { test, expect } from "@playwright/test";
test("local segmentation loads, supports swimming, and survives disclosure changes", async ({
  page,
}) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 390, height: 844 });
  let game = await openGame(page);
  await expect(game.locator("#play")).toBeEnabled({ timeout: 30000 });
  const buffer = Buffer.alloc(352 + 32 ** 3);
  buffer.writeInt32LE(348, 0);
  [3, 32, 32, 32, 1, 1, 1, 1].forEach((v, i) =>
    buffer.writeInt16LE(v, 40 + i * 2),
  );
  buffer.writeInt16LE(2, 70);
  buffer.writeInt16LE(8, 72);
  for (let i = 0; i < 4; i++) buffer.writeFloatLE(1, 76 + i * 4);
  buffer.writeFloatLE(352, 108);
  buffer.write("n+1\0", 344);
  for (let z = 3; z < 29; z++)
    for (let y = 12; y < 20; y++)
      for (let x = 12; x < 20; x++) buffer[352 + x + 32 * (y + 32 * z)] = 1;
  await game.locator("#dataset summary").click();
  await game.locator("#mask").setInputFiles({
    name: "vessel-fixture.nii",
    mimeType: "application/octet-stream",
    buffer,
  });
  await expect(game.locator("#load-status")).toContainText("Loaded");
  await expect(game.locator("#source-label")).toContainText(
    "vessel-fixture.nii",
  );
  await game.locator("#dataset summary").click();
  await game.locator("#dataset summary").click();
  expect(await game.locator("#mask").evaluate((el) => el.files[0].name)).toBe(
    "vessel-fixture.nii",
  );
  await game.locator("#quick-play").click();
  await expect(game.locator("#ocean")).toHaveAttribute("data-state", "running");
  await expect
    .poll(async () =>
      Number(await game.locator("#ocean").getAttribute("data-distance")),
    )
    .toBeGreaterThan(0.1);
  // Braking must stop translation while allowing heading changes.
  await game.locator("#brake").hover();
  await page.mouse.down();
  await page.waitForTimeout(100);
  const stopped = await game.locator("#ocean").getAttribute("data-position");
  await page.keyboard.down("ArrowRight");
  await page.waitForTimeout(300);
  await page.keyboard.up("ArrowRight");
  expect(await game.locator("#ocean").getAttribute("data-position")).toBe(
    stopped,
  );
  const heading = JSON.parse(
    await game.locator("#ocean").getAttribute("data-heading"),
  );
  expect(Math.abs(heading[0])).toBeGreaterThan(0.05);
  await page.mouse.up();
  await game.locator("#reverse").hover();
  await page.mouse.down();
  const before = JSON.parse(
    await game.locator("#ocean").getAttribute("data-position"),
  );
  await page.waitForTimeout(300);
  const after = JSON.parse(
    await game.locator("#ocean").getAttribute("data-position"),
  );
  expect(
    after.reduce((sum, v, i) => sum + (v - before[i]) * heading[i], 0),
  ).toBeLessThan(0);
  await page.mouse.up();
  await game.locator("#quick-play").click();
  await expect(game.locator("#ocean")).toHaveAttribute("data-state", "paused");
  await expect(game.locator("#ocean")).toHaveAttribute(
    "data-camera-inside",
    "true",
  );
  await expect(game.locator("#ocean")).toHaveAttribute(
    "data-clear-view",
    "true",
  );
  await page.screenshot({
    path: "/tmp/vessel-surfer-import-phone.png",
    fullPage: false,
  });
  await game.locator("#demo").click();
  await expect(game.locator("#source-label")).toContainText("Human brain");
  await game.getByRole("button", { name: "Use light theme" }).click();
  await page.screenshot({
    path: "/tmp/vessel-surfer-light-phone.png",
    fullPage: false,
  });
  await game.getByRole("button", { name: "About", exact: true }).click();
  await expect(game.locator("#info")).toBeVisible();
  await game.getByRole("button", { name: "Back to the helm" }).click();
  await expect(game.locator("#info")).not.toBeVisible();
});
