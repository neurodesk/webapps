import assert from "node:assert/strict";
import { mkdir, mkdtemp, cp, rm } from "node:fs/promises";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";
import { serveSite } from "../test-utils/serve-site.mjs";
import { repoRoot } from "../scripts/lib/apps-registry.mjs";

const site = await serveSite(join(repoRoot, "apps", "easy-mp2rage", "dist"));
const browser = await chromium.launch();
const bidsDirectory = await mkdtemp(join(process.env.TMPDIR, "mp2rage-bids-"));
const anatomy = join(bidsDirectory, "sub-001", "anat");
await mkdir(anatomy, { recursive: true });
for (const [input, output] of [
  ["UNI", "UNIT1"],
  ["UNI", "inv-1_MP2RAGE"],
  ["INV2", "inv-2_MP2RAGE"],
]) {
  await cp(
    join(
      repoRoot,
      "apps/easy-mp2rage/tools/phantom",
      `phantom_${input}.nii.gz`
    ),
    join(anatomy, `sub-001_${output}.nii.gz`)
  );
}
const artifacts = process.env.INTERFACE_ARTIFACTS;
if (artifacts) await mkdir(artifacts, { recursive: true });
try {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({
      viewport: { width, height: 900 },
      hasTouch: width === 390,
      isMobile: width === 390,
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route(/googletagmanager\.com|google-analytics\.com/, (route) =>
      route.fulfill({ body: "" })
    );
    await page.goto(`${site.origin}/`);
    await expect(page.locator(".nd-imaging-workspace")).toHaveCount(1);
    await expect(page.locator(".nd-app-bar:visible")).toHaveCount(1);
    await expect(page.locator("#emptyState")).toBeVisible();
    await expect(page.locator("#technicalLog")).toHaveClass(/collapsed/);
    await expect
      .poll(
        async () => {
          const bounds = await page.locator("#status").boundingBox();
          return bounds.y >= 0 && bounds.y + bounds.height <= 901;
        },
        { message: "status stays in the viewport" }
      )
      .toBe(true);
    if (artifacts)
      await page.screenshot({
        animations: "disabled",
        path: join(artifacts, `mp2rage-${width}-entry.png`),
      });
    if (width === 1440) {
      const url = "**/phantom_UNI.nii.gz";
      await page.route(url, (route) =>
        route.fulfill({ status: 503, body: "Unavailable" })
      );
      await page
        .locator("[data-neurodesk-example]")
        .selectOption("synthetic-mp2rage");
      await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute(
        "data-example-state",
        "error"
      );
      await expect(page.locator("#run")).toBeDisabled();
      await page.unroute(url);
    }
    await page
      .locator("[data-neurodesk-example]")
      .selectOption("synthetic-mp2rage");
    await expect(page.locator("#run")).toBeEnabled({ timeout: 60000 });
    const primaryColour = await page.locator("#run").evaluate((el) => ({
      actual: getComputedStyle(el).backgroundColor,
      expected: getComputedStyle(el)
        .getPropertyValue("--nd-color-primary")
        .trim(),
    }));
    const resolvedPrimary = await page.evaluate((colour) => {
      const sample = document.createElement("span");
      sample.style.background = colour;
      document.body.append(sample);
      const value = getComputedStyle(sample).backgroundColor;
      sample.remove();
      return value;
    }, primaryColour.expected);
    await expect
      .poll(() =>
        page
          .locator("#run")
          .evaluate((el) => getComputedStyle(el).backgroundColor)
      )
      .toBe(resolvedPrimary);

    await page.locator("#parameterPanel > summary").click();
    await page.locator("#mp_tr").fill("4.4");
    await page.locator("#parameterPanel > summary").click();
    await page.locator("#parameterPanel > summary").click();
    await expect(page.locator("#mp_tr")).toHaveValue("4.4");
    await page.locator("#mp_tr").fill("4.3");
    // Wheel input must reach the run action without Playwright auto-scrolling it.
    await page.evaluate(() => {
      window.scrollTo(0, 0);
      document.querySelector("#controls").scrollTop = 0;
    });
    const region = await page.locator("#controls").boundingBox();
    await page.mouse.move(
      Math.min(region.x + region.width / 2, width - 10),
      Math.min(region.y + 200, 700)
    );
    await page.mouse.wheel(0, 850);
    await expect
      .poll(() =>
        page.evaluate(() =>
          Math.max(
            window.scrollY,
            document.querySelector("#controls").scrollTop
          )
        )
      )
      .toBeGreaterThan(0);
    await page.locator("#parameterPanel > summary").click();
    await page.locator("#run").click();
    await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(4, {
      timeout: 60000,
    });
    await expect(page.locator("#viewerWrap")).toBeVisible();
    await expect(page.locator("#emptyState")).toBeHidden();
    await page.locator("#resultList .nd-view-btn").nth(1).click();
    await expect(page.locator("#viewStat")).toContainText("B1");
    const downloadEvent = page.waitForEvent("download");
    await page.locator("#resultList .nd-download-btn").first().click();
    assert.equal((await downloadEvent).suggestedFilename(), "T1map.nii.gz");
    for (const id of ["slice_ax", "slice_co", "slice_sa"]) {
      await page.locator(`#${id}`).fill("2");
      await expect(page.locator(`#${id}`)).toHaveValue("2");
    }
    const overflow = await page.evaluate(() => {
      const width = innerWidth;
      return [
        ...document.querySelectorAll(
          "#sliders input, .nd-viewer-panel, #status"
        ),
      ]
        .filter((el) => el.checkVisibility())
        .filter((el) => {
          const rect = el.getBoundingClientRect();
          return rect.left < -1 || rect.right > width + 1;
        })
        .map((el) => el.id || el.className);
    });
    assert.deepEqual(overflow, []);
    await page.locator("#viewer").scrollIntoViewIfNeeded();
    if (artifacts)
      await page.screenshot({
        animations: "disabled",
        path: join(artifacts, `mp2rage-${width}-result.png`),
        fullPage: true,
      });
    await page.locator(".nd-app-bar [data-neurodesk-theme-toggle]").click();
    if (artifacts)
      await page.screenshot({
        animations: "disabled",
        path: join(artifacts, `mp2rage-${width}-light.png`),
        fullPage: true,
      });
    await page.locator("#modeBids").click();
    await expect(page.locator("#bidsRow")).toBeVisible();
    await expect(page.locator("#viewer .nd-viewer-canvas-wrapper")).toHaveCount(
      1
    );
    await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(0);
    await page.locator("#bidsInput").setInputFiles(bidsDirectory);
    await expect(page.locator("#bidsSummary")).toContainText("1 session");
    await page.locator("#bidsNext").click();
    await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(1, {
      timeout: 60000,
    });
    await expect(
      page.locator("#viewer > .nd-viewer-canvas-wrapper > #viewerWrap")
    ).toBeVisible();
    await expect(page.locator("#bidsTree")).toContainText("done");
    if (artifacts)
      await page.screenshot({
        animations: "disabled",
        path: join(artifacts, `mp2rage-${width}-bids.png`),
        fullPage: true,
      });
    assert.deepEqual(errors, []);
    console.log(
      `PASS Easy MP2RAGE shared workspace, scrolling, example, T1/B1 outputs and download at ${width}px`
    );
    await page.close();
  }
} finally {
  await browser.close();
  await site.close();
  await rm(bidsDirectory, { recursive: true, force: true });
}
