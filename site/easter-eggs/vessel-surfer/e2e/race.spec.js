import { openGame } from "./open-game.js";
import { test, expect } from "@playwright/test";
test("map follows the player, changes projection, and race timer pauses and resets", async ({
  page,
}) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 390, height: 844 });
  let game = await openGame(page);
  await expect(game.locator("#play")).toBeEnabled({ timeout: 30000 });
  await expect(game.locator("#map")).toBeVisible();
  await expect(game.locator("#target-distance")).toContainText("to target");
  const target = await game.locator("#ocean").getAttribute("data-target");
  await game.locator("#map-view").click();
  await expect(game.locator("#map-view")).toHaveText("Top view");
  await game.locator("#play").click();
  await expect
    .poll(async () =>
      Number(await game.locator("#ocean").getAttribute("data-elapsed")),
    )
    .toBeGreaterThan(1);
  await game.locator("#play").click();
  await expect(game.locator("#ocean")).toHaveAttribute("data-state", "paused");
  const elapsed = await game.locator("#ocean").getAttribute("data-elapsed");
  await page.waitForTimeout(250);
  expect(await game.locator("#ocean").getAttribute("data-elapsed")).toBe(
    elapsed,
  );
  await page.screenshot({
    path: "/tmp/vessel-race-phone.png",
    fullPage: false,
  });
  await game.getByRole("button", { name: "Use light theme" }).click();
  await page.screenshot({
    path: "/tmp/vessel-race-phone-light.png",
    fullPage: false,
  });
  await game.locator("#reset").click();
  await expect(game.locator("#score")).toHaveText("0:00.0");
  await expect(game.locator("#bumps")).toHaveText("0 bumps");
  expect(await game.locator("#ocean").getAttribute("data-target")).toBe(target);
  await game.getByText("High scores · this browser", { exact: true }).click();
  await expect(game.locator("#score-rows")).toContainText(
    "No completed runs yet",
  );
});
test("saved rankings survive reload and a real imported run reaches its destination", async ({
  page,
}) => {
  test.setTimeout(120000);
  await page.setViewportSize({ width: 1440, height: 900 });
  let game = await openGame(page);
  await expect(game.locator("#play")).toBeEnabled({ timeout: 30000 });
  await game.evaluate(() =>
    localStorage.setItem(
      "vessel-surfer.scores.v1",
      JSON.stringify([
        {
          challenge: "ixi322-destination-v1",
          seconds: 10,
          bumps: 0,
          points: 9800,
        },
      ]),
    ),
  );
  game = await openGame(page);
  await expect(game.locator("#play")).toBeEnabled({ timeout: 30000 });
  await game.getByText("High scores · this browser", { exact: true }).click();
  await expect(game.locator("#score-rows")).toContainText("9,800");
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
    for (let y = 10; y < 22; y++)
      for (let x = 10; x < 22; x++) buffer[352 + x + 32 * (y + 32 * z)] = 1;
  await game.locator("#dataset summary").click();
  await game
    .locator("#mask")
    .setInputFiles({
      name: "race-tunnel.nii",
      mimeType: "application/octet-stream",
      buffer,
    });
  await expect(game.locator("#load-status")).toContainText("Loaded");
  await game.getByText("Helm controls", { exact: true }).click();
  await game.locator("#speed").fill("2");
  await game.locator("#play").click();
  await page.keyboard.down("Shift");
  await expect(game.locator("#brake")).toHaveAttribute("aria-pressed", "true");
  const data = await game
    .locator("#ocean")
    .evaluate((el) => ({ ...el.dataset }));
  const p = JSON.parse(data.position),
    target = JSON.parse(data.target),
    d = target.map((v, i) => v - p[i]);
  const reverse = d[2] < 0;
  if (reverse) for (let i = 0; i < 3; i++) d[i] *= -1;
  const length = Math.hypot(...d),
    h = -Math.atan2(d[0], d[2]),
    v = Math.asin(d[1] / length);
  const box = await game.locator("#ocean").boundingBox(),
    x = box.x + box.width / 2,
    y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + h / 0.006, y - v / 0.006, { steps: 1 });
  await page.mouse.up();
  if (reverse) await page.keyboard.down("b");
  await page.keyboard.up("Shift");
  await expect(game.locator("#ocean")).toHaveAttribute(
    "data-state",
    "complete",
    { timeout: 90000 },
  );
  await page.keyboard.up("b");
  await expect(game.locator("#run-result")).toContainText("Practice complete");
  await expect(game.locator("#score-rows")).toContainText("9,800");
  await page.screenshot({
    path: "/tmp/vessel-race-finish.png",
    fullPage: false,
  });
});
