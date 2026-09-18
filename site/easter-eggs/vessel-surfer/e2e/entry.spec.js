import { test, expect } from "@playwright/test";
import { openGame } from "./open-game.js";
test("game is absent from catalog, loads only after the secret, closes and restores focus", async ({
  page,
}) => {
  const requests = [];
  page.on("request", (r) => requests.push(r.url()));
  await page.goto("/");
  await expect(page.locator("[data-app-card]")).not.toContainText([
    "Vessel Surfer",
  ]);
  expect(requests.some((url) => url.includes("/_play/"))).toBe(false);
  for (let i = 0; i < 4; i++) await page.locator("#under-the-surface").click();
  await expect(page.locator("iframe")).toHaveCount(0);
  await page.locator("#under-the-surface").click();
  await expect(page.locator("iframe")).toHaveCount(1);
  const box = await page.locator(".voyage-dialog").boundingBox();
  expect(box.x).toBe(0);
  expect(box.y).toBe(0);
  expect(box.width).toBe(page.viewportSize().width);
  expect(box.height).toBe(page.viewportSize().height);
  await page.getByRole("button", { name: "Close voyage", exact: true }).click();
  await expect(page.locator("iframe")).toHaveCount(0);
  await expect(page.locator("#under-the-surface")).toBeFocused();
  const game = await openGame(page);
  await expect(game.locator("#play")).toBeEnabled({ timeout: 30000 });
  await game.locator("#play").click();
  await page.keyboard.press("Escape");
  await expect(page.locator("iframe")).toHaveCount(0);
  await page.goto("/_play/vessel/");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator("#app-search")).toBeVisible();
});
