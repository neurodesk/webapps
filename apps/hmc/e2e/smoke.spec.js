import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { unzipSync } from "fflate";
import { loadHmcNode, nodeRuntime } from "@neurodesk/hmc/node";
import { correctNiFreeze } from "@neurodesk/hmc/nifreeze";
import { fixture } from "./fixtures.mjs";
import { dropFolder } from "../../../test-utils/bids-folder-drop.mjs";
import { fetchPinnedExample } from "../../../test-utils/registration-similarity.mjs";
import { createNiftiFromData, decodeNiftiBuffer } from "@neurodesk/webapp-components/file-io/nifti";
import { readSeries } from "@neurodesk/hmc";

test("example inputs and mask resets preserve page-drop routing", async ({ page }) => {
  test.setTimeout(90000);
  const examples = JSON.parse(await readFile(new URL("../examples.json", import.meta.url), "utf8"));
  const bytes = new Map(await Promise.all(examples[0].files.map(async file => [file.url, await fetchPinnedExample(file.url)])));
  const image = examples[0].files.find(file => file.role === "image");
  const buffer = await decodeNiftiBuffer(bytes.get(image.url));
  const { dims } = await readSeries(buffer);
  const maskNifti = new Uint8Array(createNiftiFromData(new Float32Array(dims.reduce((a, b) => a * b, 1)).fill(1), buffer, { dims }));
  for (const file of examples[0].files) {
    await page.route(file.url, route => route.fulfill({ body: bytes.get(file.url), headers: { "access-control-allow-origin": "*", "cross-origin-resource-policy": "cross-origin" } }));
  }
  await page.goto("./");
  const selector = page.getByRole("combobox", { name: "Input", exact: true });
  const loadExample = async () => {
    await selector.selectOption(examples[0].id);
    await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 30000 });
  };
  const dropMask = async () => {
    await dropFolder(page, { "mask/routing-mask.nii": Buffer.from(maskNifti) });
    await expect(page.locator("#statusText")).toHaveText("Brain mask loaded");
    await expect(page.locator("#clearMask")).toBeVisible();
  };
  await loadExample();
  await page.locator("#advancedSettings > summary").click();
  await dropMask();
  await page.locator("#clearMask").click();
  await dropMask();
  await loadExample();
  await expect(page.locator("#clearMask")).toBeHidden();
  await dropMask();
  const invalidMask = Buffer.from(maskNifti);
  invalidMask.writeInt16LE(3, 42);
  await page.locator("#maskInput").setInputFiles({ name: "wrong-grid.nii", mimeType: "application/octet-stream", buffer: invalidMask });
  await expect(page.locator("#statusText")).toHaveClass(/error/);
  await expect(page.locator("#clearMask")).toBeHidden();
  await dropMask();
  await expect(page.locator("#fileInfo")).toContainText(examples[0].files.find(file => file.role === "image").name);
  await page.locator("#imageInput").setInputFiles({ name: "missing-gradients.nii", mimeType: "application/octet-stream", buffer: Buffer.from("not a diffusion series") });
  await expect(page.locator("#statusText")).toHaveClass(/error/);
  await expect(page.locator("#fileInfo")).toContainText(image.name);
  const replacement = Object.fromEntries(examples[0].files.map(file => [`replacement/${file.name.replace("sub-01", "sub-02")}`, bytes.get(file.url)]));
  replacement["replacement/replacement-mask.nii"] = Buffer.from(maskNifti);
  await dropFolder(page, replacement);
  await expect(page.locator("#fileInfo")).toContainText("sub-02");
  await expect(page.locator("#maskField")).toContainText("replacement-mask.nii");
  await page.locator(".nd-status-undo").click();
  await expect(page.locator("#fileInfo")).toContainText(image.name);
  await expect(page.locator("#clearMask")).toBeVisible();
  await expect(page.locator("#maskField")).toContainText("routing-mask.nii");
  await page.evaluate(() => {
    const read = File.prototype.arrayBuffer;
    let held = false;
    File.prototype.arrayBuffer = function (...args) {
      if (!held && this.name.startsWith("sub-02") && this.name.endsWith(".nii.gz")) {
        held = true;
        window.hmcReadHeld = true;
        return new Promise(resolve => { window.releaseHmcRead = async () => resolve(await read.apply(this, args)); });
      }
      return read.apply(this, args);
    };
  });
  await dropFolder(page, replacement);
  await expect.poll(() => page.evaluate(() => Boolean(window.hmcReadHeld))).toBe(true);
  await expect(page.locator(".nd-status-undo")).toBeDisabled();
  await page.locator("#cancelButton").click();
  await page.evaluate(() => window.releaseHmcRead());
  await expect(page.locator("#statusText")).toHaveText("Cancelled");
  await expect(page.locator("#fileInfo")).toContainText(image.name);
  await expect(page.locator("#maskField")).toContainText("routing-mask.nii");
  await page.locator(".nd-status-undo").click();
  await expect(page.locator("#clearMask")).toBeVisible();
  await expect(page.locator("#maskField")).toContainText("routing-mask.nii");
});

test("workspace boots with shared information and GP as default", async ({ page }) => {
  await page.goto("./");
  await expect(page.locator("#viewer")).toBeVisible();
  await expect(page.locator("#method")).toHaveValue("gp");
  await expect(page.locator("#workers")).toHaveValue("2");
  await page.locator("#advancedSettings > summary").click();
  await page.locator("#workers").fill("4");
  await page.locator("#method").selectOption("trivial");
  await expect(page.locator("#workers")).toHaveValue("4");
  await page.locator("#method").selectOption("gp");
  await expect(page.locator("#workers")).toHaveValue("4");
  expect(await page.evaluate(() => self.crossOriginIsolated)).toBe(true);
  await page.locator(".nd-app-bar").getByRole("button", { name: "About", exact: true }).click();
  await expect(page.locator("#infoDialog")).toContainText("NiFreeze");
});

for (const model of ["trivial", "gp"]) {
  test(`${model} production browser outputs equal independent Node pipeline`, async ({ page }) => {
    test.setTimeout(180000);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const data = await fixture();
    const name = "sub-01_ses-01_dwi.nii.gz";
    const inputs = {
      image: { name, bytes: data.nifti },
      bval: { name: "input.bval", bytes: Buffer.from(data.bvals.join(" ")) },
      bvec: { name: "input.bvec", bytes: Buffer.from(data.bvecs.map(row => row.join(" ")).join("\n")) },
      mask: { name: "mask.nii", bytes: data.maskNifti },
    };
    await page.goto("./");
    for (const [role, input] of Object.entries(inputs)) {
      await page.locator("#neurodesk-input-transfer").setInputFiles({ name: input.name, mimeType: "application/octet-stream", buffer: Buffer.from(input.bytes) });
      await page.evaluate(role => globalThis.neurodeskAutomation.dispatch("adopt", { role }), role);
    }
    await page.evaluate(method => globalThis.neurodeskAutomation.dispatch("start", { parameters: { method, seed: 1234 } }), model);
    await expect.poll(() => page.evaluate(async () => {
      const state = await globalThis.neurodeskAutomation.dispatch("snapshot");
      return state.state === "failed" ? JSON.stringify(state) : state.state;
    }), { timeout: 150000 }).toBe("succeeded");
    const report = await page.evaluate(async () => (await globalThis.neurodeskAutomation.dispatch("snapshot")).report);
    expect(report.provenance.workers).toBe(2);
    const expected = await correctNiFreeze({ series: data.series, bvals: data.bvals, bvecs: data.bvecs, mask: data.mask,
      model, seed: 1234, maskProvenance: { Source: "supplied" }, fileName: name, hmc: await loadHmcNode(), runtime: nodeRuntime({ workers: 1 }),
    });
    for (const role of ["image", "bval", "bvec", "motion", "sidecar", "transforms"]) {
      const event = page.waitForEvent("download");
      await page.evaluate(artifactId => globalThis.neurodeskAutomation.dispatch("download", { artifactId }), role);
      const bytes = new Uint8Array(await readFile(await (await event).path()));
      if (role === "transforms") {
        const files = unzipSync(bytes);
        expect(Object.keys(files).sort()).toEqual(Object.keys(expected.files).filter(name => name.endsWith(".mat")).sort());
        for (const [name, bytes] of Object.entries(files)) expect(bytes, name).toEqual(expected.files[name]);
      } else {
        const wanted = expected.files[expected.names[role]];
        expect(role === "image" ? gunzipSync(bytes) : bytes, role).toEqual(role === "image" ? gunzipSync(wanted) : wanted);
      }
      expect(report.artifacts[role]).toBeTruthy();
    }
    expect(errors).toEqual([]);
  });
}
