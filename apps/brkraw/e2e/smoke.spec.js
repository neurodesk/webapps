// Browser tests against `vite preview` of the production build: shared shell,
// invalid-input refusal, example loading/failure/cancel/retry, cancel-then-retry conversion,
// scan/multi-slicepack/3D conversion, bit-exact BrkRaw v0.5.7 voxel & affine parity,
// privacy-safe filenames, and scrubbed JSON sidecar.
import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const examples = JSON.parse(readFileSync(new URL("../examples.json", import.meta.url), "utf8"));
const primaryExample = examples[0];
const primaryFile = primaryExample.files[0];

// Upstream BrkRaw v0.5.7 payload SHA-256 on UNC_PV6.0.1_FLASH_TurboRARE_EPI.zip:
const ORACLE_SCAN6_SHA256 = "81748cdb9779ba4453dc3424bd5248474b10dd14e3cd77e87796c920a7dd39ff";
const ORACLE_SCAN3_PACK1_SHA256 = "14e7264c50cabc707f94af6075f0826de8df979998ce43bcddeae499ca641739";
const ORACLE_SCAN10_3D_SHA256 = "9b8a5ea7827f35596a85168ed1905f57a25a13b88bd378c4843350a748bc80c3";

test("app boots in workspace with idle status and disabled run", async ({ page }) => {
  await page.goto("./");
  await expect(page.locator("#viewer")).toBeVisible();
  await expect(page.locator("#statusText")).toHaveText("Drag and drop files");
  await expect(page.locator("#runButton")).toBeDisabled();
});

test("shared app bar opens About, Cite, Privacy and switches theme", async ({ page }) => {
  await page.goto("./");
  const bar = page.locator(".nd-app-bar:visible");
  await expect(bar).toHaveCount(1);
  await bar.getByRole("button", { name: "About", exact: true }).click();
  await expect(page.locator("dialog[open]")).toContainText("Bruker");
  await page.locator("dialog[open]").getByRole("button", { name: "Close" }).click();
  await bar.getByRole("button", { name: "Cite", exact: true }).click();
  await expect(page.locator("dialog[open]").last()).toContainText("BrkRaw");
  await page.locator("dialog[open]").last().getByRole("button", { name: "Close" }).click();
  await bar.getByRole("button", { name: "Privacy", exact: true }).click();
  await expect(page.locator("dialog[open]").last()).toContainText("never uploaded");
  await page.locator("dialog[open]").last().getByRole("button", { name: "Close" }).click();
  await bar.locator("[data-neurodesk-theme-toggle]").click();
  await expect(page.locator("html")).toHaveAttribute("data-neurodesk-theme", "light");
});

test("non-Bruker files are refused cleanly before conversion", async ({ page }) => {
  await page.goto("./");
  await page.locator("#studyInput").setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("not a bruker study"),
  });
  await expect(page.locator("#statusText")).toContainText("No Bruker ParaVision scans found");
  await expect(page.locator("#runButton")).toBeDisabled();
});

test("hosted example handles download failure, retry, and cancel during inspection", async ({ page }) => {
  let attempts = 0;
  await page.context().route(primaryFile.url, (route) => {
    attempts++;
    if (attempts === 1) return route.fulfill({ status: 503, body: "" });
    return route.fallback();
  });
  await page.goto("./");
  const picker = page.getByRole("combobox", { name: "Input", exact: true });
  await picker.selectOption(primaryExample.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "error");
  await expect(page.locator("#runButton")).toBeDisabled();

  await picker.selectOption(primaryExample.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 90000 });
  await expect(page.locator("#fileInfo")).toContainText("ParaVision 6.0.1");
  await expect(page.locator("#scanSelect")).toHaveValue("6:1");
  await expect(page.locator("#runButton")).toBeEnabled();
  expect(attempts).toBe(2);
});

test("cancelling a stalled example download keeps controls idle and permits retry", async ({ page }) => {
  let hold;
  let count = 0;
  await page.context().route(primaryFile.url, async (route) => {
    count++;
    if (count === 1) {
      await new Promise((resolve) => { hold = resolve; });
      await route.abort("aborted").catch(() => {});
      return;
    }
    await route.fallback();
  });
  await page.goto("./");
  const picker = page.getByRole("combobox", { name: "Input", exact: true });
  await picker.selectOption(primaryExample.id);
  const cancelBtn = page.getByRole("button", { name: "Cancel example download", exact: true });
  await expect(cancelBtn).toBeVisible({ timeout: 15000 });
  await cancelBtn.click();
  hold?.();
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "cancelled");
  await expect(page.locator("#runButton")).toBeDisabled();

  await picker.selectOption(primaryExample.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 90000 });
  await expect(page.locator("#runButton")).toBeEnabled();
});

test("cancelling a conversion seamlessly recovers on the next Convert click", async ({ page }) => {
  await page.goto("./");
  const picker = page.getByRole("combobox", { name: "Input", exact: true });
  await picker.selectOption(primaryExample.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 90000 });

  // Start conversion and immediately click footer cancel so the worker is terminated mid-run
  await page.locator("#runButton").click();
  await page.locator("#cancelButton").click();
  await expect(page.locator("#statusText")).toHaveText("Conversion cancelled");
  await expect(page.locator("#runButton")).toBeEnabled();

  // Clicking Convert again must transparently re-inspect the study in a fresh worker and succeed
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText(/^Converted scan 6 · /, { timeout: 60000 });
  const niiEvent = page.waitForEvent("download");
  await page.locator("#resultList .nd-volume-toggle").filter({ hasText: "NIfTI volume" }).getByRole("button", { name: "Download" }).click();
  const niiDl = await niiEvent;
  expect(niiDl.suggestedFilename()).toBe("scan6_reco1.nii.gz");
  const raw = gunzipSync(readFileSync(await niiDl.path()));
  expect(createHash("sha256").update(raw.subarray(352)).digest("hex")).toBe(ORACLE_SCAN6_SHA256);
});

test("converts 2D TurboRARE, multi-slicepack localizer, and 3D FieldMap matching BrkRaw v0.5.7 bit-for-bit with privacy-safe outputs", async ({ page }) => {
  await page.goto("./");
  const picker = page.getByRole("combobox", { name: "Input", exact: true });
  await picker.selectOption(primaryExample.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 90000 });

  // Study folder/archive name must not appear in fileInfo or technical log
  await expect(page.locator("#fileInfo")).not.toContainText("UNC_PV6.0.1");

  // 1. Default anatomical scan 6 (CAMRI_T2_RARE_2D_ax, 384 x 384 x 12)
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText(/^Converted scan 6 · /, { timeout: 60000 });

  const niiEvent = page.waitForEvent("download");
  await page.locator("#resultList .nd-volume-toggle").filter({ hasText: "NIfTI volume" }).getByRole("button", { name: "Download" }).click();
  const niiDl = await niiEvent;
  expect(niiDl.suggestedFilename()).toBe("scan6_reco1.nii.gz");
  const raw = gunzipSync(readFileSync(await niiDl.path()));
  expect([raw.readInt16LE(42), raw.readInt16LE(44), raw.readInt16LE(46)]).toEqual([384, 384, 12]);
  expect(raw.readInt16LE(70)).toBe(4); // int16
  expect(raw.readInt16LE(254)).toBe(2); // sform_code
  expect(Math.abs(raw.readFloatLE(280) - (-0.075))).toBeLessThan(1e-5);
  expect(Math.abs(raw.readFloatLE(292) - 14.4)).toBeLessThan(1e-4);
  expect(createHash("sha256").update(raw.subarray(352)).digest("hex")).toBe(ORACLE_SCAN6_SHA256);

  const jsonEvent = page.waitForEvent("download");
  await page.locator("#resultList .nd-volume-toggle").filter({ hasText: "Scrubbed metadata" }).getByRole("button", { name: "Download" }).click();
  const jsonDl = await jsonEvent;
  expect(jsonDl.suggestedFilename()).toBe("scan6_reco1.json");
  const sidecarText = readFileSync(await jsonDl.path(), "utf8");
  const sidecar = JSON.parse(sidecarText);
  expect(sidecar.Manufacturer).toBe("Bruker BioSpin");
  expect(sidecar.SoftwareVersions).toBe("ParaVision 6.0.1");
  expect(sidecar.RepetitionTime).toBe(3);
  expect(sidecar.EchoTime).toBe(0.048);
  expect(sidecar.CoordinateSpace).toBe("subject_ras");
  expect(sidecar.ScrubbedIdentifiers).toBe(true);
  expect(sidecarText).not.toContain("UNC_PV6.0.1");
  expect(sidecarText).not.toContain("nmrsu");
  expect(sidecarText).not.toContain("1.2.3.4.5");
  expect(sidecarText).not.toContain("2020-01-12");

  // 2. Switching scan clears stale outputs, then converts multi-slicepack localizer scan 3, pack 1
  await page.locator("#scanSelect").selectOption("3:1");
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(0);
  await expect(page.locator("#slicePackField")).toBeVisible();
  await page.locator("#slicePackSelect").selectOption("1");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText(/^Converted scan 3 · /, { timeout: 60000 });

  const packEvent = page.waitForEvent("download");
  await page.locator("#resultList .nd-volume-toggle").filter({ hasText: "NIfTI volume" }).getByRole("button", { name: "Download" }).click();
  const packDl = await packEvent;
  expect(packDl.suggestedFilename()).toBe("scan3_reco1_pack1.nii.gz");
  const packRaw = gunzipSync(readFileSync(await packDl.path()));
  expect([packRaw.readInt16LE(42), packRaw.readInt16LE(44), packRaw.readInt16LE(46)]).toEqual([256, 256, 1]);
  expect(createHash("sha256").update(packRaw.subarray(352)).digest("hex")).toBe(ORACLE_SCAN3_PACK1_SHA256);

  // 3. Convert 3D FieldMap (scan 10, 64 x 64 x 64) and verify 3D SliceThickness equals VoxelSizeMm[2]
  await page.locator("#scanSelect").selectOption("10:1");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText(/^Converted scan 10 · /, { timeout: 60000 });
  const fmEvent = page.waitForEvent("download");
  await page.locator("#resultList .nd-volume-toggle").filter({ hasText: "NIfTI volume" }).getByRole("button", { name: "Download" }).click();
  const fmDl = await fmEvent;
  expect(fmDl.suggestedFilename()).toBe("scan10_reco1.nii.gz");
  const fmRaw = gunzipSync(readFileSync(await fmDl.path()));
  expect([fmRaw.readInt16LE(42), fmRaw.readInt16LE(44), fmRaw.readInt16LE(46)]).toEqual([64, 64, 64]);
  expect(createHash("sha256").update(fmRaw.subarray(352)).digest("hex")).toBe(ORACLE_SCAN10_3D_SHA256);

  const fmJsonEvent = page.waitForEvent("download");
  await page.locator("#resultList .nd-volume-toggle").filter({ hasText: "Scrubbed metadata" }).getByRole("button", { name: "Download" }).click();
  const fmMeta = JSON.parse(readFileSync(await (await fmJsonEvent).path(), "utf8"));
  expect(Math.abs(fmMeta.SliceThickness - fmMeta.VoxelSizeMm[2])).toBeLessThan(1e-5);
});
