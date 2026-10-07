// Real browser smoke test. Proves the deployed contract that Node tests cannot:
// cross-origin isolation, worker loading, and app boot. Runs against `vite preview`
// (see playwright.config.js) so it exercises the built, header-served output.
import { readFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";
import { dicomSeries } from "../../../test-utils/dicom-fixture.mjs";
import { inspectStl, labels, voxelVolume } from "./mesh-geometry.js";

const dispatch = (page, command, request = {}) => page.evaluate(({ command, request }) => globalThis.neurodeskAutomation.dispatch(command, request), { command, request });

// The pipeline tests start the run through the automation contract on the threaded CPU backend,
// so they do not depend on backend selection; everything after it is the page's own controls.
// The Segment button's own `auto` choice is covered separately below.
async function createMesh(page, file, parameters = {}) {
  await page.goto("/");
  await expect(page.locator("#imageInput")).toBeEnabled({ timeout: 60_000 });
  await page.locator("#neurodesk-input-transfer").setInputFiles(file);
  await dispatch(page, "adopt", { role: "image" });
  await dispatch(page, "start", { operation: "create-mesh", parameters: { backend: "cpu", ...parameters } });
  await expect.poll(async () => {
    const snapshot = await dispatch(page, "snapshot");
    if (snapshot.state === "failed") throw new Error(JSON.stringify(snapshot.error));
    return snapshot.state;
  }, { timeout: 500_000, intervals: [1000, 2000, 5000] }).toBe("succeeded");
  const { report } = await dispatch(page, "snapshot");
  expect(report.provenance.segmentation.backend).toBe("cpu");
  const files = {};
  for (const [artifactId, artifact] of Object.entries(report.artifacts)) {
    const downloading = page.waitForEvent("download");
    await dispatch(page, "download", { artifactId });
    files[artifact.role] = readFileSync(await (await downloading).path());
  }
  return files;
}

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

// The whole pipeline: MindGrab segmentation, niimath mesh, STL download, on the fixture as
// stored (right-handed) and on a left-handed copy, asserting a closed surface with outward
// normals that encloses the segmented voxels for both.
for (const [name, handedness] of [["small.nii.gz", 1], ["small_lh.nii.gz", -1]]) {
  test(`segments, meshes and downloads a printable brain from ${name}`, async ({ page }) => {
    test.setTimeout(600_000);
    const buffer = handedness > 0 ? readFileSync(fixture) : gzipSync(leftHanded(fixture));
    const { segmentation } = await createMesh(page, { name, mimeType: "application/gzip", buffer });
    const fraction = voxelVolume(segmentation, 0.5);
    expect(fraction.handedness).toBe(handedness); // the segmentation stays on the input grid
    expect(fraction.volume).toBeGreaterThan(100_000);

    // The viewer reports the voxel under the cursor into the shared info bar.
    await page.locator("#gl1").click({ position: { x: 120, y: 120 } });
    await expect(page.locator("#location")).toHaveText(/\d/);

    const completed = page.locator("#technicalLog .nd-console-message").filter({ hasText: "Mesh complete" });
    await expect(completed).toHaveCount(1);
    await page.locator("#smooth").fill("5"); // smoothing must keep the mesh closed
    await page.locator("#meshButton").click();
    await expect(completed).toHaveCount(2, { timeout: 300_000 });
    const status = page.locator("#statusText");
    await expect(status).toHaveText(/^Mesh complete: \d+ triangles, closed manifold/);
    const triangles = Number((await status.textContent()).match(/(\d+) triangles/)[1]);

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.locator("#downloadButton").click(),
    ]);
    expect(download.suggestedFilename()).toBe("brain2print.stl");
    const stl = inspectStl(readFileSync(await download.path()));
    expect(stl.triangles).toBe(triangles);
    expect(stl.openEdges).toBe(0);
    expect(stl.misorientedEdges).toBe(0);
    expect(stl.contradicting).toBe(0);
    // Outward winding in world space, enclosing the voxels the brain fraction puts inside.
    expect(stl.volume).toBeGreaterThan(fraction.volume * 0.9);
    expect(stl.volume).toBeLessThan(fraction.volume * 1.1);
    console.log(`${name}: ${triangles} triangles, mesh ${stl.volume.toFixed(0)} mm^3, voxels ${fraction.volume.toFixed(0)} mm^3`);
  });
}

// The pipeline above runs the default partial-volume model; each label model must return its
// own parcellation on the input grid and a closed mesh around every labelled voxel.
for (const [model, labelCount] of [["16chan18cls", 18], ["mindmap", 18], ["mindsnap", 104]]) {
  test(`${model} returns its label set and a closed mesh around it`, async ({ page }) => {
    test.setTimeout(600_000);
    const files = await createMesh(page, fixture, { model });
    const { dims, values } = labels(files.segmentation);
    expect(dims).toEqual([44, 52, 44]);
    expect(values.every((value) => Number.isInteger(value) && value >= 0 && value < labelCount)).toBe(true);
    // A cropped head still shows most structures; mindsnap's cortical parcels exceed 18 labels.
    expect(values.length).toBeGreaterThan(labelCount === 104 ? 30 : 10);
    const stl = inspectStl(files.mesh);
    expect(stl.openEdges).toBe(0);
    expect(stl.misorientedEdges).toBe(0);
    // The same standard as the brain fraction: the 0.5 isosurface of the 0/1 brain mask encloses
    // the labelled voxels. Independently, skimage marching cubes at 0.5 on these masks lands within
    // 0.5 % of the voxel volume (1 % after largest-component and cavity filling), and Gaussian
    // smoothing (sigma one voxel) before it within 4 %. Meshing the raw labels gave +17 to +87 %.
    const labelled = voxelVolume(files.segmentation, 0.5).volume;
    expect(stl.volume).toBeGreaterThan(labelled * 0.95);
    expect(stl.volume).toBeLessThan(labelled * 1.05);
  });
}

// On a machine with no GPU, Chromium offers only SwiftShader. MindGrab's own `auto` then took
// software WebGL2 and did not finish in 9 minutes; the threaded CPU module needs about 25 s.
test("the Segment button runs on the CPU when the only GPU is a software renderer", async ({ page }) => {
  test.skip(Boolean(process.env.BRAIN2PRINT_HARDWARE_GPU), "a hardware GPU is expected to take WebGPU or WebGL2");
  test.setTimeout(300_000);
  await page.goto("/");
  await expect(page.locator("#imageInput")).toBeEnabled({ timeout: 60_000 });
  await page.setInputFiles("#imageInput", fixture);
  await expect(page.locator("#segmentButton")).toBeEnabled({ timeout: 30_000 });
  await page.locator("#segmentButton").click();
  await expect(page.locator("#statusText")).toHaveText(/^Segmentation complete on cpu \(/, { timeout: 180_000 });
});

test("a delayed example never replaces a selected image", async ({ page }) => {
  let releaseExample;
  const held = new Promise(resolve => { releaseExample = resolve; });
  await page.route("**/browserqc/t1_crop.nii.gz", async route => {
    await held;
    await route.fulfill({ body: readFileSync(fixture), contentType: "application/gzip" }).catch(() => {});
  });
  await page.goto("/");
  await expect(page.locator("#imageInput")).toBeEnabled({ timeout: 30000 });
  await page.locator("[data-neurodesk-example]").selectOption("t1-brain");
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
  await page.locator("[data-neurodesk-example]").selectOption("t1-brain");
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
