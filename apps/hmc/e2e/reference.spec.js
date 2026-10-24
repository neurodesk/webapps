import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { unzipSync } from "fflate";
import { fetchPinnedExample } from "../../../test-utils/registration-similarity.mjs";
import { readNiftiFrames } from "@neurodesk/webapp-components/file-io/nifti";

const [example] = JSON.parse(await readFile(new URL("../examples.json", import.meta.url), "utf8"));
const referencePath = new URL("../../../packages/hmc/validation/browser-reference.json", import.meta.url);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

for (const method of ["trivial", "gp"]) {
  test(`${method} pinned example runs with automatic CPU masking and downloads every derivative`, async ({ page }) => {
    test.setTimeout(1200000);
    const inputs = {};
    const cached = new Map();
    for (const file of example.files) {
      const bytes = await fetchPinnedExample(file.url);
      expect(hash(bytes)).toBe(file.sha256);
      inputs[file.role === "image" ? "dwi" : file.role] = { name: file.name, url: file.url, sha256: file.sha256 };
      cached.set(file.url, bytes);
    }
    await page.route("**/*", route => {
      const bytes = cached.get(route.request().url());
      if (!bytes) return route.continue();
      return route.fulfill({ body: bytes, headers: { "access-control-allow-origin": "*", "cross-origin-resource-policy": "cross-origin" } });
    });
    const failures = [];
    page.on("pageerror", error => failures.push(error.message));
    await page.goto("./");
    await page.locator("select[data-neurodesk-example]").selectOption(example.id);
    await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 120000 });
    await expect(page.locator("#runButton")).toBeEnabled({ timeout: 120000 });
    await page.locator("#method").selectOption(method);
    await page.locator("#runButton").click();
    await expect(page.locator("#statusText")).toHaveText("Head motion corrected", { timeout: 1000000 });
    const outputs = {};
    for (const label of ["Corrected diffusion image", "bval", "bvec", "motion", "sidecar", "ITK transforms"]) {
      const downloadEvent = page.waitForEvent("download");
      await page.locator("#resultList .nd-volume-toggle").filter({ hasText: label }).getByRole("button", { name: "Download" }).click();
      const download = await downloadEvent;
      const bytes = new Uint8Array(await readFile(await download.path()));
      if (label === "ITK transforms") {
        for (const [name, transform] of Object.entries(unzipSync(bytes))) outputs[name] = { sha256: hash(transform) };
      } else if (label === "Corrected diffusion image") {
        const decoded = gunzipSync(bytes);
        const result = readNiftiFrames(decoded);
        expect(result.frames).toBe(137);
        expect(result.header.datatype).toBe(16);
        expect(result.data.every(Number.isFinite)).toBe(true);
        outputs[download.suggestedFilename()] = { decodedSha256: hash(decoded) };
      } else outputs[download.suggestedFilename()] = { sha256: hash(bytes) };
    }
    expect(Object.keys(outputs).filter(name => name.endsWith(".mat"))).toHaveLength(137);
    expect(failures).toEqual([]);
    const entry = { method, seed: 1234, inputs, outputs };
    if (process.env.HMC_BROWSER_REFERENCE === "write") {
      const reference = JSON.parse(await readFile(referencePath, "utf8").catch(() => '{"source":"production-browser","cases":[]}'));
      reference.cases = [...reference.cases.filter(item => item.method !== method), entry];
      await writeFile(referencePath, `${JSON.stringify(reference, null, 2)}\n`);
    } else {
      const reference = JSON.parse(await readFile(referencePath, "utf8"));
      expect(entry).toEqual(reference.cases.find(item => item.method === method));
    }
    await page.screenshot({ path: test.info().outputPath(`${method}-desktop.png`) });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: test.info().outputPath(`${method}-phone.png`) });
  });
}
