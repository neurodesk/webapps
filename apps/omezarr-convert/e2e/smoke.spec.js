// Browser tests against the production build (vite preview). The example is converted with
// each NGFF version and downloaded; the archive is unpacked in Node and checked against the
// bioformats2raw reference and the vendored OME-NGFF schemas (packages/omezarr-convert/validation).
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import { encode as encodePng } from "fast-png";
import { archiveStore, checkExample, rootAttributes, schemaErrors } from "../../../packages/omezarr-convert/validation/checks.mjs";

const examples = JSON.parse(readFileSync(new URL("../examples.json", import.meta.url), "utf8"));
const automation = JSON.parse(readFileSync(new URL("../automation.json", import.meta.url), "utf8"));
const [example] = examples;
const [exampleFile] = example.files;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const picker = (page) => page.getByRole("combobox", { name: "Input", exact: true });

async function loadExample(page) {
  await page.goto("/");
  await picker(page).selectOption(example.id);
  await expect(page.locator("#fileInfo")).toHaveText("retina-crop.ome.tif · 2 ch × 32 × 515 × 771 · uint8 · 0.02291 µm", { timeout: 120000 });
  await expect(page.locator("#runButton")).toBeEnabled();
}

async function downloadArchive(page) {
  const download = page.waitForEvent("download");
  await page.locator("#resultList .nd-volume-toggle").first().getByRole("button", { name: "Download", exact: true }).click();
  const file = await download;
  return { name: file.suggestedFilename(), bytes: readFileSync(await file.path()) };
}

test("the example converts to OME-Zarr 0.5 and 0.4 that match bioformats2raw and the schemas", async ({ page }) => {
  test.setTimeout(240000);
  await loadExample(page);
  // The file's voxel sizes fill the form; the section stays closed because nothing is missing.
  await expect(page.locator("#metadataSettings")).not.toHaveAttribute("open", "");
  await expect(page.locator("#sizeZ")).toHaveValue("0.2");
  await expect(page.locator("#sizeUnit")).toHaveValue("micrometer");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText("OME-Zarr ready", { timeout: 120000 });
  await expect(page.locator("#outputSection")).toHaveAttribute("open", "");
  await expect(page.locator("#resultList")).toContainText("OME-Zarr 0.5 · 3 levels");
  await expect(page.locator("#emptyState")).toBeHidden();
  const ozx = await downloadArchive(page);
  expect(ozx.name).toBe("retina_large crop.ozx");
  expect(await checkExample(archiveStore(unzipSync(ozx.bytes)), "0.5", "mean")).toEqual([]);

  await page.locator("#ngffVersion").selectOption("0.4");
  await page.locator("#method").selectOption("nearest");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText("OME-Zarr ready", { timeout: 120000 });
  const zip = await downloadArchive(page);
  expect(zip.name).toBe("retina_large crop.ome.zarr.zip");
  // Nearest is bioformats2raw's SIMPLE pyramid: pixels, chunks and metadata equal its output.
  expect(await checkExample(archiveStore(unzipSync(zip.bytes)), "0.4", "nearest")).toEqual([]);

  const report = page.waitForEvent("download");
  await page.locator("#resultList").getByText("Conversion report").locator("..").getByRole("button", { name: "Download", exact: true }).click();
  const json = JSON.parse(readFileSync(await (await report).path(), "utf8"));
  expect(json.settings).toEqual({ version: "0.4", method: "nearest", chunk: 256, compressionLevel: 6 });
  expect(json.levels.map(({ shape }) => shape)).toEqual([[1, 2, 32, 515, 771], [1, 2, 32, 257, 385], [1, 2, 32, 128, 192]]);
});

test("edited voxel sizes and channel names reach the metadata", async ({ page }) => {
  test.setTimeout(180000);
  await loadExample(page);
  await page.locator("#metadataSettings > summary").click();
  await page.locator("#sizeX").fill("0.1");
  await page.locator("#sizeY").fill("0.1");
  await page.locator("#sizeZ").fill("0.5");
  await page.locator("#channelName0").fill("Vessels");
  // Closing and reopening the section keeps what was typed.
  await page.locator("#metadataSettings > summary").click();
  await page.locator("#metadataSettings > summary").click();
  await expect(page.locator("#sizeZ")).toHaveValue("0.5");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText("OME-Zarr ready", { timeout: 120000 });
  const { bytes } = await downloadArchive(page);
  const map = archiveStore(unzipSync(bytes));
  const { ome } = rootAttributes(map, "0.5");
  expect(ome.multiscales[0].datasets.map(({ coordinateTransformations: [{ scale }] }) => scale)).toEqual([[1, 1, 0.5, 0.1, 0.1], [1, 1, 0.5, 0.2, 0.2], [1, 1, 0.5, 0.4, 0.4]]);
  expect(ome.omero.channels.map(({ label }) => label)).toEqual(["Vessels", "Channel 1"]);
  expect(schemaErrors({ ome }, "0.5")).toEqual([]);
});

test("a PNG sequence without a pixel size opens the voxel size fields and refuses a partial size", async ({ page }) => {
  test.setTimeout(120000);
  await page.goto("/");
  const frames = [3, 1, 2].map((z) => ({
    name: `cells_${z}.png`,
    mimeType: "image/png",
    buffer: Buffer.from(encodePng({ width: 300, height: 290, depth: 16, channels: 1, data: Uint16Array.from({ length: 300 * 290 }, (_, i) => (z * 7919 + i) % 65536) })),
  }));
  await page.locator("#imageInput").setInputFiles(frames);
  await expect(page.locator("#fileInfo")).toHaveText("3 files · 1 ch × 3 × 290 × 300 · uint16");
  await expect(page.locator("#metadataSettings")).toHaveAttribute("open", "");
  await page.locator("#sizeX").fill("0.65");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText("Give the Y voxel size as a positive number, or clear all three.");
  await page.locator("#sizeY").fill("0.65");
  await page.locator("#sizeZ").fill("2");
  await page.locator("#ngffVersion").selectOption("0.4");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText("OME-Zarr ready", { timeout: 60000 });
  const { name, bytes } = await downloadArchive(page);
  expect(name).toBe("cells.ome.zarr.zip");
  const map = archiveStore(unzipSync(bytes));
  const [image] = rootAttributes(map, "0.4").multiscales;
  expect(image.datasets.map(({ coordinateTransformations: [{ scale }] }) => scale)).toEqual([[1, 1, 2, 0.65, 0.65], [1, 1, 2, 1.3, 1.3]]);
  expect(image.axes.slice(2).map(({ unit }) => unit)).toEqual(["micrometer", "micrometer", "micrometer"]);
  expect(JSON.parse(new TextDecoder().decode(map.get("1/.zarray"))).shape).toEqual([1, 1, 3, 145, 150]);
});

test("folder output writes the store file by file into a new subfolder", async ({ page }) => {
  test.setTimeout(180000);
  await page.addInitScript(() => {
    // The origin-private file system stands in for the folder the user would choose.
    window.showDirectoryPicker = async () => {
      const root = await navigator.storage.getDirectory();
      return root.getDirectoryHandle("chosen", { create: true });
    };
  });
  await loadExample(page);
  await page.locator("#advancedSettings > summary").click();
  await expect(page.locator("#destinationField")).toBeVisible();
  await page.locator("#destination").selectOption("folder");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText("Saved to chosen/retina_large crop.ome.zarr", { timeout: 120000 });
  await expect(page.locator("#resultList")).toContainText("Conversion report");
  await expect(page.locator("#resultList")).not.toContainText("OME-Zarr 0.5 ·");
  const written = await page.evaluate(async () => {
    const root = await (await (await navigator.storage.getDirectory()).getDirectoryHandle("chosen")).getDirectoryHandle("retina_large crop.ome.zarr");
    const read = async (path) => {
      let folder = root;
      const parts = path.split("/");
      for (const part of parts.slice(0, -1)) folder = await folder.getDirectoryHandle(part);
      return new Uint8Array(await (await (await folder.getFileHandle(parts.at(-1))).getFile()).arrayBuffer());
    };
    const files = {};
    const walk = async (folder, prefix) => {
      for await (const [name, handle] of folder.entries()) {
        if (handle.kind === "directory") await walk(handle, `${prefix}${name}/`);
        else files[`${prefix}${name}`] = Array.from(await read(`${prefix}${name}`));
      }
    };
    await walk(root, "");
    return files;
  });
  const map = new Map(Object.entries(written).map(([key, bytes]) => [key, Uint8Array.from(bytes)]));
  expect(await checkExample(map, "0.5", "mean")).toEqual([]);
  // A second conversion into the same folder is refused instead of overwriting it.
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText("chosen already holds retina_large crop.ome.zarr; choose another folder or remove it.");
});

test("cancelling a conversion leaves no output and a rerun completes", async ({ page }) => {
  test.setTimeout(180000);
  await loadExample(page);
  await page.locator("#runButton").click();
  await expect(page.locator("#cancelButton")).toBeVisible();
  await expect(page.locator("#statusText")).toContainText("Converting… plane", { timeout: 30000 });
  await page.locator("#cancelButton").click();
  await expect(page.locator("#statusText")).toHaveText("Cancelled");
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(0);
  await expect(page.locator("#runButton")).toBeEnabled();
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText("OME-Zarr ready", { timeout: 120000 });
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(2);
});

test("a failed example download can retry the same example", async ({ page }) => {
  test.setTimeout(180000);
  let failing = true;
  let attempts = 0;
  // Every request fails until the selector gives up, outlasting its automatic retries.
  await page.context().route(exampleFile.url, (route) => {
    attempts += 1;
    return failing ? route.fulfill({ status: 503, body: "" }) : route.fallback();
  });
  await page.goto("/");
  await picker(page).selectOption(example.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "error", { timeout: 120000 });
  expect(attempts).toBeGreaterThan(0);
  await expect(page.locator("#runButton")).toBeDisabled();
  failing = false;
  await picker(page).selectOption(example.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 120000 });
  await expect(page.locator("#runButton")).toBeEnabled();
});

test("bytes that do not match the example's checksum are refused", async ({ page }) => {
  await page.context().route(exampleFile.url, (route) => route.fulfill({ status: 200, body: "not the example" }));
  await page.goto("/");
  await picker(page).selectOption(example.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "error", { timeout: 60000 });
  await expect(page.locator("#fileInfo")).toBeHidden();
  await expect(page.locator("#runButton")).toBeDisabled();
});

test("an unsupported file is refused by name", async ({ page }) => {
  await page.goto("/");
  await page.locator("#imageInput").setInputFiles({ name: "cells.czi", mimeType: "application/octet-stream", buffer: Buffer.from("ZISRAWFILE") });
  await expect(page.locator("#statusText")).toHaveText("cells.czi is not a TIFF, PNG, JPEG or NIfTI file.");
  await expect(page.locator("#runButton")).toBeDisabled();
});

test("the automation operation converts the example and reports both artifacts", async ({ page }) => {
  test.setTimeout(180000);
  const bytes = readFileSync(process.env.OMEZARR_CONVERT_EXAMPLE ?? (await fetchExample()));
  await page.goto("/");
  await page.locator("#neurodesk-input-transfer").setInputFiles({ name: exampleFile.name, mimeType: "image/tiff", buffer: bytes });
  await page.evaluate(async () => {
    await globalThis.neurodeskAutomation.dispatch("adopt", { role: "image" });
    await globalThis.neurodeskAutomation.dispatch("start", { parameters: { version: "0.4", method: "nearest" } });
  });
  await expect.poll(() => page.evaluate(async () => (await globalThis.neurodeskAutomation.dispatch("snapshot")).state), { timeout: 120000 }).not.toBe("running");
  const snapshot = await page.evaluate(async () => globalThis.neurodeskAutomation.dispatch("snapshot"));
  expect(snapshot.error ?? null, JSON.stringify(snapshot.error)).toBeNull();
  expect(snapshot.state).toBe("succeeded");
  const { report } = snapshot;
  expect(Object.keys(report.artifacts).sort()).toEqual(["archive", "summary"]);
  const download = page.waitForEvent("download");
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch("download", { artifactId: "archive" }));
  const archive = readFileSync(await (await download).path());
  expect(sha256(archive)).toBe(report.artifacts.archive.sha256);
  expect(await checkExample(archiveStore(unzipSync(archive)), "0.4", "nearest")).toEqual([]);
});

let examplePath = null;
async function fetchExample() {
  if (examplePath) return examplePath;
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const bytes = Buffer.from(await (await fetch(exampleFile.url)).arrayBuffer());
  if (sha256(bytes) !== exampleFile.sha256) throw new Error("The hosted example does not match its checksum.");
  examplePath = join(mkdtempSync(join(tmpdir(), "omezarr-")), exampleFile.name);
  writeFileSync(examplePath, bytes);
  return examplePath;
}

test("shared app bar owns information actions and theme", async ({ page }) => {
  await page.goto("/");
  const bar = page.locator(".nd-app-bar:visible");
  await expect(bar).toHaveCount(1);
  await bar.getByRole("button", { name: "About", exact: true }).click();
  const about = page.locator('dialog[data-dialog="about"]');
  await expect(about).toBeVisible();
  await expect(about.getByRole("heading", { name: `About ${automation.title}`, exact: true })).toBeVisible();
  for (const guidance of ["OME-NGFF 0.5", "bioformats2raw 0.14.0", "CZI, LIF, ND2", "no affine"]) await expect(about).toContainText(guidance);
  await about.getByRole("button", { name: "Close" }).click();
  await bar.locator("[data-neurodesk-theme-toggle]").click();
  await expect(page.locator("html")).toHaveAttribute("data-neurodesk-theme", "light");
});
