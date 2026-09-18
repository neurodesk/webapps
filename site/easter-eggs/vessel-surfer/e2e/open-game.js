import { expect } from "@playwright/test";
export async function openGame(page) {
  await page.goto("/");
  for (let i = 0; i < 5; i++) await page.locator("#under-the-surface").click();
  await expect(page.locator('iframe[title="Vessel Surfer"]')).toBeVisible();
  const frame = await (
    await page.locator("iframe").elementHandle()
  ).contentFrame();
  await frame.waitForSelector("#play");
  return frame;
}
