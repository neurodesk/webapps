// Real browser smoke test. Proves the deployed contract that Node tests cannot:
// cross-origin isolation, worker loading, and app boot. Runs against `vite preview`
// (see playwright.config.js) so it exercises the built, header-served output.
import { readFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";
import { dicomSeries } from "../../../test-utils/dicom-fixture.mjs";

// Headless Chromium otherwise exposes only a SwiftShader WebGPU adapter, on which
// MindGrab does not finish; these flags hand it the real GPU. Must stay top level
// (Playwright forbids launchOptions inside a describe group).
const hardwareGpu = process.platform === "darwin";
test.use({ launchOptions: { args: ["--enable-unsafe-webgpu", ...(hardwareGpu ? ["--use-angle=metal", "--enable-features=Metal"] : ["--use-angle=swiftshader", "--use-vulkan=swiftshader", "--enable-features=Vulkan", "--disable-vulkan-surface"])] } });

test("app boots", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#viewer")).toBeVisible();
});

test("shared app bar owns information actions and theme", async ({ page }) => {
  await page.goto("/");
  const bar = page.locator(".nd-app-bar:visible");
  await expect(bar).toHaveCount(1);
  await expect(page.locator("#controls > #aboutBtn")).toBeHidden();
  await bar.getByRole("button", { name: "About", exact: true }).click();
  await expect(page.locator("#infoDialog")).toBeVisible();
  await page.locator("#infoDialog").getByRole("button", { name: "Close" }).click();
  // The theme controller renames the toggle ("Use light theme"), so match the attribute.
  await bar.locator("[data-neurodesk-theme-toggle]").click();
  await expect(page.locator("html")).toHaveAttribute("data-neurodesk-theme", "light");
});

test("page is cross-origin isolated (COOP/COEP active)", async ({ page }) => {
  await page.goto("/");
  // Threaded ONNX Runtime needs this; asserts the shared isolation policy worked.
  const isolated = await page.evaluate(() => self.crossOriginIsolated === true);
  expect(isolated).toBe(true);
});

test("a web worker loads and responds", async ({ page }) => {
  await page.goto("/");
  const ok = await page.evaluate(async () => {
    const src = "self.onmessage = () => self.postMessage('pong');";
    const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
    const w = new Worker(url, { type: "module" });
    return await new Promise((resolve) => {
      const finish = (result) => {
        w.terminate();
        URL.revokeObjectURL(url);
        resolve(result);
      };
      w.onmessage = (e) => finish(e.data === "pong");
      w.onerror = () => finish(false);
      w.postMessage("ping");
    });
  });
  expect(ok).toBe(true);
});

const fixture = fileURLToPath(new URL("../../../exes/synthseg/test/fixtures/small.nii.gz", import.meta.url));

// The fixture with its first voxel axis reversed and the sform updated to match, so the
// affine has a negative determinant (left-handed storage) while the anatomy is unchanged.
function leftHanded(path) {
  const raw = gunzipSync(readFileSync(path));
  const header = Buffer.from(raw.subarray(0, 352));
  const [nx, ny, nz] = [1, 2, 3].map((i) => header.readInt16LE(40 + i * 2));
  const bytes = header.readInt16LE(72) / 8;
  const offset = Math.ceil(header.readFloatLE(108));
  const data = Buffer.alloc(raw.length - offset);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const src = offset + ((k * ny + j) * nx + i) * bytes;
    raw.copy(data, ((k * ny + j) * nx + (nx - 1 - i)) * bytes, src, src + bytes);
  }
  for (const row of [280, 296, 312]) { // srow_x/y/z: column 0 negated, origin moved to the last voxel
    header.writeFloatLE(header.readFloatLE(row + 12) + header.readFloatLE(row) * (nx - 1), row + 12);
    header.writeFloatLE(-header.readFloatLE(row), row);
  }
  header.writeInt16LE(0, 252); // qform off so only the sform describes the geometry
  return Buffer.concat([header, raw.subarray(352, offset), data]);
}

// Binary STL: signed volume from the vertices (positive = outward winding in world space),
// and any stored facet normal that contradicts the winding. NiiVue writes zero normals,
// which the format allows and slicers treat as "derive from winding".
function inspectStl(bytes) {
  const count = bytes.readUInt32LE(80);
  let volume = 0, contradicting = 0;
  for (let f = 0; f < count; f++) {
    const at = (i) => bytes.readFloatLE(84 + f * 50 + i * 4);
    const [nx, ny, nz, ax, ay, az, bx, by, bz, cx, cy, cz] = Array.from({ length: 12 }, (_, i) => at(i));
    volume += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
    const [ux, uy, uz, vx, vy, vz] = [bx - ax, by - ay, bz - az, cx - ax, cy - ay, cz - az];
    if (nx * (uy * vz - uz * vy) + ny * (uz * vx - ux * vz) + nz * (ux * vy - uy * vx) < 0) contradicting++;
  }
  return { count, volume: volume / 6, contradicting };
}

// The whole pipeline: MindGrab segmentation, niimath mesh, STL download, on the fixture as
// stored (right-handed) and on a left-handed copy, asserting outward normals for both.
for (const [name, file] of [["small.nii.gz", fixture], ["small_lh.nii.gz", null]]) {
  test(`segments, meshes and downloads a printable brain from ${name}`, async ({ page }) => {
    test.skip(!hardwareGpu, "needs a hardware WebGPU adapter");
    test.setTimeout(600_000);
    await page.goto("/");
    const status = page.locator("#statusText");
    // The default image loads from Hugging Face at boot; let it settle before picking ours.
    await expect(status).toHaveText(/loaded|failed|error/i, { timeout: 180_000 });

    await page.setInputFiles("#imageInput", file ?? { name, mimeType: "application/gzip", buffer: gzipSync(leftHanded(fixture)) });
    await expect(status).toHaveText(`${name} loaded`, { timeout: 120_000 });

    // The viewer reports the voxel under the cursor into the shared info bar.
    await page.locator("#gl1").click({ position: { x: 120, y: 120 } });
    await expect(page.locator("#location")).toHaveText(/\d/);

    await page.locator("#segmentButton").click();
    await expect(status).toHaveText(/^Segmentation complete/, { timeout: 300_000 });
    await expect(page.locator("#meshButton")).toBeEnabled();

    await page.locator("#meshButton").click();
    await expect(status).toHaveText(/^Mesh complete: \d+ triangles, closed manifold/, { timeout: 300_000 });
    const triangles = Number((await status.textContent()).match(/(\d+) triangles/)[1]);
    expect(triangles).toBeGreaterThan(0);

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.locator("#downloadButton").click(),
    ]);
    expect(download.suggestedFilename()).toBe("brain2print.stl");
    const stl = inspectStl(readFileSync(await download.path()));
    expect(stl.count).toBe(triangles);
    expect(stl.volume).toBeGreaterThan(0); // outward winding in world space
    expect(stl.contradicting).toBe(0);
    console.log(`${name}: ${triangles} triangles, volume ${stl.volume.toFixed(0)} mm^3`);
  });
}


test("a delayed example never replaces a selected image", async ({ page }) => {
  let releaseExample;
  const held = new Promise(resolve => { releaseExample = resolve; });
  await page.route("**/browserqc/t1_crop.nii.gz", async route => {
    await held;
    await route.fulfill({ body: readFileSync(fixture), contentType: "application/gzip" }).catch(() => {});
  });
  await page.goto("/");
  await expect(page.locator("#imageInput")).toBeEnabled({ timeout: 30000 });
  await page.setInputFiles("#imageInput", fixture);
  await expect(page.locator("#statusText")).toHaveText("small.nii.gz loaded", { timeout: 30000 });
  releaseExample();
  await page.waitForTimeout(500);
  await expect(page.locator("#statusText")).toHaveText("small.nii.gz loaded");
  await expect(page.locator("#segmentButton")).toBeEnabled();
});

test("a failed replacement disables segmentation of the previous image", async ({ page }) => {
  await page.route("**/browserqc/t1_crop.nii.gz", route => route.fulfill({ body: readFileSync(fixture) }));
  await page.goto("/");
  await expect(page.locator("#segmentButton")).toBeEnabled({ timeout: 30000 });
  await page.setInputFiles("#imageInput", { name: "broken.nii", mimeType: "application/octet-stream", buffer: Buffer.from("invalid nifti") });
  await expect(page.locator("#statusText")).toHaveClass(/error/);
  await expect(page.locator("#segmentButton")).toBeDisabled();
  await expect(page.locator("#meshButton")).toBeDisabled();
  await expect(page.locator("#downloadButton")).toBeDisabled();
});


test("the scan picker converts DICOM and retains mesh settings", async ({ page }, testInfo) => {
  await page.route("**/browserqc/t1_crop.nii.gz", route => route.abort());
  await page.goto("/");
  await expect(page.locator("#imageInput")).toBeEnabled({ timeout: 30000 });
  await page.setInputFiles("#imageInput", dicomSeries({ extension: "" }));
  await expect(page.locator("#statusText")).toHaveText(/\.nii(\.gz)? loaded$/, { timeout: 60000 });
  await expect(page.locator("#segmentButton")).toBeEnabled();
  await page.locator("#simplify").fill("35");
  const section = page.locator("details").filter({ has: page.locator("#simplify") });
  await section.locator("summary").click();
  await section.locator("summary").click();
  await expect(page.locator("#simplify")).toHaveValue("35");
  await page.screenshot({ path: testInfo.outputPath("dicom-dark.png"), fullPage: true });
  await page.locator("[data-neurodesk-theme-toggle]").click();
  await page.screenshot({ path: testInfo.outputPath("dicom-light.png"), fullPage: true });
});
