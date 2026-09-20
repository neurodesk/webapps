import { openGame } from "./open-game.js";
import { test, expect } from "@playwright/test";

const heading = async (page) =>
  JSON.parse(await page.locator("#ocean").getAttribute("data-heading"));
const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
// Wait until the steering ramp has decayed and the heading holds still, so a
// slow renderer cannot leak an earlier key press into a no-input check.
async function settle(page) {
  const sample = () =>
    page.locator("#ocean").evaluate((el) => ({
      heading: JSON.parse(el.dataset.heading),
      elapsed: el.dataset.elapsed,
    }));
  let last = await sample();
  let stable = 0;
  for (let i = 0; i < 60 && stable < 2; i++) {
    await page.waitForTimeout(250);
    const now = await sample();
    // Only count samples separated by at least one simulation frame.
    if (now.elapsed === last.elapsed) continue;
    stable = dot(now.heading, last.heading) > 0.99999 ? stable + 1 : 0;
    last = now;
  }
  return last.heading;
}

test("keys steer while braking, a held mouse drag steers, and a resting mouse reaches the slider", async ({
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
  // A resting or merely moving mouse never steers, so the pointer is free to
  // reach the speed slider; a held drag raises a joystick that does.
  const settled = await settle(page);
  await page.mouse.move(720, 450);
  await page.mouse.move(1300, 200, { steps: 4 });
  await page.waitForTimeout(300);
  expect(dot(await heading(page), settled)).toBeGreaterThan(0.999);
  await expect(page.locator("#stick")).toBeHidden();
  await page.mouse.move(400, 600);
  await page.mouse.down();
  await expect(page.locator("#stick")).toBeVisible();
  await page.mouse.move(460, 600, { steps: 3 });
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
  // U-turn: one key press reverses the heading. Brake meanwhile so the lumen
  // assist does not move the baseline while the turn runs.
  await page.keyboard.down("Shift");
  const forward = await settle(page);
  await page.keyboard.press("r");
  await expect(page.locator("#ocean")).toHaveAttribute("data-turning", "true");
  await expect
    .poll(async () => dot(await heading(page), forward), { timeout: 15000 })
    .toBeLessThan(-0.9);
  await expect(page.locator("#ocean")).toHaveAttribute("data-turning", "false");
  await page.keyboard.up("Shift");
  await expect(page.locator("#ocean")).toHaveAttribute("data-tilt", "off");
  // Speed changes mid-run from the keyboard and the in-run slider.
  await expect(page.locator("#speed-panel")).toBeVisible();
  const speedBefore = Number(await page.locator("#speed-hud").inputValue());
  await page.keyboard.press("+");
  await expect(page.locator("#speed-hud")).toHaveValue(String(speedBefore + 0.25));
  await expect(page.locator("#speed-hud-value")).toHaveText(`${speedBefore + 0.25}×`);
  // The in-run slider is reachable with the mouse.
  const slider = await page.locator("#speed-hud").boundingBox();
  await page.mouse.click(slider.x + slider.width - 2, slider.y + slider.height / 2);
  await expect(page.locator("#speed-hud")).toHaveValue("3");
  await expect(page.locator("#speed-value")).toHaveText("3×");
  await page.screenshot({ path: test.info().outputPath("vessel-controls-desktop.png") });
});

test.describe("touch", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
  const orient = (page, beta, gamma) =>
    page.evaluate(
      ([beta, gamma]) =>
        window.dispatchEvent(
          new DeviceOrientationEvent("deviceorientation", { alpha: 0, beta, gamma }),
        ),
      [beta, gamma],
    );
  test("tilting the phone steers, a tap recentres, and the hold buttons brake", async ({
    page,
  }) => {
    test.setTimeout(120000);
    await openGame(page);
    await page.locator("#play").tap();
    await expect(page.locator("#ocean")).toHaveAttribute("data-state", "running");
    await expect(page.locator("#touch")).toBeVisible();
    // Neutral pose, then a roll to the right.
    await orient(page, 40, 0);
    await expect(page.locator("#ocean")).toHaveAttribute("data-tilt", "on");
    const before = await heading(page);
    for (let i = 0; i < 6; i++) {
      await orient(page, 40, 30);
      await page.waitForTimeout(80);
    }
    await expect
      .poll(async () => dot(await heading(page), before))
      .toBeLessThan(0.97);
    // Back to neutral holds the heading; a tap makes the current pose neutral.
    // Brake meanwhile so the lumen assist does not steer along the vessel.
    await page.keyboard.down("Shift");
    await orient(page, 40, 0);
    const level = await settle(page);
    await page.waitForTimeout(250);
    expect(dot(await heading(page), level)).toBeGreaterThan(0.999);
    const client = await page.context().newCDPSession(page);
    const touch = (type, x, y) =>
      client.send("Input.dispatchTouchEvent", {
        type,
        touchPoints: type === "touchEnd" ? [] : [{ x, y }],
      });
    // Release the brake first: the braking hint would overwrite the message.
    await page.keyboard.up("Shift");
    await orient(page, 40, 30);
    await touch("touchStart", 120, 600);
    await touch("touchEnd", 120, 600);
    await expect(page.locator("#ocean")).toHaveAttribute("data-tilt-recentres", "1");
    await expect(page.locator("#stick")).toBeHidden();
    await page.keyboard.down("Shift");
    await orient(page, 40, 30);
    const recentred = await settle(page);
    await page.waitForTimeout(250);
    expect(dot(await heading(page), recentred)).toBeGreaterThan(0.999);
    await page.keyboard.up("Shift");
    await expect(page.locator("#turn")).toBeVisible();
    const brake = await page.locator("#brake").boundingBox();
    await touch("touchStart", brake.x + brake.width / 2, brake.y + brake.height / 2);
    await expect(page.locator("#brake")).toHaveAttribute("aria-pressed", "true");
    const position = await page.locator("#ocean").getAttribute("data-position");
    await page.waitForTimeout(250);
    expect(await page.locator("#ocean").getAttribute("data-position")).toBe(
      position,
    );
    await page.screenshot({ path: test.info().outputPath("vessel-controls-phone.png") });
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
