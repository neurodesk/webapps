import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { affineDifference, displaceVolume, downsampledExamplePair, encodeNifti, ncc, readVolume } from "../../../test-utils/registration-similarity.mjs";

const examples = JSON.parse(await readFile(new URL("../examples.json", import.meta.url), "utf8"));

// The moving image is the example template turned 8 degrees and shifted by
// 9, -6 and 6 mm, so a correct registration reproduces the template. Measured
// at 3 mm: NCC 0.832 before and 0.998 after. FireANTs publishes no transform
// artifact, so the resliced image is the only evidence.
test("automation registers a known displacement and reports input and artifact identities", async ({ page }) => {
  test.setTimeout(900_000);
  const { fixed } = await downsampledExamplePair(examples[0], 3);
  const { moving } = displaceVolume(fixed, { translationVoxels: [3, -2, 2], rotationDegreesZ: 8 });
  const inputs = { moving, fixed };
  await page.goto("/");
  await expect(page.locator("#movingInput")).toBeEnabled({ timeout: 120_000 });
  for (const role of ["moving", "fixed"]) {
    await page.locator("#neurodesk-input-transfer").setInputFiles({ name: `${role}.nii.gz`, mimeType: "application/gzip", buffer: gzipSync(encodeNifti(inputs[role])) });
    await page.evaluate((role) => globalThis.neurodeskAutomation.dispatch("adopt", { role }), role);
  }
  await page.evaluate((parameters) => globalThis.neurodeskAutomation.dispatch("start", { operation: "register", parameters }), { backend: "cpu", transform: "greedy" });
  await expect.poll(async () => (await page.evaluate(() => globalThis.neurodeskAutomation.dispatch("snapshot"))).state, { timeout: 780_000 }).toBe("succeeded");
  const { report } = await page.evaluate(() => globalThis.neurodeskAutomation.dispatch("snapshot"));
  expect(report.inputs.moving[0].filename).toBe("moving.nii.gz");
  expect(report.inputs.fixed[0].filename).toBe("fixed.nii.gz");
  expect(Object.values(report.artifacts).map((artifact) => artifact.role)).toEqual(["registered"]);
  const [artifactId, artifact] = Object.entries(report.artifacts)[0];
  const downloaded = page.waitForEvent("download");
  await page.evaluate((artifactId) => globalThis.neurodeskAutomation.dispatch("download", { artifactId }), artifactId);
  const download = await downloaded;
  const bytes = await readFile(await download.path());
  expect(artifact).toMatchObject({ filename: download.suggestedFilename(), bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  const warped = await readVolume(bytes);
  const before = ncc(moving.data, fixed.data);
  const after = ncc(warped.data, fixed.data);
  test.info().annotations.push({ type: "ncc", description: `before ${before.toFixed(3)}, after ${after.toFixed(3)}` });
  expect(warped.dims).toEqual(fixed.dims);
  expect(affineDifference(warped.affine, fixed.affine)).toBeLessThan(1e-3);
  expect(before).toBeLessThan(0.9);
  expect(after).toBeGreaterThan(0.98);
});
