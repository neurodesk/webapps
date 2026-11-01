// The whole workflow on the pinned examples with the WebAssembly backend: every table must
// equal the original BIDS app's (garciaml/brainqcnetcpu, packages/brainqcnet/validation) byte
// for byte, except tot_df.csv's processing time, and the map must mark the flagged slices.
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { flaggedSliceMap, readVolume } from "@neurodesk/brainqcnet";
import { cropToForeground } from "@neurodesk/brainqcnet/slices";
import { exampleBytes, examples, reference, withoutTime } from "./fixtures.mjs";

async function downloadRow(page, name) {
  const event = page.waitForEvent("download");
  await page.locator("#resultList .nd-volume-toggle").filter({ hasText: name }).getByRole("button", { name: "Download" }).click({ timeout: 30000 });
  const download = await event;
  return { name: download.suggestedFilename(), bytes: await readFile(await download.path()) };
}

const CASES = [
  { example: examples[0], id: "sub-000103-standard", verdict: "No artifact detected · slices flagged 31 %", details: {} },
  { example: examples[1], id: "sub-000103-headmotion2", verdict: "Artifact detected · slices flagged 67 %", details: { tag: "@slow" } },
];

for (const { example, id, verdict, details } of CASES) {
  test(`example ${example.id} on WebAssembly writes the original BIDS app's tables and the flagged-slice map`, details, async ({ page }) => {
    test.setTimeout(45 * 60 * 1000);
    const original = await reference(id);
    const [file] = example.files;
    await page.goto("./");
    await page.getByRole("combobox", { name: "Input", exact: true }).selectOption(example.id);
    await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 180000 });
    await expect(page.locator("#fileInfo")).toContainText(file.name);
    await page.locator("#advancedSettings").evaluate((section) => { section.open = true; });
    await page.locator("#backend").selectOption("wasm");
    const started = Date.now();
    await page.locator("#runButton").click();
    await expect(page.locator("#cancelButton")).toBeVisible();
    await expect(page.locator("#statusText")).toHaveText(verdict, { timeout: 40 * 60 * 1000 });
    const minutes = (Date.now() - started) / 60000;
    const model = (await page.locator("#technicalLog").textContent()).match(/model ready in ([\d.]+) s/)?.[1];
    console.log(`${example.id}: ${minutes.toFixed(1)} min from Check quality to the verdict, ${model} s of it fetching the model`);
    await expect(page.locator("#cancelButton")).toBeHidden();
    await expect(page.locator("#technicalLog")).toContainText(`Classified ${original.slices.length} slices`);
    await expect(page.locator("#technicalLog")).toContainText("BrainQCNet on WebAssembly");
    const table = page.getByRole("table", { name: "Quality verdict" });
    await expect(table.locator("tr").first()).toHaveText(`Verdict${verdict.split(" · ")[0]}`);

    const stem = file.name.replace(/\.nii\.gz$/, "");
    const downloads = {};
    for (const name of ["table.csv", "tot_df.csv", "x_results_locally.csv", "y_results_locally.csv", "z_results_locally.csv"]) {
      const result = await downloadRow(page, `${name} · `);
      expect(result.name).toBe(`${stem}_${name}`);
      downloads[name] = result.bytes.toString("utf8");
    }
    for (const name of ["table.csv", "x_results_locally.csv", "y_results_locally.csv", "z_results_locally.csv"]) {
      expect(downloads[name], name).toBe(original.files[name]);
    }
    expect(withoutTime(downloads["tot_df.csv"]), "tot_df.csv without t").toBe(withoutTime(original.files["tot_df.csv"]));

    const map = await downloadRow(page, "Flagged-slice map");
    expect(map.name).toBe(`${stem}_flaggedslices.nii.gz`);
    const nifti = gunzipSync(map.bytes);
    expect(nifti.readInt16LE(70), "uint8 map").toBe(2);
    const volume = await readVolume(await exampleBytes(file));
    const cropped = cropToForeground(volume);
    const expected = flaggedSliceMap(volume.dims, { offset: cropped.offset, dims: cropped.dims }, original.slices);
    const voxels = nifti.subarray(nifti.readFloatLE(108));
    expect(Buffer.from(voxels).equals(Buffer.from(expected)), "the map marks the original's flagged slices").toBe(true);
  });
}
