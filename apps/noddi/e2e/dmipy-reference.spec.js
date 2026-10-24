import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { readNiftiFrames } from "@neurodesk/webapp-components/file-io/nifti";

const directory = process.env.NODDI_DMIPY_REFERENCE;
const stem = "sub-01_dir-AP_desc-slab";
const dispatch = (page, command, request = {}) => page.evaluate(({ command, request }) => globalThis.neurodeskAutomation.dispatch(command, request), { command, request });
const readVolume = async path => readNiftiFrames(gunzipSync(await readFile(path)));

test("dmipy browser downloads match the pinned full-slab white-matter reference", async ({ page }, info) => {
  if (!directory && process.env.CI) throw new Error("CI must provision NODDI_DMIPY_REFERENCE");
  test.skip(!directory, "set NODDI_DMIPY_REFERENCE with scripts/e2e-test-data.mjs noddi");
  test.setTimeout(10 * 60_000);
  const input = await readVolume(join(directory, "input", `${stem}_dwi.nii.gz`));
  const mask = await readVolume(join(directory, "wm-mask.nii.gz"));
  const selected = [];
  let whiteMatter = 0;
  for (let i = 0; i < mask.data.length; i++) {
    if (mask.data[i] <= 0) continue;
    whiteMatter++;
    if (input.data[i] > 0) selected.push(i);
  }
  expect(input.dims).toEqual([67, 92, 10]);
  expect(mask.dims).toEqual(input.dims);
  expect(whiteMatter).toBe(13332);
  expect(selected).toHaveLength(13324);
  await page.goto("/");
  for (const [role, path] of [
    ["image", join(directory, "input", `${stem}_dwi.nii.gz`)],
    ["bval", join(directory, "input", `${stem}_dwi.bval`)],
    ["bvec", join(directory, "input", `${stem}_dwi.bvec`)],
    ["mask", join(directory, "wm-mask.nii.gz")],
  ]) {
    await page.locator("#neurodesk-input-transfer").setInputFiles(path);
    await dispatch(page, "adopt", { role });
  }
  await dispatch(page, "start", { operation: "fit", parameters: { method: "dmipy", noddi: true, tensorFit: "wls" } });
  await expect.poll(async () => {
    const snapshot = await dispatch(page, "snapshot");
    if (snapshot.state === "failed") throw new Error(JSON.stringify(snapshot.error));
    return snapshot.state;
  }, { timeout: 9 * 60_000, intervals: [1000] }).toBe("succeeded");
  const { report } = await dispatch(page, "snapshot");
  expect(report.provenance.method).toBe("dti+noddi-dmipy");
  expect(report.provenance.noddiDiagnostics).toMatchObject({ fitted: 13324, skipped: 8, failed: 0 });
  const comparison = {};
  for (const metric of ["icvf", "isovf", "odi"]) {
    const pending = page.waitForEvent("download");
    await dispatch(page, "download", { artifactId: `noddi-${metric}` });
    const actual = await readVolume(await (await pending).path());
    const reference = await readVolume(join(directory, `${stem}_model-noddi_param-${metric}_dwimap.nii.gz`));
    expect(actual.dims).toEqual([67, 92, 10]);
    expect(actual.frames).toBe(1);
    expect(actual.header.affine).toEqual(input.header.affine);
    expect(Array.from(actual.data).every(Number.isFinite)).toBe(true);
    const differences = selected.map(i => Math.abs(actual.data[i] - reference.data[i])).sort((a, b) => a - b);
    const median = (differences[differences.length / 2 - 1] + differences[differences.length / 2]) / 2;
    expect(median, `${metric} median absolute difference`).toBeLessThan(0.02);
    comparison[metric] = { median, max: differences.at(-1) };
  }
  await info.attach("dmipy-wm-comparison", { body: JSON.stringify({ comparison, diagnostics: report.provenance.noddiDiagnostics }, null, 2), contentType: "application/json" });
});
