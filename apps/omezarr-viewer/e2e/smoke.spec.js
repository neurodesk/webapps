// Real browser smoke test. Proves the deployed contract that Node tests cannot:
// cross-origin isolation, worker loading, and app boot. Runs against `vite preview`
// (see playwright.config.js) so it exercises the built, header-served output.
import { test, expect } from "@playwright/test";

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
  let delayLevelMetadata = false;
  let delayedMetadataRequests = 0;
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
      if (delayLevelMetadata) {
        delayedMetadataRequests++;
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
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

  await page.goto("/?source=custom&level=0&zarrLevel=0");
  await page.getByLabel("OME-Zarr store URL 1").fill("http://localhost:4173/test-mosaic/left");
  await page.getByRole("button", { name: "Add another URL" }).click();
  await page.getByLabel("OME-Zarr store URL 2").fill("http://localhost:4173/test-mosaic/right");
  await page.getByRole("button", { name: "Load volume" }).click();

  await expect(page.locator("#activeLevel")).toHaveText(/L0 · 2 translated stores/);
  await expect(page.locator("#fallback")).toHaveAttribute("aria-hidden", "true");
  await expect(page).toHaveURL(/url=.*test-mosaic%2Fleft.*url=.*test-mosaic%2Fright/);
  await expect(page.locator("#downloadNifti")).toBeEnabled();
  await expect.poll(() => leftChunkRequests).toBeGreaterThan(0);
  await expect.poll(() => rightChunkRequests).toBeGreaterThan(0);

  const canvasBox = await page.locator("#nv-canvas").boundingBox();
  expect(canvasBox).not.toBeNull();
  const startX = canvasBox.x + canvasBox.width * 0.32;
  const startY = canvasBox.y + canvasBox.height * 0.28;
  const panFields = ["#panX", "#panY", "#panZ"];
  const panBefore = await Promise.all(
    panFields.map((selector) => page.locator(selector).inputValue()),
  );
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 80, startY + 36, { steps: 8 });
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
  await page.mouse.click(startX, startY);
  await expect.poll(
    () => page.evaluate(() => window.__locationChangeCount),
  ).toBeGreaterThan(locationChangesBefore);
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
  const measureEndX = startX + 64;
  const measureEndY = startY + 24;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(measureEndX, measureEndY, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator("#measurementStatus")).toContainText("µm");
  await expect(page.locator("#measurementStatus")).toContainText("right-click to remove");
  await page.locator("#clearMeasurements").click();
  await expect(page.locator("#clearMeasurements")).toBeDisabled();
  await expect(page.locator("#measurementStatus")).toHaveText("drag across a structure");
  await measureButton.click();
  await expect(measureButton).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#measurementStatus")).toHaveText("crosshair movement active");
  const locationChangesAfterMeasurement = await page.evaluate(
    () => window.__locationChangeCount,
  );
  await page.mouse.click(startX + 20, startY + 20);
  await expect.poll(
    () => page.evaluate(() => window.__locationChangeCount),
  ).toBeGreaterThan(locationChangesAfterMeasurement);

  await page.locator("#scrollZoomSpeed").fill("3");
  await expect(page.locator("#scrollZoomSpeedValue")).toHaveText("3×");
  await page.locator("#zoom").fill("2");
  await page.getByRole("button", { name: "Apply" }).click();
  const sharedPan = await Promise.all(
    panFields.map((selector) => page.locator(selector).inputValue()),
  );
  await page.getByRole("button", { name: "Copy share link" }).click();
  await expect(page.locator("#shareStatus")).toContainText("Link copied");
  const sharedUrl = await page.evaluate(() => window.__copiedText);
  const sharedParams = new URL(sharedUrl).searchParams;
  expect(sharedParams.getAll("url")).toHaveLength(2);
  expect(sharedParams.get("layout")).toBe("3");
  expect(sharedParams.get("zoom")).toBe("2");
  expect(sharedParams.get("wl")).toBe("60");
  expect(sharedParams.get("ww")).toBe("20");
  expect(sharedParams.get("scrollZoomSpeed")).toBe("3");
  expect(sharedParams.get("pan")).toBeTruthy();
  expect(sharedParams.get("crosshair")).toBeTruthy();

  await page.goto(sharedUrl);
  await expect(page.locator("#activeLevel")).toHaveText(/L0 · 2 translated stores/);
  await expect(page.locator("#windowLevel")).toHaveValue("60");
  await expect(page.locator("#windowWidth")).toHaveValue("20");
  await expect(page.locator("#scrollZoomSpeed")).toHaveValue("3");
  await expect(page.locator("#zoom")).toHaveValue("2");
  await expect.poll(async () => Promise.all(
    panFields.map((selector) => page.locator(selector).inputValue()),
  )).toEqual(sharedPan);

  await page.locator("#zarrLevel").selectOption("auto");
  await expect(page.locator("#activeLevel")).toContainText("L3 · 2 translated stores");
  await expect.poll(() => chunkRequestsByLevel.get(3) ?? 0).toBeGreaterThan(0);
  delayLevelMetadata = true;
  await page.locator("#zoom").fill("4");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.locator("#activeLevel")).toContainText("target L1");
  await expect.poll(() => delayedMetadataRequests).toBeGreaterThan(0);

  // Start a newer LOD request while L1 metadata is still delayed. The latest
  // request must win, and a crosshair click made during the swap must survive.
  await page.locator("#zoom").fill("8");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.locator("#activeLevel")).toContainText("target L0");
  const locationChangesBeforeReloadClick = await page.evaluate(
    () => window.__locationChangeCount,
  );
  await page.mouse.click(startX + 36, startY + 28);
  await expect.poll(
    () => page.evaluate(() => window.__locationChangeCount),
  ).toBeGreaterThan(locationChangesBeforeReloadClick);
  await page.getByRole("button", { name: "Copy share link" }).click();
  const clickedCrosshair = new URL(
    await page.evaluate(() => window.__copiedText),
  ).searchParams.get("crosshair");

  await expect(page.locator("#activeLevel")).toContainText(
    "L0 · 2 translated stores",
  );
  await page.waitForTimeout(900);
  await expect(page.locator("#activeLevel")).toContainText(
    "L0 · 2 translated stores",
  );
  await expect(page.locator("#visibleLevel")).toHaveText("L0");
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

test("DANDI assets are searchable and selectable", async ({ page }) => {
  const zarrId = "56509720-870c-4f43-ae41-7b75f9590722";
  let requestedGlob = "";
  await page.route("https://api.dandiarchive.org/api/dandisets/000108/versions/draft/assets/**", async (route) => {
    requestedGlob = new URL(route.request().url()).searchParams.get("glob") ?? "";
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        count: 1,
        next: null,
        previous: null,
        results: [{
          asset_id: "f81985a5-8167-4df0-bfc2-46a155214543",
          path: "sub-MITU01/ses-test/micr/sub-MITU01_sample-127_stain-LEC_chunk-1_SPIM.ome.zarr",
          size: 37_700_000_000,
          zarr: zarrId,
        }],
      }),
    });
  });

  await page.goto("/?source=dandi");
  await expect(page.locator("#dandiArchiveControl")).toBeVisible();
  await expect(page.locator("#zarrUrlControl")).toBeHidden();
  await page.locator("#dandiQuery").fill("sample-127 LEC chunk-1");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.locator("#dandiSearchStatus")).toContainText("Showing 1 of 1");
  expect(requestedGlob).toBe("*sample-127*LEC*chunk-1*.ome.zarr");
  await expect(page.locator(".dandi-result")).toContainText("sample-127_stain-LEC_chunk-1");
  await page.locator(".dandi-result input[type=checkbox]").check();
  await page.getByRole("button", { name: "Add 1 selected store" }).click();
  await expect(page.locator("#source")).toHaveValue("dandi");
  await expect(page.locator("#dandiSelectedStores")).toContainText(zarrId);
  await expect(page).toHaveURL(new RegExp(`url=.*${zarrId}`));
  await expect(page).toHaveURL(/source=dandi/);
  await page.getByRole("button", { name: "Remove DANDI store 1" }).click();
  await expect(page.locator("#dandiSelectedStores")).toBeHidden();
  await expect(page).not.toHaveURL(new RegExp(`url=.*${zarrId}`));
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
    `/?source=custom&level=0&url=${storeUrl}&wl=32768&ww=65535&layout=3`,
  );

  await expect(page.locator("#activeLevel")).toContainText("FOV L0");
  await expect.poll(async () => Number(await page.locator("#windowWidth").inputValue()))
    .toBeLessThan(10_000);
  await expect.poll(async () => Number(await page.locator("#windowLevel").inputValue()))
    .toBeLessThan(5_000);
  await expect(page.locator("#fallback")).toHaveAttribute("aria-hidden", "true");

  await page.goto(
    `/?source=custom&level=0&url=${storeUrl}&wl=1000&ww=500&layout=3`,
  );
  await expect(page.locator("#activeLevel")).toContainText("FOV L0");
  await page.waitForTimeout(500);
  await expect(page.locator("#windowLevel")).toHaveValue("1000");
  await expect(page.locator("#windowWidth")).toHaveValue("500");
});

test("level caps stay selected while the badge reports the finest visible level", async ({ page }) => {
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
  await expect(page.locator("#zarrLevel")).toHaveValue("auto");
  await expect(page.locator("#activeLevel")).toHaveAttribute("data-fov-levels", "6");
  await page.locator("#zarrLevel").selectOption("4");
  await expect(page).toHaveURL(/zarrLevel=4/);
  await expect(page.locator("#activeLevel")).toHaveAttribute("data-fov-levels", /(^|,)4(,|$)/);
  await expect(page.locator("#visibleLevel")).toHaveText("L4");
  await page.reload();
  await expect(page.locator("#zarrLevel")).toHaveValue("4");
  await expect(page.locator("#activeLevel")).toHaveAttribute("data-fov-levels", /(^|,)4(,|$)/);
  await expect(page.locator("#visibleLevel")).toHaveText("L4");
  await page.locator("#zoom").fill("2");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.locator("#activeLevel")).toHaveAttribute("data-fov-levels", /(^|,)4(,|$)/);
  await page.locator("#zarrLevel").selectOption("auto");
  await expect(page).not.toHaveURL(/zarrLevel=/);
  await expect(page.locator("#activeLevel")).toHaveAttribute(
    "data-fov-levels",
    /(^|,)5(,|$)/,
    { timeout: 10_000 },
  );
  await expect(page.locator("#activeLevel")).toContainText("FOV L5");
  await expect(page.locator("#visibleLevel")).toHaveText("L5");
});
