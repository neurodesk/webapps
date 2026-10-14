import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { fixedToMovingRas } from "../../../packages/elastix/validation/parameter-matrix.mjs";
import { affineDifference, displaceVolume, downsampledExamplePair, encodeNifti, ncc, readVolume, transformErrorMm } from "../../../test-utils/registration-similarity.mjs";

const examples = JSON.parse(await readFile(new URL("../examples.json", import.meta.url), "utf8"));

// The moving image is the example template turned 8 degrees and shifted by
// 9, -6 and 6 mm, so the right answer is known.
test("automation registers a known displacement, recovers it in the parameter files and reports artifact identities", async ({ page }) => {
  test.setTimeout(600_000);
  const { fixed } = await downsampledExamplePair(examples[0], 3);
  const { moving, fixedToMoving } = displaceVolume(fixed, { translationVoxels: [3, -2, 2], rotationDegreesZ: 8 });
  const inputs = { moving, fixed };
  await page.goto("/");
  await expect(page.locator("#movingInput")).toBeEnabled({ timeout: 120_000 });
  for (const role of ["moving", "fixed"]) {
    await page.locator("#neurodesk-input-transfer").setInputFiles({ name: `${role}.nii.gz`, mimeType: "application/gzip", buffer: gzipSync(encodeNifti(inputs[role])) });
    await page.evaluate((role) => globalThis.neurodeskAutomation.dispatch("adopt", { role }), role);
  }
  await page.evaluate((parameters) => globalThis.neurodeskAutomation.dispatch("start", { operation: "register", parameters }), { method: "rigid" });
  await expect.poll(async () => (await page.evaluate(() => globalThis.neurodeskAutomation.dispatch("snapshot"))).state, { timeout: 480_000 }).toBe("succeeded");
  const { report } = await page.evaluate(() => globalThis.neurodeskAutomation.dispatch("snapshot"));
  expect(report.inputs.moving[0].filename).toBe("moving.nii.gz");
  expect(report.inputs.fixed[0].filename).toBe("fixed.nii.gz");
  expect(report.provenance).toMatchObject({ algorithm: "elastix", stages: ["TranslationTransform", "EulerTransform"], numberOfResolutions: 3 });
  expect(Object.values(report.artifacts).map((artifact) => artifact.role).sort()).toEqual(["parameters", "parameters", "registered", "transform"]);
  const downloads = {};
  for (const [artifactId, artifact] of Object.entries(report.artifacts)) {
    const downloaded = page.waitForEvent("download");
    await page.evaluate((artifactId) => globalThis.neurodeskAutomation.dispatch("download", { artifactId }), artifactId);
    const download = await downloaded;
    const bytes = await readFile(await download.path());
    expect(artifact).toMatchObject({ filename: download.suggestedFilename(), bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    downloads[download.suggestedFilename()] = bytes;
  }
  const warped = await readVolume(downloads["moving_registered.nii.gz"]);
  const texts = ["moving_TransformParameters.0.toml", "moving_TransformParameters.1.toml"].map((name) => downloads[name].toString("utf8"));
  const before = ncc(moving.data, fixed.data);
  const after = ncc(warped.data, fixed.data);
  const errorMm = transformErrorMm(fixedToMovingRas(texts), fixedToMoving, fixed);
  test.info().annotations.push({ type: "alignment", description: `ncc before ${before.toFixed(3)}, after ${after.toFixed(3)}, transform error ${errorMm.toFixed(2)} mm` });
  expect(warped.dims).toEqual(fixed.dims);
  expect(affineDifference(warped.affine, fixed.affine)).toBeLessThan(1e-3);
  expect(before).toBeLessThan(0.9);
  expect(after).toBeGreaterThan(0.98);
  expect(errorMm).toBeLessThan(1);
  expect(downloads["moving_transform.h5"].subarray(0, 8).toString("latin1")).toBe("\x89HDF\r\n\x1a\n");
});
