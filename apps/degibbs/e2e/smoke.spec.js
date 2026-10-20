// Browser tests against `vite preview` of the production build: boot, the shared shell, ringing
// removal in workers with gradient pass-through, the hosted example and its failure, retry and
// cancel paths, and the automation operation.
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { readNiftiFrames } from "@neurodesk/webapp-components/file-io";
import { oversizedHeaderDwi, squareSeries } from "./fixtures.mjs";
import { dicomSeries } from "../../../test-utils/dicom-fixture.mjs";

const examples = JSON.parse(readFileSync(new URL("../examples.json", import.meta.url), "utf8"));
const imageUrl = examples[0].files.find((file) => file.role === "image").url;

async function download(page, label) {
  const event = page.waitForEvent("download");
  await page.locator("#resultList .nd-volume-toggle").filter({ hasText: label }).getByRole("button", { name: "Download" }).click();
  return event;
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
  await bar.locator("[data-neurodesk-theme-toggle]").click();
  await expect(page.locator("html")).toHaveAttribute("data-neurodesk-theme", "light");
});

test("page is cross-origin isolated (COOP/COEP active)", async ({ page }) => {
  await page.goto("/");
  expect(await page.evaluate(() => self.crossOriginIsolated === true)).toBe(true);
});

test("a header whose decoded image passes the limit is refused before the image is read", async ({ page }) => {
  await page.addInitScript(() => {
    const read = Blob.prototype.arrayBuffer;
    window.wholeImageReads = 0;
    Blob.prototype.arrayBuffer = function arrayBuffer() {
      if (this instanceof File && /\.nii(\.gz)?$/.test(this.name)) window.wholeImageReads++;
      return read.call(this);
    };
  });
  await page.goto("/");
  await page.locator("#imageInput").setInputFiles(oversizedHeaderDwi());
  await expect(page.locator("footer#status #statusText")).toHaveText("Decoded image too large (2.68 GB; browser limit 2.00 GB).");
  await expect(page.locator("#statusText")).toHaveClass(/error/);
  expect(await page.evaluate(() => window.wholeImageReads)).toBe(0);
  await expect(page.locator("#runButton")).toBeDisabled();
  await expect(page.locator("#fileInfo")).toBeHidden();
});

test("a 4D series is corrected volume by volume and keeps its gradients", async ({ page }) => {
  const series = squareSeries();
  await page.goto("/");
  await page.locator("#imageInput").setInputFiles(series.files);
  await expect(page.locator("#fileInfo")).toContainText("32×24×3×2 · bval, bvec");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText("Ringing removed from 2 volumes", { timeout: 60000 });
  const image = await download(page, "Corrected image");
  expect(image.suggestedFilename()).toBe("sub-01_desc-degibbs_dwi.nii.gz");
  const out = readNiftiFrames(gunzipSync(readFileSync(await image.path())));
  expect(out.dims).toEqual([32, 24, 3]);
  expect(out.frames).toBe(2);
  // Both volumes are the same input, so they get the same correction; the edges change.
  expect(Array.from(out.data.subarray(0, series.voxels))).toEqual(Array.from(out.data.subarray(series.voxels)));
  const changed = out.data.subarray(0, series.voxels).some((v, i) => Math.abs(v - series.data[i]) > 0.01);
  expect(changed).toBe(true);
  const bval = await download(page, "b-values");
  expect(bval.suggestedFilename()).toBe("sub-01_desc-degibbs_dwi.bval");
  expect(readFileSync(await bval.path(), "utf8")).toBe("0 1000");
});

for (const role of ["bval", "bvec"]) {
  test(`a separately supplied ${role} is kept without its companion`, async ({ page }) => {
    const series = squareSeries();
    const files = series.files.filter((file) => file.name.endsWith(".nii.gz") || file.name.endsWith(`.${role}`));
    await page.goto("/");
    await page.locator("#imageInput").setInputFiles(files);
    await expect(page.locator("#runButton")).toBeEnabled();
    await page.locator("#runButton").click();
    await expect(page.locator("#statusText")).toHaveText("Ringing removed from 2 volumes");
    const gradient = await download(page, role === "bval" ? "b-values" : "b-vectors");
    expect(gradient.suggestedFilename()).toBe(`sub-01_desc-degibbs_dwi.${role}`);
    expect(readFileSync(await gradient.path())).toEqual(files[1].buffer);
    await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(3);
  });
}

test("cancelling stops the workers and permits another run", async ({ page }) => {
  const series = squareSeries({ nx: 128, ny: 128, nz: 60, frames: 8 });
  await page.goto("/");
  await page.locator("#imageInput").setInputFiles(series.files);
  await expect(page.locator("#runButton")).toBeEnabled();
  await page.locator("#runButton").click();
  await expect(page.locator("#cancelButton")).toBeVisible();
  await page.locator("#cancelButton").click();
  await expect(page.locator("#statusText")).toHaveText("Cancelled");
  await expect(page.locator("#runButton")).toBeEnabled();
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(0);
});

test("cancelling while packing the image prevents completed outputs", async ({ page }) => {
  await page.goto("/");
  await page.locator("#imageInput").setInputFiles(squareSeries().files);
  await expect(page.locator("#runButton")).toBeEnabled();
  await page.evaluate(() => {
    const read = Response.prototype.arrayBuffer;
    Response.prototype.arrayBuffer = async function () {
      const buffer = await read.call(this);
      Response.prototype.arrayBuffer = read;
      await new Promise((resolve) => { window.finishOutputPacking = resolve; });
      return buffer;
    };
  });
  await page.locator("#runButton").click();
  await page.waitForFunction(() => typeof window.finishOutputPacking === "function");
  await page.locator("#cancelButton").click();
  await page.evaluate(() => window.finishOutputPacking());
  await expect(page.locator("#statusText")).toHaveText("Cancelled");
  await expect(page.locator("#runButton")).toBeEnabled();
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(0);
});

for (const example of examples) {
  test(`example ${example.id} removes ringing and downloads the image and gradients`, async ({ page }) => {
    test.setTimeout(180000);
    await page.goto("/");
    await page.locator("select[data-neurodesk-example]").selectOption(example.id);
    await expect(page.locator("#fileInfo")).toContainText("dwi.nii.gz", { timeout: 120000 });
    await page.locator("#runButton").click();
    await expect(page.locator("#statusText")).toContainText("Ringing removed", { timeout: 120000 });
    await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(4);
    const image = await download(page, "Corrected image");
    expect(image.suggestedFilename()).toBe("dwi_desc-degibbs.nii.gz");
    const out = readNiftiFrames(gunzipSync(readFileSync(await image.path())));
    expect(out.frames).toBe(21);
  });
}

for (const failure of ["download", "empty image"]) {
  test(`a failed ${failure} can retry the same example`, async ({ page }) => {
    // The retry downloads the real example, which can take longer than the 30 s default.
    test.setTimeout(150000);
    const example = examples[0];
    let attempts = 0;
    await page.context().route(imageUrl, (route) => {
      attempts++;
      if (attempts > 1) return route.fallback();
      return route.fulfill({ status: failure === "download" ? 503 : 200, body: "" });
    });
    await page.goto("/");
    const picker = page.getByRole("combobox", { name: "Input", exact: true });
    await picker.selectOption(example.id);
    await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "error");
    await expect(page.locator("#runButton")).toBeDisabled();
    await expect(picker).toBeEnabled();
    await picker.selectOption(example.id);
    await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 120000 });
    await expect(page.locator("#runButton")).toBeEnabled();
    expect(attempts).toBe(2);
  });
}

test("cancelling during image reading prevents a late commit and permits retry", async ({ page }) => {
  test.setTimeout(150000);
  const example = examples[0];
  await page.goto("/");
  await page.evaluate(() => {
    const read = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = function () {
      const file = this;
      return new Promise((resolve, reject) => {
        window.finishExampleRead = () => {
          File.prototype.arrayBuffer = read;
          read.call(file).then(resolve, reject);
        };
      });
    };
  });
  const picker = page.getByRole("combobox", { name: "Input", exact: true });
  await picker.selectOption(example.id);
  await page.waitForFunction(() => typeof window.finishExampleRead === "function", null, { timeout: 120000 });
  await page.getByRole("button", { name: "Cancel example download", exact: true }).click();
  await page.evaluate(() => window.finishExampleRead());
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "cancelled");
  await expect(page.locator("#fileInfo")).toBeHidden();
  await expect(page.locator("#runButton")).toBeDisabled();
  await expect(picker).toBeEnabled();
  await picker.selectOption(example.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 120000 });
});

test("the automation operation returns the image, gradients and acquisition sidecar", async ({ page }) => {
  const series = squareSeries();
  series.files.push({
    name: "sub-01_dwi.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ SliceEncodingDirection: "k", PhaseEncodingDirection: "j-", TotalReadoutTime: 0.05 })),
  });
  await page.goto("/");
  await page.locator("#neurodesk-input-transfer").setInputFiles(series.files);
  await page.evaluate(async () => {
    await globalThis.neurodeskAutomation.dispatch("adopt", { role: "image" });
    await globalThis.neurodeskAutomation.dispatch("start", {});
  });
  await expect.poll(() => page.evaluate(async () => (await globalThis.neurodeskAutomation.dispatch("snapshot")).state), { timeout: 60000 }).toBe("succeeded");
  const report = await page.evaluate(async () => (await globalThis.neurodeskAutomation.dispatch("snapshot")).report);
  expect(report.provenance.method).toBe("mrdegibbs-3.0.8-port");
  expect(Object.keys(report.artifacts).sort()).toEqual(["bval", "bvec", "image", "sidecar"]);
  const event = page.waitForEvent("download");
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch("download", { artifactId: "sidecar" }));
  const sidecar = await event;
  expect(sidecar.suggestedFilename()).toBe("sub-01_desc-degibbs_dwi.json");
  expect(JSON.parse(readFileSync(await sidecar.path(), "utf8"))).toMatchObject({
    SliceEncodingDirection: "k",
    PhaseEncodingDirection: "j-",
    TotalReadoutTime: 0.05,
  });
});

test("DICOM derivatives retain acquisition fields without personal metadata", async ({ page }) => {
  await page.goto("/");
  await page.locator("#imageInput").setInputFiles(dicomSeries({ slices: 16, patient: { birthDate: "19800102" } }));
  await expect(page.locator("#fileInfo")).toContainText(".nii", { timeout: 60000 });
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Ringing removed", { timeout: 60000 });
  const result = await download(page, "Sidecar");
  const sidecar = JSON.parse(readFileSync(await result.path(), "utf8"));
  expect(sidecar.EchoTime).toBe(0.02);
  expect(sidecar).not.toHaveProperty("PatientName");
  expect(sidecar).not.toHaveProperty("PatientBirthDate");
});
