// Browser tests against `vite preview` of the production build: boot, the shared shell, a
// synthetic pair through estimation and download, refusals, cancellation, the hosted example
// against the native command line's field (the port gate), its failure and retry paths, and the
// automation operation.
import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { readNiftiFrames } from "@neurodesk/webapp-components/file-io";
import { TRT, pinnedBytes, routeExample, syntheticPair } from "./fixtures.mjs";

const examples = JSON.parse(readFileSync(new URL("../examples.json", import.meta.url), "utf8"));
const native = JSON.parse(readFileSync(new URL("./native-reference.json", import.meta.url), "utf8"));
const exampleUrls = examples.flatMap((example) => example.files.map((file) => file.url));
const imageUrl = examples[0].files[0].url;

async function download(page, label) {
  const event = page.waitForEvent("download");
  await page.locator("#resultList .nd-volume-toggle").filter({ hasText: label }).getByRole("button", { name: "Download" }).click();
  return event;
}

async function volume(downloadEvent) {
  return readNiftiFrames(gunzipSync(readFileSync(await (await downloadEvent).path())));
}

async function holdPreview(page, suffix) {
  await page.evaluate((suffix) => {
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, ...options) {
      if (!(message?.url instanceof File) || !message.url.name.endsWith(suffix)) {
        return post.call(this, message, ...options);
      }
      Worker.prototype.postMessage = post;
      window.finishSdcPreview = () => post.call(this, message, ...options);
    };
  }, suffix);
}

test("cancelling the first input preview restores the empty viewer and permits retry", async ({ page }) => {
  await page.goto("/");
  await holdPreview(page, "image1_b0_mean.nii.gz");
  await page.locator("#imageInput").setInputFiles(syntheticPair());
  await page.waitForFunction(() => typeof window.finishSdcPreview === "function");
  await page.locator("#cancelButton").click();
  await page.evaluate(() => window.finishSdcPreview());
  await expect(page.locator("#statusText")).toHaveText("Cancelled");
  await expect(page.locator("#emptyState")).toBeVisible();
  await expect(page.locator("#fileInfo")).toBeHidden();
  await expect(page.locator("#runButton")).toBeDisabled();
  await page.locator("#imageInput").setInputFiles(syntheticPair());
  await expect(page.locator("#runButton")).toBeEnabled();
  await expect(page.locator("#emptyState")).toBeHidden();
});

test("cancelling a replacement preview preserves the committed field and downloads", async ({ page }) => {
  await page.goto("/");
  await page.locator("#imageInput").setInputFiles(syntheticPair());
  await expect(page.locator("#runButton")).toBeEnabled();
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Field estimated", { timeout: 60000 });
  const before = await page.locator("#gl1").screenshot();
  await holdPreview(page, "image1_b0_mean.nii.gz");
  await page.locator("#imageInput").setInputFiles(syntheticPair({ shift: 6 }));
  await page.waitForFunction(() => typeof window.finishSdcPreview === "function");
  await expect(page.locator("#resultList")).toHaveJSProperty("inert", true);
  await page.locator("#cancelButton").click();
  await page.evaluate(() => window.finishSdcPreview());
  await expect(page.locator("#statusText")).toHaveText("Cancelled");
  await expect(page.locator("#runButton")).toBeEnabled();
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(4);
  expect(await page.locator("#gl1").screenshot()).toEqual(before);
  expect((await download(page, "Field map (Hz)")).suggestedFilename()).toBe("sub-01_dir-AP_fieldmap.nii.gz");
});

test("cancelling the field preview restores the input mean", async ({ page }) => {
  await page.goto("/");
  await page.locator("#imageInput").setInputFiles(syntheticPair());
  await expect(page.locator("#runButton")).toBeEnabled();
  const before = await page.locator("#gl1").screenshot();
  await holdPreview(page, "_fieldmap.nii.gz");
  await page.locator("#runButton").click();
  await page.waitForFunction(() => typeof window.finishSdcPreview === "function");
  await page.locator("#cancelButton").click();
  await page.evaluate(() => window.finishSdcPreview());
  await expect(page.locator("#statusText")).toHaveText("Cancelled");
  await expect(page.locator("#runButton")).toBeEnabled();
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(0);
  expect(await page.locator("#gl1").screenshot()).toEqual(before);
});

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
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
  await bar.locator("[data-neurodesk-theme-toggle]").click();
  await expect(page.locator("html")).toHaveAttribute("data-neurodesk-theme", "light");
});

test("page is cross-origin isolated (COOP/COEP active)", async ({ page }) => {
  await page.goto("/");
  expect(await page.evaluate(() => self.crossOriginIsolated === true)).toBe(true);
});

test("a synthetic pair gives the field of its known shift", async ({ page }) => {
  await page.goto("/");
  await page.locator("#imageInput").setInputFiles(syntheticPair());
  await expect(page.locator("#fileInfo")).toHaveText("Image 1: sub-01_dir-AP_dwi.nii.gz · j- · b = 0 mean of 2/3");
  await expect(page.locator("#pairInfo")).toHaveText("Image 2: sub-01_dir-PA_epi.nii.gz · j");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Field estimated", { timeout: 60000 });
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(4);
  const fieldEvent = download(page, "Field map (Hz)");
  expect((await fieldEvent).suggestedFilename()).toBe("sub-01_dir-AP_fieldmap.nii.gz");
  const field = await volume(fieldEvent);
  expect(field.dims).toEqual([8, 40, 4]);
  // Image 1 is shifted by +3 mm (1.5 voxels) and its direction is j-, so f = 1.5 / (TRT · -1).
  const middle = [];
  for (let z = 0; z < 4; z++) for (let x = 0; x < 8; x++) middle.push(field.data[x + 8 * (20 + 40 * z)]);
  middle.sort((a, b) => a - b);
  const expected = -1.5 / TRT;
  expect(Math.abs(middle[middle.length >> 1] - expected)).toBeLessThan(0.1 * Math.abs(expected));
  const sidecar = await download(page, "Field map sidecar");
  const meta = JSON.parse(readFileSync(await sidecar.path(), "utf8"));
  expect(meta).toMatchObject({ Units: "Hz", PhaseEncodingDirection: "j-", TotalReadoutTime: TRT });
});

test("the other field reference gives the same field", async ({ page }) => {
  await page.goto("/");
  await page.locator("#imageInput").setInputFiles(syntheticPair());
  await expect(page.locator("#runButton")).toBeEnabled();
  await page.locator("#reference").selectOption({ label: "sub-01_dir-PA_epi.nii.gz" });
  await expect(page.locator("#fileInfo")).toHaveText("Image 1: sub-01_dir-PA_epi.nii.gz · j");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Field estimated", { timeout: 60000 });
  const fieldEvent = download(page, "Field map (Hz)");
  expect((await fieldEvent).suggestedFilename()).toBe("sub-01_dir-PA_fieldmap.nii.gz");
  const field = await volume(fieldEvent);
  // PA is shifted by -3 mm (-1.5 voxels) with direction j: f = -1.5 / (TRT · +1), as from AP.
  const value = field.data[4 + 8 * (20 + 40)];
  expect(Math.abs(value - -1.5 / TRT)).toBeLessThan(0.1 * 1.5 / TRT);
});

test("a pair with the same direction is refused", async ({ page }) => {
  await page.goto("/");
  await page.locator("#imageInput").setInputFiles(syntheticPair({ pe: ["j", "j"] }));
  await expect(page.locator("#statusText")).toHaveText("The images need opposite directions on one axis, not j and j.");
  await expect(page.locator("#runButton")).toBeDisabled();
});

test("images on different grids are refused", async ({ page }) => {
  await page.goto("/");
  await page.locator("#imageInput").setInputFiles(syntheticPair({ dims2: [8, 40, 5] }));
  await expect(page.locator("#statusText")).toHaveText("The images are on different grids (8×40×4 and 8×40×5); both must be in one space.");
  await expect(page.locator("#runButton")).toBeDisabled();
});

for (const readout of [undefined, 0, 0.1]) {
  test(`the reverse image's readout ${readout ?? "missing"} is refused`, async ({ page }) => {
    const files = syntheticPair();
    const sidecar = files.find((file) => file.name.endsWith("PA_epi.json"));
    const metadata = JSON.parse(sidecar.buffer);
    if (readout === undefined) delete metadata.TotalReadoutTime;
    else metadata.TotalReadoutTime = readout;
    sidecar.buffer = Buffer.from(JSON.stringify(metadata));
    await page.goto("/");
    await page.locator("#imageInput").setInputFiles(files);
    const message = readout === 0.1 ? /same TotalReadoutTime/ : /finite positive TotalReadoutTime/;
    await expect(page.locator("#statusText")).toContainText(message);
    await expect(page.locator("#runButton")).toBeDisabled();
    await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(0);
  });
}

test("a DWI plus IntendedFor AP/PA fieldmaps estimates the associated pair", async ({ page }) => {
  const files = syntheticPair();
  const ap = files.find((file) => file.name.endsWith("AP_dwi.nii.gz"));
  const pa = files.find((file) => file.name.endsWith("PA_epi.json"));
  const target = "bids::sub-01/dwi/sub-01_dir-AP_dwi.nii.gz";
  pa.buffer = Buffer.from(JSON.stringify({ PhaseEncodingDirection: "j", TotalReadoutTime: TRT, IntendedFor: target }));
  files.push({ ...ap, name: "sub-01_dir-AP_epi.nii.gz" });
  files.push({ name: "sub-01_dir-AP_epi.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ PhaseEncodingDirection: "j-", TotalReadoutTime: TRT, IntendedFor: target })) });
  await page.goto("/");
  await page.locator("#imageInput").setInputFiles(files);
  await expect(page.locator("#fileInfo")).toHaveText("Image 1: sub-01_dir-AP_epi.nii.gz · j- · b = 0 mean of 3/3");
  await expect(page.locator("#pairInfo")).toHaveText("Image 2: sub-01_dir-PA_epi.nii.gz · j");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Field estimated", { timeout: 60000 });
  const field = await volume(download(page, "Field map (Hz)"));
  expect(field.dims).toEqual([8, 40, 4]);
  expect(Math.abs(field.data[4 + 8 * (20 + 40)] + 1.5 / TRT)).toBeLessThan(0.1 * 1.5 / TRT);
  const event = await download(page, "Field map sidecar");
  const metadata = JSON.parse(readFileSync(await event.path(), "utf8"));
  expect(metadata).toMatchObject({
    Units: "Hz",
    Sources: ["sub-01_dir-AP_epi.nii.gz", "sub-01_dir-PA_epi.nii.gz"],
    TotalReadoutTime: TRT,
  });
});

test("a reverse image from another subject is refused", async ({ page }) => {
  const files = syntheticPair().map((file) => ({ ...file, name: file.name.replace("sub-01_dir-PA", "sub-02_dir-PA") }));
  await page.goto("/");
  await page.locator("#imageInput").setInputFiles(files);
  await expect(page.locator("#statusText")).toContainText(/same subject/);
  await expect(page.locator("#runButton")).toBeDisabled();
});

test("cancelling stops the estimate and permits another run", async ({ page }) => {
  await page.goto("/");
  await page.locator("#imageInput").setInputFiles(syntheticPair({ dims: [128, 128, 60] }));
  await expect(page.locator("#runButton")).toBeEnabled({ timeout: 30000 });
  await page.locator("#runButton").click();
  await expect(page.locator("#cancelButton")).toBeVisible();
  await page.locator("#cancelButton").click();
  await expect(page.locator("#statusText")).toHaveText("Cancelled");
  await expect(page.locator("#runButton")).toBeEnabled();
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(0);
});

test("the automation operation estimates the field from two images", async ({ page }) => {
  const files = syntheticPair();
  await page.goto("/");
  for (const [role, index] of [["image1", 0], ["sidecar1", 1], ["bval1", 2], ["image2", 3], ["sidecar2", 4]]) {
    const file = files[index];
    await page.locator("#neurodesk-input-transfer").setInputFiles(role.startsWith("sidecar") ? { ...file, name: `${role}.json` } : file);
    await page.evaluate(role => globalThis.neurodeskAutomation.dispatch("adopt", { role }), role);
  }
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch("start", {}));
  await expect.poll(() => page.evaluate(async () => (await globalThis.neurodeskAutomation.dispatch("snapshot")).state), { timeout: 60000 }).toBe("succeeded");
  const report = await page.evaluate(async () => (await globalThis.neurodeskAutomation.dispatch("snapshot")).report);
  expect(report.provenance).toMatchObject({ method: "pyhysco-0.0.4-port", reference: "image1_sub-01_dir-AP_dwi.nii.gz" });
  expect(Object.keys(report.artifacts).sort()).toEqual(["corrected1", "corrected2", "field", "sidecar"]);
});

for (const example of examples) {
  test(`example ${example.id} gives the native command line's field (port gate)`, async ({ page }) => {
    test.setTimeout(180000);
    await routeExample(page.context(), [...exampleUrls, native.url]);
    await page.goto("/");
    await page.locator("select[data-neurodesk-example]").selectOption(example.id);
    await expect(page.locator("#fileInfo")).toHaveText("Image 1: sub-01_dir-AP_dwi.nii.gz · j- · b = 0 mean of 13/13", { timeout: 120000 });
    await expect(page.locator("#pairInfo")).toHaveText("Image 2: sub-01_dir-PA_epi.nii.gz · j · b = 0 mean of 8/8");
    await page.locator("#runButton").click();
    await expect(page.locator("#statusText")).toContainText("Field estimated", { timeout: 120000 });
    const field = await volume(download(page, "Field map (Hz)"));
    const bytes = await pinnedBytes(page.request, native.url);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(native.sha256);
    const reference = readNiftiFrames(gunzipSync(bytes));
    const corrected = await volume(download(page, "Corrected image 1 (QC)"));
    expect(field.dims).toEqual(reference.dims);
    // The brain: corrected image 1 above a tenth of its maximum.
    let max = 0;
    for (const v of corrected.data) max = Math.max(max, v);
    const differences = [];
    for (let i = 0; i < field.data.length; i++) {
      if (corrected.data[i] > 0.1 * max) differences.push(Math.abs(field.data[i] - reference.data[i]));
    }
    differences.sort((a, b) => a - b);
    expect(differences.length).toBeGreaterThan(10000);
    expect(differences[differences.length >> 1]).toBeLessThan(0.1);
  });
}

for (const failure of ["download", "empty image"]) {
  test(`a failed ${failure} can retry the same example`, async ({ page }) => {
    test.setTimeout(150000);
    const example = examples[0];
    await routeExample(page.context(), exampleUrls);
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
  const example = examples[0];
  await routeExample(page.context(), exampleUrls);
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
  await page.waitForFunction(() => typeof window.finishExampleRead === "function");
  await page.getByRole("button", { name: "Cancel example download", exact: true }).click();
  await page.evaluate(() => window.finishExampleRead());
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "cancelled");
  await expect(page.locator("#fileInfo")).toBeHidden();
  await expect(page.locator("#runButton")).toBeDisabled();
  await expect(picker).toBeEnabled();
  await picker.selectOption(example.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 120000 });
});
