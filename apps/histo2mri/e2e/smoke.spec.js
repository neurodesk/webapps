// Browser tests against the built app (vite preview): boot and shell, the example through the
// real registration and its downloads, cancellation, a failed example download with retry, and a
// PNG section through the browser's decoder.
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { gunzipSync, deflateSync } from "node:zlib";

const examples = JSON.parse(readFileSync(new URL("../examples.json", import.meta.url), "utf8"));
const automation = JSON.parse(readFileSync(new URL("../automation.json", import.meta.url), "utf8"));
const example = examples[0];

function niftiHeader(bytes) {
  const raw = gunzipSync(bytes);
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const dims = Array.from({ length: 8 }, (_, i) => view.getInt16(40 + 2 * i, true));
  const sform = Array.from({ length: 12 }, (_, i) => view.getFloat32(280 + 4 * i, true));
  return { raw, view, dims, datatype: view.getInt16(70, true), sformCode: view.getInt16(254, true), qformCode: view.getInt16(252, true), sform, voxOffset: view.getFloat32(108, true) };
}

async function download(page, label) {
  const row = page.locator("#resultList .nd-volume-toggle").filter({ hasText: label });
  const pending = page.waitForEvent("download");
  await row.getByRole("button", { name: "Download", exact: true }).click();
  const file = await pending;
  return { name: file.suggestedFilename(), bytes: readFileSync(await file.path()) };
}

test("app boots on its workspace with the shared app bar", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#viewer")).toBeVisible();
  const bar = page.locator(".nd-app-bar:visible");
  await expect(bar).toHaveCount(1);
  await bar.getByRole("button", { name: "About", exact: true }).click();
  await expect(page.locator("#infoDialog").getByRole("heading", { name: `About ${automation.title}`, exact: true })).toBeVisible();
  await page.locator("#infoDialog").getByRole("button", { name: "Close" }).click();
  expect(await page.evaluate(() => self.crossOriginIsolated === true)).toBe(true);
});

test("the example registers and its outputs download", async ({ page }) => {
  test.setTimeout(600000);
  await page.goto("/");
  await page.locator("select[data-neurodesk-example]").selectOption(example.id);
  await expect(page.locator("#runButton")).toBeEnabled({ timeout: 120000 });
  await expect(page.locator("#sliceIndex")).toHaveValue(String(example.parameters.index));
  await expect(page.locator("#axis")).toHaveValue(String(example.parameters.axis));
  await expect(page.locator("#sectionInfo")).toContainText("1249 × 972 RGB");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Registered 1 section", { timeout: 540000 });

  const report = JSON.parse((await download(page, "Registration report")).bytes.toString("utf8"));
  expect(report.plane.axis).toBe(2);
  expect(Math.abs(report.plane.index - 50)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(report.plane.offsetMm)).toBeLessThanOrEqual(2 * 0.6 + 1e-6);
  expect(report.orientation).toEqual({ rotationDegrees: 0, flipped: false });
  expect(report.nmi.final).toBeGreaterThan(report.nmi.initial + 0.05);

  const warped = await download(page, "Warped section");
  expect(warped.name).toBe("ahead152017_thionin_section150_85um_warped_rgba.nii.gz");
  const header = niftiHeader(warped.bytes);
  expect(header.datatype).toBe(2304);
  expect(header.sformCode).toBeGreaterThan(0);
  expect(header.qformCode).toBe(0);
  expect(header.dims[3]).toBe(1);
  const alpha = header.raw.subarray(header.voxOffset).filter((_, i) => i % 4 === 3);
  expect(alpha.filter((value) => value === 255).length).toBeGreaterThan(0.2 * alpha.length);

  const volume = niftiHeader((await download(page, "Sections in the MRI grid")).bytes);
  expect(volume.dims.slice(1, 4)).toEqual([217, 210, 135]);
  expect(volume.datatype).toBe(2304);
  const placed = volume.raw.subarray(volume.voxOffset).filter((_, i) => i % 4 === 3 && volume.raw[volume.voxOffset + i] === 255);
  expect(placed.length).toBeGreaterThan(10000);

  const affine = (await download(page, "Greedy affine")).bytes.toString("utf8").trim().split("\n");
  expect(affine).toHaveLength(4);
  const warp = niftiHeader((await download(page, "Greedy warp")).bytes);
  expect(warp.dims[0]).toBe(5);
  expect(warp.dims[5]).toBe(3);
  await expect(page.getByRole("slider", { name: /Overlay/ })).toBeVisible();
});

test("cancelling a registration stops it and allows a new run", async ({ page }) => {
  test.setTimeout(240000);
  await page.goto("/");
  await page.locator("select[data-neurodesk-example]").selectOption(example.id);
  await expect(page.locator("#runButton")).toBeEnabled({ timeout: 120000 });
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("orientation", { timeout: 60000 });
  await page.locator("#cancelButton").click();
  await expect(page.locator("#statusText")).toHaveText("Registration cancelled");
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(0);
  await expect(page.locator("#runButton")).toBeEnabled();
  await expect(page.locator("#cancelButton")).toBeHidden();
});

test("a failed example download can be retried with the hosted bytes", async ({ page }) => {
  test.setTimeout(180000);
  let failing = true;
  let failures = 0;
  await page.route(example.files[0].url, async (route) => {
    if (failing) {
      failures++;
      return route.fulfill({ status: 404, body: "" });
    }
    return route.fallback();
  });
  await page.goto("/");
  const picker = page.getByRole("combobox", { name: "Input", exact: true });
  await picker.selectOption(example.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "error", { timeout: 60000 });
  await expect(page.locator("#runButton")).toBeDisabled();
  expect(failures).toBeGreaterThan(0);
  failing = false;
  await picker.selectOption(example.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 120000 });
  await expect(page.locator("#runButton")).toBeEnabled();
  await expect(page.locator("#mriInfo")).toContainText("217 × 210 × 135");
});

// A 2-bit-free 8-bit RGB PNG written here, decoded by the browser.
function png(width, height) {
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "latin1");
    data.copy(out, 8);
    const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
    let crc = 0xffffffff;
    for (const byte of out.subarray(4, 8 + data.length)) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows = Buffer.alloc(height * (1 + width * 3), 200);
  for (let y = 0; y < height; y++) rows[y * (1 + width * 3)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

test("a PNG section is decoded by the browser and kept beside the MRI", async ({ page }) => {
  await page.goto("/");
  await page.locator("#sectionInput").setInputFiles({ name: "slide.png", mimeType: "image/png", buffer: png(37, 23) });
  await expect(page.locator("#sectionInfo")).toHaveText("slide.png · 37 × 23 RGB");
  await expect(page.locator("#statusText")).toHaveText("Sections loaded; add the MRI");
  await page.locator("#sectionInput").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("x") });
  await expect(page.locator("#statusText")).toContainText("is not a NIfTI MRI");
  await expect(page.locator("#sectionInfo")).toHaveText("slide.png · 37 × 23 RGB");
});
