import { expect } from "@playwright/test";
// Follow the homepage footer link, then wait for the brain data to load.
export async function openGame(page) {
  await page.goto("/");
  await page.getByRole("link", { name: "Go surfing" }).click();
  await expect(page).toHaveURL(/\/surf\/$/);
  await expect(page.locator("#play")).toBeEnabled({ timeout: 60000 });
  return page;
}
