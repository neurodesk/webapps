// Real browser smoke test. Proves the deployed contract that Node tests cannot:
// cross-origin isolation, worker loading, and app boot. Runs against `vite preview`
// (see playwright.config.js) so it exercises the built, header-served output.
import { test, expect } from "@playwright/test";

async function clickKnownCanvasPointUntilLocationChanges(
  page,
  points,
  previousCount,
) {
  for (const point of points) {
    await page.mouse.click(point.x, point.y);
    const currentCount = await page.evaluate(() => window.__locationChangeCount);
    if (currentCount > previousCount) return point;
  }
  throw new Error("Canvas clicks did not change the crosshair location");
}

async function findInteractiveCanvasPoints(page, canvasBox, count = 4) {
  let previousCount = await page.evaluate(() => window.__locationChangeCount);
  const points = [];
  // NiiVue letterboxes slice tiles according to volume aspect ratio, so a
  // fixed canvas percentage is not guaranteed to contain image data. Probe a
  // compact CSS-pixel grid and retain proven points that map to distinct voxels.
  for (let yFraction = 0.1; yFraction < 0.95; yFraction += 0.05) {
    for (let xFraction = 0.1; xFraction < 0.95; xFraction += 0.05) {
      const x = canvasBox.x + canvasBox.width * xFraction;
      const y = canvasBox.y + canvasBox.height * yFraction;
      await page.mouse.click(x, y);
      const currentCount = await page.evaluate(() => window.__locationChangeCount);
      if (currentCount > previousCount) {
        points.push({ x, y });
        if (points.length === count) return points;
      }
      previousCount = currentCount;
    }
  }
  throw new Error(`Only ${points.length} interactive canvas points were found`);
}

test("app boots", async ({ page }) => {
  await page.goto("/?source=custom");
  await expect(page.locator(".nd-imaging-workspace")).toBeVisible();
  await expect(page.locator("#nv-canvas")).toBeVisible();
  await expect(page.locator("#source")).toHaveValue("custom");
  await expect(page.locator("#source option")).toHaveText(["DANDI Archive", "OME-Zarr URL"]);
  await expect(page.getByText("DANDI LEC SPIM example", { exact: true })).toHaveCount(0);
  await expect(page.locator("#dandiArchiveControl")).toBeHidden();
  await expect(page.locator("#zarrUrlControl")).toBeVisible();
  await page.getByLabel("OME-Zarr store URL 1").fill("https://example.org/test.ome.zarr");
  await expect(page.getByRole("button", { name: "Remove OME-Zarr store 1" })).toBeEnabled();
  await page.getByRole("button", { name: "Remove OME-Zarr store 1" }).click();
  await expect(page.getByLabel("OME-Zarr store URL 1")).toHaveValue("");
  await expect(page).not.toHaveURL(/url=/);
  await expect(page.getByRole("button", { name: "Apply" })).toBeDisabled();
  await expect(page.locator("#scrollZoomSpeed")).toHaveValue("5");
  await expect(page.locator("#scrollZoomSpeed")).toHaveAttribute("max", "10");
  await expect(page.locator("#detailBudget")).toHaveValue("8");
  await expect(page.locator("#scrollZoomSpeed")).toBeHidden();
  await expect(page.locator("#detailBudget")).toBeHidden();
  await expect(page.locator("#showStats")).toBeHidden();
  await expect(page.getByText("Advanced", { exact: true })).toBeVisible();
  await expect(page.locator("#panX")).toBeHidden();
  await expect(page.locator("#panY")).toBeHidden();
  await expect(page.locator("#panZ")).toBeHidden();
  await expect(page.getByText("Pan Z", { exact: true })).toHaveCount(0);
  await expect(page.locator("#axialSlice")).toBeVisible();
  const topBar = page.locator(".nd-app-bar:visible");
  await expect(topBar).toHaveCount(1);
  await expect(topBar.locator(".nd-app-bar__identity")).toContainText("ZARRo");
  await expect(topBar.locator(".nd-app-bar__version")).toHaveText(/^v\d+\.\d+/);
  for (const name of ["About", "Cite", "Privacy", "More Apps", "GitHub"]) {
    await expect(topBar.getByRole(name === "More Apps" || name === "GitHub" ? "link" : "button", { name })).toBeVisible();
  }
  await expect(topBar.locator("[data-neurodesk-theme-toggle]")).toBeVisible();
  await expect(page.getByText("Export area", { exact: true })).toHaveCount(0);
  await expect(page.locator("#exportMode")).toHaveCount(0);
  await expect(page.getByText("Browser streamed", { exact: true })).toHaveCount(0);
  await expect(page.locator(".viewer-badge")).toHaveCount(0);
  await expect(page.getByText("Only visible chunks are fetched from the source.")).toHaveCount(0);
  await expect(page.getByText("Volume data stays in this browser tab.")).toHaveCount(0);
  await expect(page.getByText("Chunk spacing", { exact: true })).toHaveCount(0);
  await expect(page.locator("#status")).toBeHidden();
});

test("page is cross-origin isolated (COOP/COEP active)", async ({ page }) => {
  await page.goto("/?source=custom");
  // Threaded ONNX Runtime needs this; asserts _headers (or the COI service worker) worked.
  const isolated = await page.evaluate(() => self.crossOriginIsolated === true);
  expect(isolated).toBe(true);
});

test("a web worker loads and responds", async ({ page }) => {
  await page.goto("/?source=custom");
  const ok = await page.evaluate(async () => {
    // Inline classic worker — mirrors the apps' importScripts worker style.
    const src = "self.onmessage = () => self.postMessage('pong');";
    const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
    const w = new Worker(url);
    return await new Promise((resolve) => {
      w.onmessage = (e) => resolve(e.data === "pong");
      w.onerror = () => resolve(false);
      w.postMessage("ping");
    });
  });
  expect(ok).toBe(true);
});

test("translated OME-Zarr URLs load as one composite volume", async ({ page }) => {
  // This exercises the complete translated-mosaic interaction surface. GitHub's
  // shared runners can take more than a minute even though every request is
  // locally mocked, so leave enough headroom for the browser assertions.
  test.setTimeout(600_000);
  const cancelledChunkErrors = [];
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      message.text().includes("chunk upload failed AbortError")
    ) {
      cancelledChunkErrors.push(message.text());
    }
  });
  await page.addInitScript(() => {
    window.__locationChangeCount = 0;
    window.__copiedText = "";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text) => {
          window.__copiedText = text;
        },
      },
    });
    const dispatchEvent = EventTarget.prototype.dispatchEvent;
    EventTarget.prototype.dispatchEvent = function (event) {
      if (event.type === "locationChange") {
        window.__locationChangeCount++;
      }
      return dispatchEvent.call(this, event);
    };
  });

  let leftChunkRequests = 0;
  let rightChunkRequests = 0;
  const chunkRequestsByLevel = new Map();
  let delayLevelOneChunks = false;
  let delayedLevelOneChunkRequests = 0;
  const group = JSON.stringify({ zarr_format: 2 });
  await page.route("**/test-mosaic/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const isRight = path.includes("/right/");
    if (path.endsWith("/.zgroup")) {
      await route.fulfill({ contentType: "application/json", body: group });
    } else if (path.endsWith("/.zattrs") && !/\/\d+\/\.zattrs$/.test(path)) {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          multiscales: [{
            axes: [
              { name: "z", unit: "millimeter" },
              { name: "y", unit: "millimeter" },
              { name: "x", unit: "millimeter" },
            ],
            datasets: [0, 1, 2, 3].map((level) => ({
              path: String(level),
              coordinateTransformations: [
                { type: "scale", scale: [0.001, 0.001, 0.001].map((value) => value * 2 ** level) },
                // Deliberately fractional and overlapping at every level.
                { type: "translation", translation: [0, 0, isRight ? 0.0135 : 0] },
              ],
            })),
          }],
        }),
      });
    } else if (/\/\d+\/\.zarray$/.test(path)) {
      const level = Number(path.match(/\/(\d+)\/\.zarray$/)?.[1] ?? 0);
      const size = 16 / 2 ** level;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          zarr_format: 2,
          shape: [size, size, size],
          chunks: [size, size, size],
          dtype: "|u1",
          compressor: null,
          fill_value: 0,
          order: "C",
          filters: null,
        }),
      });
    } else if (/\/\d+\/\.zattrs$/.test(path)) {
      await route.fulfill({ contentType: "application/json", body: "{}" });
    } else if (/\/\d+\/0\.0\.0$/.test(path)) {
      const level = Number(path.match(/\/(\d+)\/0\.0\.0$/)?.[1] ?? 0);
      const size = 16 / 2 ** level;
      if (delayLevelOneChunks && level === 1) {
        delayedLevelOneChunkRequests++;
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
      chunkRequestsByLevel.set(
        level,
        (chunkRequestsByLevel.get(level) ?? 0) + 1,
      );
      if (isRight) rightChunkRequests++;
      else leftChunkRequests++;
      await route.fulfill({
        contentType: "application/octet-stream",
        body: Buffer.alloc(size ** 3, isRight ? 180 : 60),
      });
    } else {
      await route.fulfill({ status: 404, body: "not found" });
    }
  });

  await page.goto("/?source=custom&level=0&zarrLevel=0&stats=1");
  await page.getByLabel("OME-Zarr store URL 1").fill("http://localhost:4173/test-mosaic/left");
  await page.getByRole("button", { name: "Add another URL" }).click();
  await page.getByLabel("OME-Zarr store URL 2").fill("http://localhost:4173/test-mosaic/right");
  await page.getByRole("button", { name: "Load volume" }).click();

  await expect(page.locator("#activeLevel")).toHaveAttribute(
    "data-fov-levels",
    "0",
    { timeout: 15_000 },
  );
  await expect(page.locator("#activeLevel")).toHaveText("L0");
  await expect(page.locator("#axialSlice")).toHaveAttribute("min", "0");
  await expect(page.locator("#axialSlice")).toHaveAttribute("max", "15");
  await expect(page.locator("#axialSliceHelp")).toContainText("arrow keys in the viewer");
  for (let index = 0; index < 4; index++) {
    await page.locator("#nv-canvas").dispatchEvent("wheel", {
      deltaY: -120,
      deltaMode: 0,
    });
  }
  await page.locator("#axialSlice").fill("4");
  await expect(page.locator("#axialSliceValue")).toHaveText("5 / 16");
  await expect(page.locator("#panZ")).not.toHaveValue("0");
  await page.waitForTimeout(250);
  await expect.poll(async () => {
    const path = await page.locator("#crosshairLines").getAttribute("d");
    return path?.match(/M/g)?.length ?? 0;
  }).toBe(12);
  for (let index = 0; index < 4; index++) {
    await page.locator("#nv-canvas").dispatchEvent("wheel", {
      deltaY: 120,
      deltaMode: 0,
    });
  }
  await page.locator("#zoom").fill("0");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.locator("#activeLevel")).toHaveAttribute(
    "data-fov-levels",
    "0",
  );
  await page.locator("#nv-canvas").focus();
  await expect(page.locator("#nv-canvas")).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#axialSlice")).toHaveValue("5");
  await expect(page.locator("#axialSliceValue")).toHaveText("6 / 16");
  await page.locator("#layout").selectOption("1");
  await expect(page.locator("#axialSlice")).toBeEnabled();
  await page.locator("#layout").selectOption("2");
  await expect(page.locator("#axialSlice")).toBeEnabled();
  await page.locator("#layout").selectOption("31");
  await expect(page.locator("#nv-canvas")).toHaveAttribute(
    "data-crosshair-visible",
    "1",
  );
  await expect(page.locator("#crosshairOverlay")).toBeVisible();
  await expect(page.locator("#crosshairLines")).toHaveAttribute("d", /^M/);
  await page.locator("#showCrosshair").uncheck();
  await expect(page.locator("#crosshairOverlay")).toBeHidden();
  await page.locator("#showCrosshair").check();
  await expect(page.locator("#crosshairOverlay")).toBeVisible();
  expect(await page.locator("#activeLevel").evaluate(
    (output) => output.scrollWidth <= output.clientWidth,
  )).toBe(true);
  await expect(page.locator("#activeLevel")).toHaveAttribute(
    "title",
    /Composite of 2 translated stores/,
  );
  await expect(page.locator("#fallback")).toHaveAttribute("aria-hidden", "true");
  await expect(page).toHaveURL(/url=.*test-mosaic%2Fleft.*url=.*test-mosaic%2Fright/);
  await expect(page.locator("#downloadNifti")).toBeEnabled();
  await expect.poll(() => leftChunkRequests).toBeGreaterThan(0);
  await expect.poll(() => rightChunkRequests).toBeGreaterThan(0);
  await expect.poll(async () => {
    const details = await page.locator("#hud").innerText();
    return Number(details.match(/resident\s+(\d+) resident/)?.[1] ?? 0);
  }).toBeGreaterThan(0);
  const boundedPlanSize = Number(
    (await page.locator("#hud").innerText()).match(/requested\s+\d+\s*\/\s*(\d+)/)?.[1] ?? 0,
  );
  expect(boundedPlanSize).toBeGreaterThan(0);
  expect(boundedPlanSize).toBeLessThanOrEqual(1024);

  const downloadPromise = page.waitForEvent("download");
  await page.locator("#downloadNifti").click();
  const niftiDownload = await downloadPromise;
  expect(niftiDownload.suggestedFilename()).toBe(
    "omezarr-mosaic-2-stores-L0-fov.nii",
  );
  await expect(page.locator("#downloadStatus")).toHaveText(
    "Download started: omezarr-mosaic-2-stores-L0-fov.nii",
  );

  const canvasBox = await page.locator("#nv-canvas").boundingBox();
  expect(canvasBox).not.toBeNull();
  const interactivePoints = await findInteractiveCanvasPoints(page, canvasBox);
  const interactivePoint = interactivePoints[0];
  const startX = interactivePoint.x;
  const startY = interactivePoint.y;
  const dragX = startX < canvasBox.x + canvasBox.width * 0.5 ? 40 : -40;
  const dragY = startY < canvasBox.y + canvasBox.height * 0.5 ? 20 : -20;
  const panFields = ["#panX", "#panY", "#panZ"];
  const panBefore = await Promise.all(
    panFields.map((selector) => page.locator(selector).inputValue()),
  );
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + dragX, startY + dragY, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => {
    const panAfter = await Promise.all(
      panFields.map((selector) => page.locator(selector).inputValue()),
    );
    return panAfter.some((value, index) => value !== panBefore[index]);
  }).toBe(true);

  const panBeforeClick = await Promise.all(
    panFields.map((selector) => page.locator(selector).inputValue()),
  );
  const locationChangesBefore = await page.evaluate(
    () => window.__locationChangeCount,
  );
  await clickKnownCanvasPointUntilLocationChanges(
    page,
    interactivePoints,
    locationChangesBefore,
  );
  await expect.poll(async () => Promise.all(
    panFields.map((selector) => page.locator(selector).inputValue()),
  )).toEqual(panBeforeClick);

  const chunkRequestsBeforeWindowing = leftChunkRequests + rightChunkRequests;
  await page.locator("#windowLevel").evaluate((input) => {
    input.value = "60";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.locator("#windowWidth").evaluate((input) => {
    input.value = "20";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(page.locator("#windowLevel")).toHaveValue("60");
  await expect(page.locator("#windowWidth")).toHaveValue("20");
  expect(leftChunkRequests + rightChunkRequests).toBe(chunkRequestsBeforeWindowing);
  await expect(page.locator("#windowMin")).toHaveValue("50");
  await expect(page.locator("#windowMax")).toHaveValue("70");
  await expect(page.locator("#nv-canvas")).toHaveAttribute("data-window-min", "50");
  await expect(page.locator("#nv-canvas")).toHaveAttribute("data-window-max", "70");

  await page.locator("#windowLevel").evaluate((input) => {
    input.value = "10";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.locator("#windowWidth").evaluate((input) => {
    input.value = "100";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(page.locator("#windowMin")).toHaveValue("-40");
  await expect(page.locator("#windowMax")).toHaveValue("60");

  await page.locator("#windowLevel").evaluate((input) => {
    input.value = "60";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.locator("#windowWidth").evaluate((input) => {
    input.value = "20";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(page.locator("#windowRangeValue")).toHaveText("50–70");

  await page.locator("#windowMin").fill("40");
  await page.locator("#windowMax").fill("100");
  await expect(page.locator("#windowLevel")).toHaveValue("70");
  await expect(page.locator("#windowWidth")).toHaveValue("60");

  await page.locator("#windowLevel").evaluate((input) => {
    input.value = "60";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.locator("#windowWidth").evaluate((input) => {
    input.value = "20";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(page.locator("#windowMin")).toHaveValue("50");
  await expect(page.locator("#windowMax")).toHaveValue("70");

  const measureButton = page.getByRole("button", { name: "Measure distance" });
  await expect(measureButton).toHaveAttribute("aria-pressed", "false");
  await measureButton.click();
  await expect(measureButton).toHaveAttribute("aria-pressed", "true");
  const measureEndX = startX + dragX * 0.8;
  const measureEndY = startY + dragY * 0.8;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(measureEndX, measureEndY, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator("#measurementStatus")).toContainText("µm");
  await expect(page.locator("#measurementStatus")).toContainText("right-click to remove");
  await page.mouse.click(
    (startX + measureEndX) * 0.5,
    (startY + measureEndY) * 0.5,
    { button: "right" },
  );
  await expect(page.locator("#clearMeasurements")).toBeDisabled();
  await expect(page.locator("#measurementStatus")).toHaveText("drag across a structure");
  await measureButton.click();
  await expect(measureButton).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#measurementStatus")).toHaveText("crosshair movement active");
  const locationChangesAfterMeasurement = await page.evaluate(
    () => window.__locationChangeCount,
  );
  await clickKnownCanvasPointUntilLocationChanges(
    page,
    interactivePoints,
    locationChangesAfterMeasurement,
  );

  await page.getByText("Advanced", { exact: true }).click();
  await expect(page.getByLabel("Stream details")).toBeVisible();
  await page.locator("#scrollZoomSpeed").fill("3");
  await expect(page.locator("#scrollZoomSpeedValue")).toHaveText("3×");
  await page.locator("#detailBudget").fill("8");
  await expect(page.locator("#detailBudgetValue")).toHaveText("8 GiB");
  await expect(page).toHaveURL(/detailBudget=8/);
  await page.locator("#zoom").fill("2");
  await expect(page.locator("#zoomValue")).toHaveText("L2 · pending");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.locator("#zoomValue")).toHaveText("L2");
  await expect(page.locator("#activeLevel")).toHaveAttribute("data-fov-levels", "2");
  await page.locator("#showScaleBar").uncheck();
  await expect(page.locator("#visibleLevel")).toBeHidden();
  await expect(page.locator("#scaleIndicators")).toBeHidden();
  await page.locator("#showScaleBar").check();
  await expect(page.locator("#visibleLevel")).toBeVisible();
  await expect(page.locator("#tileLoading")).toBeVisible();
  await expect(page.locator("#tileLoading")).toHaveAttribute("data-loading", /\d+/);
  await expect(page.locator("#nv-canvas")).toHaveAttribute(
    "data-crosshair-width",
    "2",
  );
  await expect(page.locator("#nv-canvas")).toHaveAttribute(
    "data-crosshair-gap",
    "8",
  );
  const sharedPan = await Promise.all(
    panFields.map((selector) => page.locator(selector).inputValue()),
  );
  await page.getByRole("button", { name: "Copy share link" }).click();
  await expect(page.locator("#shareStatus")).toContainText("Link copied");
  const sharedUrl = await page.evaluate(() => window.__copiedText);
  const sharedParams = new URL(sharedUrl).searchParams;
  expect(sharedParams.getAll("url")).toHaveLength(2);
  expect(sharedParams.get("layout")).toBe("31");
  expect(sharedParams.get("zoom")).toBe("2");
  expect(sharedParams.get("wl")).toBe("60");
  expect(sharedParams.get("ww")).toBe("20");
  expect(sharedParams.get("scrollZoomSpeed")).toBe("3");
  expect(sharedParams.get("detailBudget")).toBe("8");
  expect(sharedParams.get("pan")).toBeTruthy();
  expect(sharedParams.get("crosshair")).toBeTruthy();

  await page.goto(sharedUrl);
  await expect(page.locator("#activeLevel")).toHaveAttribute("data-fov-levels", "2");
  await expect(page.locator("#windowLevel")).toHaveValue("60");
  await expect(page.locator("#windowWidth")).toHaveValue("20");
  await expect(page.locator("#scrollZoomSpeed")).toHaveValue("3");
  await expect(page.locator("#detailBudget")).toHaveValue("8");
  await expect(page.locator("#zoom")).toHaveValue("2");
  await expect.poll(async () => {
    const restoredPan = await Promise.all(
      panFields.map((selector) => page.locator(selector).inputValue()),
    );
    return Math.max(
      ...restoredPan.map((value, index) =>
        Math.abs(Number(value) - Number(sharedPan[index]))
      ),
    );
  }).toBeLessThanOrEqual(1);

  await expect(page.locator("#zoomValue")).toHaveText("L2");
  delayLevelOneChunks = true;
  await page.locator("#zoom").fill("1");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.locator("#activeLevel")).toContainText("target L1");
  await expect.poll(() => delayedLevelOneChunkRequests).toBeGreaterThan(0);
  await expect.poll(async () => Number(
    await page.locator("#tileLoading").getAttribute("data-loading"),
  )).toBeGreaterThan(0);

  // Start a newer LOD request while L1 chunks are still delayed. The latest
  // plan must win, and a crosshair click made during the swap must survive.
  await page.locator("#zoom").fill("0");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.locator("#activeLevel")).toContainText("target L0");
  const locationChangesBeforeReloadClick = await page.evaluate(
    () => window.__locationChangeCount,
  );
  await clickKnownCanvasPointUntilLocationChanges(
    page,
    interactivePoints,
    locationChangesBeforeReloadClick,
  );
  await page.getByRole("button", { name: "Copy share link" }).click();
  const clickedCrosshair = new URL(
    await page.evaluate(() => window.__copiedText),
  ).searchParams.get("crosshair");

  await expect(page.locator("#activeLevel")).toHaveAttribute("data-fov-levels", "0");
  await page.waitForTimeout(900);
  await expect(page.locator("#activeLevel")).toHaveAttribute("data-fov-levels", "0");
  expect(cancelledChunkErrors).toEqual([]);
  await expect(page.locator("#visibleLevel")).toHaveText("L0");
  await page.getByText("Advanced", { exact: true }).click();
  await page.getByLabel("Stream details").check();
  await expect(page.locator("#hud")).toContainText("30 x 16 x 16 uint8");
  expect(chunkRequestsByLevel.get(0)).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Copy share link" }).click();
  const settledCrosshair = new URL(
    await page.evaluate(() => window.__copiedText),
  ).searchParams.get("crosshair");
  expect(settledCrosshair).toBe(clickedCrosshair);

  await page.getByRole("button", { name: "Remove OME-Zarr store 2" }).click();
  await expect(page.getByLabel("OME-Zarr store URL 2")).toHaveCount(0);
  await expect(page).not.toHaveURL(/test-mosaic%2Fright/);
  await expect(page).toHaveURL(/test-mosaic%2Fleft/);
  await expect(page.locator("#activeLevel")).not.toContainText("2 translated stores");
});

test("DANDI assets are grouped by stain and selectable as a chunk set", async ({ page }) => {
  const zarrIds = [
    "56509720-870c-4f43-ae41-7b75f9590722",
    "b2802fac-cb30-4c25-bd16-09666706c91a",
    "e8633ce6-0922-4de1-a453-8ffbed48f1d2",
  ];
  let requestedGlob = "";
  await page.route("https://api.dandiarchive.org/api/dandisets/000108/versions/draft/assets/**", async (route) => {
    requestedGlob = new URL(route.request().url()).searchParams.get("glob") ?? "";
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        count: 3,
        next: null,
        previous: null,
        results: [10, 2, 1].map((chunk, index) => ({
          asset_id: `asset-${chunk}`,
          path: `sub-MITU01/ses-test/micr/sub-MITU01_ses-test_sample-127_stain-LEC_run-1_chunk-${chunk}_SPIM.ome.zarr`,
          size: 37_700_000_000,
          zarr: zarrIds[index],
        })),
      }),
    });
  });

  await page.goto("/?source=dandi");
  await expect(page.locator("#dandiArchiveControl")).toBeVisible();
  await expect(page.locator("#zarrUrlControl")).toBeHidden();
  await expect(page.getByRole("button", { name: "Clear all selected stores" })).toBeDisabled();
  await page.locator("#dandiQuery").fill("sample-127 LEC");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.locator("#dandiSearchStatus")).toContainText("Showing 3 OME-Zarr stores in 1 stain group");
  expect(requestedGlob).toBe("*sample-127*LEC*.ome.zarr");
  await expect(page.getByText("Subject MITU01", { exact: true })).toBeVisible();
  await expect(page.getByText("Sample 127", { exact: true })).toBeVisible();
  await expect(page.locator(".dandi-stain-group")).toContainText("LEC");
  await page.getByText("Review 3 chunks", { exact: true }).click();
  await expect(page.locator(".dandi-result strong")).toHaveText([
    "Chunk 1",
    "Chunk 2",
    "Chunk 10",
  ]);
  await expect(page.getByRole("button", { name: "Add selected stores" })).toHaveCount(0);
  await expect(page.locator(".dandi-add-store")).toHaveCount(3);
  await page.getByRole("button", { name: "Add Chunk 1 store" }).click();
  await expect(page.locator("#dandiSelectedStores .selected-store-row")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Add Chunk 1 store" })).toBeDisabled();
  await page.getByRole("button", { name: "Add all 3 LEC chunks from sample 127" }).click();
  await expect(page.locator("#source")).toHaveValue("dandi");
  await expect(page.locator("#dandiSelectedStores .selected-store-row")).toHaveCount(3);
  await expect(page.locator("#dandiSelectedStores")).toContainText("chunk-1_SPIM.ome.zarr");
  await expect(page.getByRole("button", { name: "Clear all selected stores" })).toBeEnabled();
  await expect(page).toHaveURL(new RegExp(`url=.*${zarrIds[0]}`));
  await expect(page).toHaveURL(/source=dandi/);
  await page.getByRole("button", { name: "Clear all selected stores" }).click();
  await expect(page.locator("#dandiSelectedStores")).toBeHidden();
  await expect(page.getByRole("button", { name: "Clear all selected stores" })).toBeDisabled();
  await expect(page.locator("#dandiSearchStatus")).toHaveText("All selected stores cleared.");
  await expect(page).not.toHaveURL(new RegExp(`url=.*${zarrIds[0]}`));
});

test("generic uint16 share contrast is replaced from streamed signal", async ({ page }) => {
  const group = JSON.stringify({ zarr_format: 2 });
  const values = Buffer.alloc(8 * 8 * 8 * 2);
  for (let index = 64; index < 8 * 8 * 8; index++) {
    values.writeUInt16LE(500 + ((index * 37) % 6001), index * 2);
  }
  await page.route("**/test-auto-window/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/.zgroup")) {
      await route.fulfill({ contentType: "application/json", body: group });
    } else if (path.endsWith("/.zattrs") && !path.endsWith("/0/.zattrs")) {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          multiscales: [{
            axes: [
              { name: "z", unit: "millimeter" },
              { name: "y", unit: "millimeter" },
              { name: "x", unit: "millimeter" },
            ],
            datasets: [{
              path: "0",
              coordinateTransformations: [{
                type: "scale",
                scale: [0.001, 0.001, 0.001],
              }],
            }],
          }],
        }),
      });
    } else if (path.endsWith("/0/.zarray")) {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          zarr_format: 2,
          shape: [8, 8, 8],
          chunks: [8, 8, 8],
          dtype: "<u2",
          compressor: null,
          fill_value: 0,
          order: "C",
          filters: null,
        }),
      });
    } else if (path.endsWith("/0/.zattrs")) {
      await route.fulfill({ contentType: "application/json", body: "{}" });
    } else if (path.endsWith("/0/0.0.0")) {
      await route.fulfill({
        contentType: "application/octet-stream",
        body: values,
      });
    } else {
      await route.fulfill({ status: 404, body: "not found" });
    }
  });

  const storeUrl = encodeURIComponent("http://localhost:4173/test-auto-window/store");
  await page.goto(
    `/?source=custom&level=0&url=${storeUrl}&wl=32768&ww=65535&layout=31`,
  );

  await expect(page.locator("#activeLevel")).toHaveAttribute("data-fov-levels", "0", {
    timeout: 15_000,
  });
  await expect.poll(async () => Number(await page.locator("#windowWidth").inputValue()))
    .toBeLessThan(10_000);
  await expect.poll(async () => Number(await page.locator("#windowLevel").inputValue()))
    .toBeLessThan(5_000);
  await expect(page.locator("#fallback")).toHaveAttribute("aria-hidden", "true");

  await page.goto(
    `/?source=custom&level=0&url=${storeUrl}&wl=1000&ww=500&layout=31`,
  );
  await expect(page.locator("#activeLevel")).toHaveAttribute("data-fov-levels", "0");
  await page.waitForTimeout(500);
  await expect(page.locator("#windowLevel")).toHaveValue("1000");
  await expect(page.locator("#windowWidth")).toHaveValue("500");

  const canvasBeforeAutoContrast = await page.locator("#nv-canvas").screenshot();
  const autoContrast = page.getByRole("button", { name: "Auto contrast" });
  await expect(autoContrast).toBeEnabled();
  await autoContrast.click();
  await expect.poll(async () => Number(await page.locator("#windowWidth").inputValue()))
    .toBeLessThan(10_000);
  await expect.poll(async () => Number(await page.locator("#windowLevel").inputValue()))
    .toBeGreaterThan(2_000);
  await expect.poll(async () => {
    const canvasAfterAutoContrast = await page.locator("#nv-canvas").screenshot();
    return canvasAfterAutoContrast.equals(canvasBeforeAutoContrast);
  }).toBe(false);
});

test("zoom control represents OME-Zarr levels directly", async ({ page }) => {
  const shapes = [
    [1, 1, 2048, 2048, 13125],
    [1, 1, 1024, 1024, 6563],
    [1, 1, 512, 512, 3282],
    [1, 1, 256, 256, 1641],
    [1, 1, 128, 128, 821],
    [1, 1, 64, 64, 411],
    [1, 1, 32, 32, 206],
  ];
  await page.route("**/test-pyramid/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/.zgroup")) {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ zarr_format: 2 }),
      });
      return;
    }
    if (path.endsWith("/.zattrs") && !/\/\d+\/\.zattrs$/.test(path)) {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          multiscales: [{
            axes: [
              { name: "t" },
              { name: "c" },
              { name: "z", unit: "millimeter" },
              { name: "y", unit: "millimeter" },
              { name: "x", unit: "millimeter" },
            ],
            datasets: shapes.map((_, level) => ({
              path: String(level),
              coordinateTransformations: [{
                type: "scale",
                scale: [1, 1, 2 ** level, 2 ** level, 2 ** level],
              }],
            })),
          }],
        }),
      });
      return;
    }
    const arrayMatch = path.match(/\/(\d+)\/\.zarray$/);
    if (arrayMatch) {
      const level = Number(arrayMatch[1]);
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          zarr_format: 2,
          shape: shapes[level],
          chunks: [1, 1, 128, 128, 128],
          dtype: "|u1",
          compressor: null,
          fill_value: 0,
          order: "C",
          filters: null,
        }),
      });
      return;
    }
    if (/\/\d+\/\.zattrs$/.test(path)) {
      await route.fulfill({ contentType: "application/json", body: "{}" });
      return;
    }
    await route.fulfill({ status: 404, body: "missing chunk" });
  });

  await page.goto("/?source=custom");
  await page.getByLabel("OME-Zarr store URL 1").fill("http://localhost:4173/test-pyramid/store");
  await page.getByRole("button", { name: "Load volume" }).click();
  await expect(page.locator("#zoom")).toHaveValue("6");
  await expect(page.locator("#zoomValue")).toHaveText("L6 · overview");
  await expect(page.locator("#activeLevel")).toHaveAttribute("data-fov-levels", "6");
  await expect(page.locator("#activeLevel")).toHaveAttribute("data-requested-level", "6");
  await expect(page.locator("#activeLevel")).toHaveAttribute("data-delivered-level", "6");
  await page.locator("#zoom").fill("4");
  await expect(page.locator("#zoomValue")).toHaveText("L4 · pending");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.locator("#activeLevel")).toHaveAttribute("data-fov-levels", "4");
  await expect(page.locator("#activeLevel")).toHaveAttribute("data-requested-level", "4");
  await expect(page.locator("#activeLevel")).toHaveAttribute("data-delivered-level", "4");
  await expect(page.locator("#visibleLevel")).toHaveText("L4");
  await expect(page.locator("#zoomValue")).toHaveText("L4");
  await page.getByRole("button", { name: "Copy share link" }).click();
  const levelFourUrl = page.url();
  await page.goto(levelFourUrl);
  await expect(page.locator("#zoom")).toHaveValue("4");
  await expect(page.locator("#zoomValue")).toHaveText("L4");
  await expect(page.locator("#activeLevel")).toHaveAttribute("data-fov-levels", "4");
  await expect(page.locator("#visibleLevel")).toHaveText("L4");
  await page.locator("#zoom").fill("5");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.locator("#activeLevel")).toHaveAttribute(
    "data-fov-levels",
    "5",
    { timeout: 10_000 },
  );
  await expect(page.locator("#activeLevel")).toHaveText("L5");
  await expect(page.locator("#visibleLevel")).toHaveText("L5");
  await expect(page.locator("#zoomValue")).toHaveText("L5");
});
