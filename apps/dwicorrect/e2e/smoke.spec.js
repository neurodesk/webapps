// Browser tests against `vite preview` of the production build: boot and the shared shell,
// cross-origin isolation for the threaded module, the synthetic phantom through the whole
// correction (MindGrab mask, field from the reverse b0, shoreline) to its downloads, the
// defaults the series sets, cancellation and retry, and the automation operation.
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { readNiftiFrames } from "@neurodesk/webapp-components/file-io";
import { exampleFiles, truthParameters } from "./fixtures.mjs";

const examples = JSON.parse(readFileSync(new URL("../examples.json", import.meta.url), "utf8"));

async function download(page, label) {
  const event = page.waitForEvent("download");
  await page.locator("#resultList .nd-volume-toggle").filter({ hasText: label }).getByRole("button", { name: "Download" }).click();
  return readFileSync(await (await event).path());
}

async function loadPhantom(page, options) {
  await page.goto("/");
  // The app is ready once it has built its example selector.
  await page.locator("select[data-neurodesk-example]").waitFor();
  await page.locator("#imageInput").setInputFiles(exampleFiles(options));
  await expect(page.locator("#runButton")).toBeEnabled({ timeout: 60_000 });
}

test("app boots on its workspace, isolated for threads", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#viewer")).toBeVisible();
  await expect(page.locator("#statusText")).toHaveText("Drag and drop files");
  expect(await page.evaluate(() => self.crossOriginIsolated === true)).toBe(true);
});

test("shared app bar owns information actions and theme", async ({ page }) => {
  await page.goto("/");
  const bar = page.locator(".nd-app-bar:visible");
  await expect(bar).toHaveCount(1);
  await expect(page.locator("#controls > #aboutBtn")).toBeHidden();
  await bar.getByRole("button", { name: "About", exact: true }).click();
  await expect(page.locator("#infoDialog")).toBeVisible();
  await page.locator("#infoDialog").getByRole("button", { name: "Close" }).click();
});

test("the series sets the defaults, and each states its rule", async ({ page }) => {
  await loadPhantom(page);
  await expect(page.locator("#fileInfo")).toHaveText("sub-phantom_dwi.nii.gz");
  await expect(page.locator("#seriesInfo")).toHaveText("102 volumes: 6\u00a0b0 · b1000\u00a0×32 · b2000\u00a0×64");
  await expect(page.locator("#acquisitionInfo")).toHaveText("PE j, 50 ms readout");
  await expect(page.locator("#fieldInfo")).toContainText("Reverse-PE b0: sub-phantom_dir-reverse_epi.nii.gz");
  await expect(page.locator("#fieldSource")).toHaveValue("reverse");
  await expect(page.locator("#model")).toHaveValue("shore");

  await expect(page.locator("#imageLabel")).toHaveText("Input, volume 1");
  await expect(page.locator("#preview")).toBeHidden();
  await expect(page.locator("#outlierType")).toHaveValue("sw");
  await expect(page.locator("#sliceToVolume")).toBeDisabled();
  await expect(page.locator("#acquisitionFields")).toBeHidden();
});

test("the phantom is corrected: field from the reverse b0, motion, outliers, downloads", async ({ page }) => {
  test.setTimeout(600_000);
  await loadPhantom(page);
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Corrected in", { timeout: 540_000 });
  await expect(page.locator("#statusText")).toContainText("4 outlier slices replaced");
  for (const label of ["Corrected series", "b-values", "Rotated b-vectors", "Sidecar", "Movement per volume", "Outlier slices", "Brain mask (MindGrab)", "Field map (Hz)", "Log"]) {
    await expect(page.locator("#resultList .nd-volume-toggle").filter({ hasText: label })).toHaveCount(1);
  }
  const corrected = readNiftiFrames(gunzipSync(await download(page, "Corrected series")));
  expect(corrected.dims).toEqual([26, 36, 18]);
  expect(corrected.frames).toBe(102);
  const confounds = (await download(page, "Movement per volume")).toString().trim().split("\n").map((line) => line.split("\t"));
  expect(confounds[0].slice(0, 6)).toEqual(["trans_x", "trans_y", "trans_z", "rot_x", "rot_y", "rot_z"]);
  // The estimated movement follows the phantom's (median error well under a voxel).
  const truth = truthParameters();
  const errors = confounds.slice(1).flatMap((row, v) => [0, 1, 2].map((a) => Math.abs(Number(row[a]) - truth[v][a]))).sort((a, b) => a - b);
  expect(errors[Math.floor(errors.length / 2)]).toBeLessThan(0.4);
  const sidecar = JSON.parse((await download(page, "Sidecar")).toString());
  expect(sidecar.DwicorrectSettings.SusceptibilityField).toBe("estimated");
  expect(sidecar.DwicorrectSettings.CommandLine).toContain("--field=field.nii.gz");
  expect(sidecar.PhaseEncodingDirection).toBe("j");
  await expect(page.locator("#preview")).toBeVisible();
  expect(await page.locator("#preview").evaluate((img) => img.naturalWidth > 0 && img.src.startsWith("blob:"))).toBe(true);
  await page.locator("#viewer .nd-view-tab", { hasText: "Motion" }).click();
  await expect(page.locator("#motionReport")).toBeVisible();
  await expect(page.locator("#motionReport tr[data-flag]")).toHaveCount(4);
});

test("without the reverse b0 the series is corrected without a field", async ({ page }) => {
  await loadPhantom(page, { skip: ["sub-phantom_dir-reverse_epi.nii.gz", "sub-phantom_dir-reverse_epi.json"] });
  await expect(page.locator("#fieldSource")).toHaveValue("none");

});

test("a sidecar without phase encoding asks for it", async ({ page }) => {
  await loadPhantom(page, { skip: ["sub-phantom_dwi.json", "sub-phantom_dir-reverse_epi.nii.gz", "sub-phantom_dir-reverse_epi.json"] });
  await expect(page.locator("#acquisitionFields")).toBeVisible();
});

test("a correction can be cancelled and run again", async ({ page }) => {
  test.setTimeout(600_000);
  await loadPhantom(page, { skip: ["sub-phantom_dir-reverse_epi.nii.gz", "sub-phantom_dir-reverse_epi.json"] });
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Correcting", { timeout: 120_000 });
  await page.locator("#cancelButton").click();
  await expect(page.locator("#statusText")).toHaveText("Cancelled");
  await expect(page.locator("#runButton")).toBeEnabled();
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Corrected in", { timeout: 540_000 });
});

test("the example selector lists the synthetic phantom", async ({ page }) => {
  await page.goto("/");
  const options = await page.locator("select[data-neurodesk-example] option").evaluateAll((list) => list.map((o) => o.value).filter(Boolean));
  expect(options).toEqual(examples.map((example) => example.id));
});
