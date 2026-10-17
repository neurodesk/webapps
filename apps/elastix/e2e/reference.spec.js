import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { PRESETS, compare, elastixWasmSha256, expectedNames, pinnedExample, readReference, summarize, writeReference } from "../../../packages/elastix/validation/reference.mjs";

// Registers the pinned 1 mm example through the app itself (file inputs,
// worker, served pipelines) with every preset and compares the downloads with
// packages/elastix/validation/t1-mni-reference.json, which the command line's
// release check also uses. Runs only when ELASTIX_BROWSER_REFERENCE is "check"
// or "write" ("write" records the result).
const mode = process.env.ELASTIX_BROWSER_REFERENCE;
const minutes = 60_000;

test("web app registrations of the pinned example match the browser reference", { tag: "@slow" }, async ({ page, browser }) => {
  test.skip(mode !== "check" && mode !== "write", "set ELASTIX_BROWSER_REFERENCE=check or write");
  test.setTimeout(40 * minutes);
  page.context().on("request", (request) => {
    if (request.url().includes("cdn.jsdelivr.net")) throw new Error(`Pipeline fetched from a CDN: ${request.url()}`);
  });
  const example = await pinnedExample();
  await page.goto("/");
  await expect(page.locator("#movingInput")).toBeEnabled({ timeout: 2 * minutes });
  for (const [slot, file] of [["moving", example.moving], ["stationary", example.fixed]]) {
    await page.locator(`#${slot}Input`).setInputFiles({ name: file.name, mimeType: "application/gzip", buffer: await readFile(file.path) });
    await expect(page.locator(`#${slot}Info`)).toContainText(file.name, { timeout: 2 * minutes });
  }
  const fixed = await readFile(example.fixed.path);
  const presets = {};
  for (const method of PRESETS) {
    await page.locator("#method").selectOption(method);
    const started = performance.now();
    await page.locator("#runButton").click();
    await expect(page.locator("#statusText")).toContainText("Registration complete", { timeout: 20 * minutes });
    const seconds = Math.round((performance.now() - started) / 1000);
    const files = {};
    for (const name of expectedNames(example.moving.name, method)) {
      const row = page.locator("#resultList .nd-volume-toggle").filter({ hasText: name.endsWith(".toml") ? name.replace(/^.*_(TransformParameters\.\d+\.toml)$/, "$1") : rowLabel(name) });
      const [download] = await Promise.all([page.waitForEvent("download", { timeout: 10 * minutes }), row.getByRole("button", { name: "Download" }).click()]);
      expect(download.suggestedFilename()).toBe(name);
      files[name] = await readFile(await download.path());
    }
    if (method === "bspline") await expect(page.locator("#resultList")).not.toContainText("Transform (ITK HDF5)");
    presets[method] = { seconds, artifacts: await summarize(files, fixed, example.moving.name, method) };
  }
  if (mode === "write") {
    const version = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version;
    await writeReference({
      example: example.id,
      inputs: { [example.moving.name]: example.moving.sha256, [example.fixed.name]: example.fixed.sha256 },
      elastixWasmSha256: await elastixWasmSha256(),
      browser: {
        path: "apps/elastix/e2e/reference.spec.js: the app's file inputs, registration and IO workers, built assets",
        app: `elastix ${version}`,
        browser: `Chromium ${browser.version()}`,
        presets,
      },
    });
    return;
  }
  const reference = await readReference();
  const failures = PRESETS.flatMap((method) => compare(`web app ${method}:`, presets[method].artifacts, reference.browser.presets[method].artifacts, "browser"))
    .filter(([passed]) => !passed)
    .map(([, line]) => line);
  expect(failures).toEqual([]);
});

function rowLabel(name) {
  if (name.endsWith("_registered.nii.gz")) return "Registered NIfTI";
  if (name.endsWith("_transform.h5")) return "Transform (ITK HDF5)";
  return "Transform (OME-Zarr)";
}
