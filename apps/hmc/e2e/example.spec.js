import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { test, expect } from "@playwright/test";
import { readFile, readdir } from "node:fs/promises";
import { fetchPinnedExample } from "../../../test-utils/registration-similarity.mjs";
import { bidsTree, dropFolder } from "../../../test-utils/bids-folder-drop.mjs";
import { dicomSeries } from "../../../test-utils/dicom-fixture.mjs";
import { convertDicom } from "../../../packages/node-drivers/src/dcm2niix.js";
const dcm2niixGlue = new URL("./dist/dcm2niix.jpeg.js", pathToFileURL(createRequire(import.meta.url).resolve("@niivue/dcm2niix/package.json")));
import { createNiftiFromData, decodeNiftiBuffer, readNiftiFrames } from "@neurodesk/webapp-components/file-io/nifti";
import { fixture } from "./fixtures.mjs";

const [example] = JSON.parse(await readFile(new URL("../examples.json", import.meta.url), "utf8"));

test("a failed example download can retry the same selection", async ({ page }) => {
  const files = new Map(await Promise.all(example.files.map(async file => [file.url, await fetchPinnedExample(file.url)])));
  let fail = true;
  await page.route("**/*", route => {
    const bytes = files.get(route.request().url());
    if (!bytes) return route.continue();
    if (fail && route.request().url() === example.files[0].url) {
      fail = false;
      return route.fulfill({ status: 503, body: "", headers: { "access-control-allow-origin": "*" } });
    }
    return route.fulfill({ body: bytes, headers: { "access-control-allow-origin": "*" } });
  });
  await page.goto("./");
  const selector = page.locator("select[data-neurodesk-example]");
  await selector.selectOption(example.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "error");
  await expect(page.locator("#runButton")).toBeDisabled();
  await selector.selectOption(example.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready");
  await expect(page.locator("#fileInfo")).toContainText(example.files[0].name);
  await expect(page.locator("#runButton")).toBeEnabled();
});

test("cancelling a registration leaves the loaded input available for retry", async ({ page }) => {
  test.setTimeout(60000);
  const data = await fixture();
  const stem = "sub-test_dwi";
  const payload = (name, bytes) => ({ name, mimeType: "application/octet-stream", buffer: Buffer.from(bytes) });
  await page.goto("./");
  await page.locator("#imageInput").setInputFiles([
    payload(`${stem}.nii`, data.nifti), payload(`${stem}.bval`, data.bvals.join(" ")),
    payload(`${stem}.bvec`, data.bvecs.map(row => row.join(" ")).join("\n")),
  ]);
  await expect(page.locator("#runButton")).toBeEnabled();
  await page.locator("#advancedSettings > summary").click();
  await page.locator("#maskInput").setInputFiles(payload("mask.nii", data.maskNifti));
  await expect(page.locator("#statusText")).toHaveText("Brain mask loaded");
  await page.evaluate(() => {
    const send = Worker.prototype.postMessage;
    window.hmcHeld = 0;
    Worker.prototype.postMessage = function (message, ...rest) {
      if (message.argv) { window.hmcHeld++; return; }
      return send.call(this, message, ...rest);
    };
    window.restoreHmcWorkers = () => { Worker.prototype.postMessage = send; };
  });
  await page.locator("#runButton").click();
  await page.waitForFunction(() => window.hmcHeld > 0);
  await page.locator("#cancelButton").click();
  await expect(page.locator("#statusText")).toHaveText("Cancelled");
  await expect(page.locator("#fileInfo")).toContainText(stem);
  await expect(page.locator("#runButton")).toBeEnabled();
  await page.evaluate(() => window.restoreHmcWorkers());
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText("Head motion corrected", { timeout: 30000 });
  const pending = page.waitForEvent("download");
  await page.locator("#resultList .nd-volume-toggle").filter({ hasText: "sidecar" }).getByRole("button", { name: "Download" }).click();
  const metadata = JSON.parse(await readFile(await (await pending).path(), "utf8"));
  expect(metadata.HeadMotionCorrection.Mask.Source).toBe("supplied");
  await page.locator("#clearMask").click();
  await expect(page.locator("#clearMask")).toBeHidden();
  await expect(page.locator("#maskField .nd-file-text")).toHaveText("Drop a brain mask");
});

test("a failed BIDS run selection restores the previous input, mask and completed outputs", async ({ page }) => {
  test.setTimeout(60000);
  const data = await fixture();
  const files = [
    { name: "sub-test_dwi.nii", buffer: Buffer.from(data.nifti) },
    { name: "sub-test_dwi.bval", buffer: Buffer.from(data.bvals.join(" ")) },
    { name: "sub-test_dwi.bvec", buffer: Buffer.from(data.bvecs.map(row => row.join(" ")).join("\n")) },
  ];
  const tree = bidsTree(files);
  tree["ds/sub-01/dwi/sub-01_run-2_dwi.nii"] = Buffer.from("invalid NIfTI");
  await page.goto("./");
  await dropFolder(page, tree);
  await expect(page.locator("#fileInfo")).toContainText("sub-01_run-1_dwi.nii");
  await expect(page.locator("#runSelect")).toHaveValue("0");
  await page.locator("#advancedSettings > summary").click();
  await page.locator("#maskInput").setInputFiles({ name: "previous-mask.nii", mimeType: "application/octet-stream", buffer: Buffer.from(data.maskNifti) });
  await expect(page.locator("#statusText")).toHaveText("Brain mask loaded");
  await page.locator("#method").selectOption("trivial");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText("Head motion corrected", { timeout: 30000 });
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(6);
  await page.locator("#runSelect").selectOption("1");
  await expect(page.locator("#statusText")).toContainText("NIfTI");
  await expect(page.locator("#runButton")).toBeEnabled();
  await expect(page.locator("#runSelect")).toHaveValue("0");
  await expect(page.locator("#fileInfo")).toContainText("sub-01_run-1_dwi.nii");
  await expect(page.locator("#maskField .nd-file-text")).toHaveText("previous-mask.nii");
  await expect(page.locator("#clearMask")).toBeVisible();
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(6);
  const pending = page.waitForEvent("download");
  await page.locator("#resultList .nd-volume-toggle").filter({ hasText: "sidecar" }).getByRole("button", { name: "Download" }).click();
  const downloaded = await pending;
  expect(downloaded.suggestedFilename()).toContain("run-1");
  const metadata = JSON.parse(await readFile(await downloaded.path(), "utf8"));
  expect(metadata.HeadMotionCorrection.Mask.Source).toBe("supplied");
});


test("the mask picker accepts one extensionless DICOM series and rejects independent masks", async ({ page }) => {
  const dicom = dicomSeries({ extension: "" });
  const [converted] = await convertDicom(dicom.map(file => ({ name: file.name, bytes: file.buffer })), dcm2niixGlue);
  const header = await decodeNiftiBuffer(converted.bytes);
  const image = readNiftiFrames(header);
  const frames = new Float32Array(image.data.length * 2).fill(100);
  const nifti = createNiftiFromData(frames, header, { dims: [...image.dims, 2] });
  await page.goto("./");
  await page.locator("#imageInput").setInputFiles([
    { name: "image.nii", mimeType: "application/octet-stream", buffer: Buffer.from(nifti) },
    { name: "image.bval", mimeType: "text/plain", buffer: Buffer.from("0 1000") },
    { name: "image.bvec", mimeType: "text/plain", buffer: Buffer.from("0 1\n0 0\n0 0") },
  ]);
  await expect(page.locator("#statusText")).toHaveText("Diffusion image loaded");
  await page.locator("#advancedSettings > summary").click();
  const picker = page.locator("#maskInput");
  await expect(picker).not.toHaveAttribute("accept");
  await expect(picker).toHaveJSProperty("multiple", true);
  await picker.setInputFiles(dicom);
  await expect(page.locator("#statusText")).toHaveText("Brain mask loaded");
  await expect(page.locator("#clearMask")).toBeVisible();
  const mask = { name: "mask.nii", mimeType: "application/octet-stream", buffer: Buffer.from(header) };
  await picker.setInputFiles([mask, { ...mask, name: "other-mask.nii" }]);
  await expect(page.locator("#statusText")).toHaveText("Choose one NIfTI mask or one DICOM mask series.");
  await expect(page.locator("#clearMask")).toBeHidden();
  await picker.setInputFiles([...dicom, ...dicomSeries({ extension: "", series: 2 })]);
  await expect(page.locator("#statusText")).toHaveText("Choose one NIfTI mask or one DICOM mask series.");
  await expect(page.locator("#clearMask")).toBeHidden();
  await picker.setInputFiles(mask);
  await expect(page.locator("#statusText")).toHaveText("Brain mask loaded");
});

test("the production bundle contains one registration kernel pair", async () => {
  const assets = await readdir(new URL("../dist/assets/", import.meta.url));
  expect(assets.filter(name => /^hmc-registration-[\w-]+\.wasm$/.test(name))).toHaveLength(1);
  expect(assets.filter(name => /^hmc-registration-[\w-]+\.mjs$/.test(name))).toHaveLength(1);
  await expect(readdir(new URL("../dist/registration/", import.meta.url))).rejects.toMatchObject({ code: "ENOENT" });
});
