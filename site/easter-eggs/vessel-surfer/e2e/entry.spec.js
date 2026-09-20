import { test, expect } from "@playwright/test";
import { openGame } from "./open-game.js";
test("the footer link opens the game as its own page, without the app shell", async ({
  page,
}) => {
  const requests = [];
  page.on("request", (r) => requests.push(r.url()));
  await page.goto("/");
  await expect(page.locator("[data-app-card]")).not.toContainText([
    "Vessel Surfer",
  ]);
  expect(requests.some((url) => url.includes("/surf/"))).toBe(false);
  const link = page.getByRole("link", { name: "Go surfing" });
  await expect(link).toBeVisible();
  const footer = page.locator(".site-footer nav");
  await expect(footer).toContainText("About Neurodesk");
  await expect(page.locator("#under-the-surface")).toHaveCount(0);
  await openGame(page);
  await expect(page).toHaveTitle(/Vessel Surfer/);
  for (const name of ["About", "Cite", "Privacy", "Light", "Dark"])
    await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
  await expect(page.locator(".nd-imaging-app-header")).toHaveCount(0);
  await expect(page.locator("iframe")).toHaveCount(0);
  await expect(page.locator("#menu")).toBeVisible();
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
  await expect(page.getByText("Surf your own vessel mask", { exact: true })).toHaveCount(0);
  await expect(page.locator("#play")).toHaveText("Dive");
  await page.getByRole("link", { name: "Neurodesk Webapps" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator("#app-search")).toBeVisible();
});

test("brain loading can be retried without the removed upload panel", async ({ page }) => {
  let failed = false;
  await page.route("**/data/brain.json", async (route) => {
    if (!failed) {
      failed = true;
      await route.fulfill({ status: 503, body: "Temporarily unavailable" });
    } else await route.continue();
  });
  await page.goto("/surf/");
  await expect(page.getByRole("button", { name: "Retry loading brain" })).toBeVisible();
  await expect(page.locator("#mission-text")).toContainText("Could not load brain data");
  await page.getByRole("button", { name: "Retry loading brain" }).click();
  await expect(page.locator("#play")).toHaveText("Dive", { timeout: 60000 });
  await expect(page.locator("#play")).toBeEnabled();
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
});
