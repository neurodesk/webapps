import { openGame } from "./open-game.js";
import { test, expect } from "@playwright/test";

const heading = async (page) =>
  JSON.parse(await page.locator("#ocean").getAttribute("data-heading"));
const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);

test("keys steer while braking, mouse position aims, and a held drag acts as a joystick", async ({
  page,
}) => {
  test.setTimeout(120000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openGame(page);
  await page.locator("#play").click();
  await expect(page.locator("#ocean")).toHaveAttribute("data-state", "running");
  await expect(page.locator("#touch")).toBeHidden();
  await page.keyboard.down("Shift");
  await expect(page.locator("#brake")).toHaveAttribute("aria-pressed", "true");
  const position = await page.locator("#ocean").getAttribute("data-position");
  await page.waitForTimeout(200);
  expect(await page.locator("#ocean").getAttribute("data-position")).toBe(
    position,
  );
  const initial = await heading(page);
  await page.keyboard.down("ArrowRight");
  await expect
    .poll(async () => dot(await heading(page), initial))
    .toBeLessThan(0.98);
  await page.keyboard.up("ArrowRight");
  const turned = await heading(page);
  await page.keyboard.down("ArrowUp");
  await expect
    .poll(async () => dot(await heading(page), turned))
    .toBeLessThan(0.98);
  await page.keyboard.up("ArrowUp");
  expect(await page.locator("#ocean").getAttribute("data-position")).toBe(
    position,
  );
  await expect(page.locator("#ocean")).toHaveAttribute(
    "data-camera-inside",
    "true",
  );
  // Mouse aim: an offset from the screen centre turns continuously.
  const before = await heading(page);
  await page.mouse.move(720, 450);
  await page.mouse.move(1000, 450, { steps: 4 });
  await expect
    .poll(async () => dot(await heading(page), before))
    .toBeLessThan(0.95);
  await page.mouse.move(720, 450);
  await page.waitForTimeout(250);
  const settled = await heading(page);
  await page.waitForTimeout(250);
  expect(dot(await heading(page), settled)).toBeGreaterThan(0.999);
  // Joystick: hold and drag from anywhere, release to centre.
  await page.mouse.move(400, 600);
  await page.mouse.down();
  await expect(page.locator("#stick")).toBeVisible();
  await page.mouse.move(400, 540, { steps: 3 });
  await expect
    .poll(async () => dot(await heading(page), settled))
    .toBeLessThan(0.97);
  await page.mouse.up();
  await expect(page.locator("#stick")).toBeHidden();
  await page.keyboard.up("Shift");
  await expect(page.locator("#brake")).toHaveAttribute("aria-pressed", "false");
  await expect
    .poll(() => page.locator("#ocean").getAttribute("data-position"))
    .not.toBe(position);
  await page.keyboard.down("b");
  await expect(page.locator("#reverse")).toHaveAttribute("aria-pressed", "true");
  await page.waitForTimeout(300);
  await page.keyboard.up("b");
  await expect(page.locator("#ocean")).toHaveAttribute(
    "data-camera-inside",
    "true",
  );
  // U-turn: one key press reverses the heading without any aim input.
  await page.mouse.move(720, 450);
  await page.waitForTimeout(200);
  const forward = await heading(page);
  await page.keyboard.press("r");
  await expect(page.locator("#ocean")).toHaveAttribute("data-turning", "true");
  await expect
    .poll(async () => dot(await heading(page), forward), { timeout: 15000 })
    .toBeLessThan(-0.9);
  await expect(page.locator("#ocean")).toHaveAttribute("data-turning", "false");
  await expect(page.locator("#target-marker .target-marker__label")).toContainText("mm");
  await expect(page.locator("#reticle")).toBeVisible();
  // Speed changes mid-run from the keyboard and the in-run slider.
  await expect(page.locator("#speed-panel")).toBeVisible();
  const speedBefore = Number(await page.locator("#speed-hud").inputValue());
  await page.keyboard.press("+");
  await expect(page.locator("#speed-hud")).toHaveValue(String(speedBefore + 0.25));
  await expect(page.locator("#speed-hud-value")).toHaveText(`${speedBefore + 0.25}×`);
  await page.locator("#speed-hud").fill("3");
  await expect(page.locator("#speed-value")).toHaveText("3×");
  await page.screenshot({ path: "/tmp/vessel-controls-desktop.png" });
});

test.describe("touch", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
  test("a finger drag steers through a floating joystick and the hold buttons brake", async ({
    page,
  }) => {
    test.setTimeout(120000);
    await openGame(page);
    await page.locator("#play").tap();
    await expect(page.locator("#ocean")).toHaveAttribute("data-state", "running");
    const client = await page.context().newCDPSession(page);
    const touch = (type, x, y) =>
      client.send("Input.dispatchTouchEvent", {
        type,
        touchPoints: type === "touchEnd" ? [] : [{ x, y }],
      });
    const before = await heading(page);
    await touch("touchStart", 120, 600);
    await expect(page.locator("#touch")).toBeVisible();
    await expect(page.locator("#stick")).toBeVisible();
    await touch("touchMove", 175, 600);
    await expect
      .poll(async () => dot(await heading(page), before))
      .toBeLessThan(0.97);
    await touch("touchEnd", 175, 600);
    await expect(page.locator("#stick")).toBeHidden();
    await expect(page.locator("#turn")).toBeVisible();
    await expect(page.locator("#reticle")).toBeHidden();
    const brake = await page.locator("#brake").boundingBox();
    await touch("touchStart", brake.x + brake.width / 2, brake.y + brake.height / 2);
    await expect(page.locator("#brake")).toHaveAttribute("aria-pressed", "true");
    const position = await page.locator("#ocean").getAttribute("data-position");
    await page.waitForTimeout(250);
    expect(await page.locator("#ocean").getAttribute("data-position")).toBe(
      position,
    );
    await page.screenshot({ path: "/tmp/vessel-controls-phone.png" });
    await touch("touchEnd", 0, 0);
    await expect(page.locator("#brake")).toHaveAttribute("aria-pressed", "false");
    await expect
      .poll(() => page.locator("#ocean").getAttribute("data-position"))
      .not.toBe(position);
    await expect(page.locator("#ocean")).toHaveAttribute(
      "data-camera-inside",
      "true",
    );
  });
});
