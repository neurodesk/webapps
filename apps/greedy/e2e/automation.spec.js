import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { affineDifference, displaceVolume, downsampledExamplePair, encodeNifti, ncc, readVolume, resampleToGrid, transformErrorMm } from "../../../test-utils/registration-similarity.mjs";

const examples = JSON.parse(await readFile(new URL("../examples.json", import.meta.url), "utf8"));

// Greedy writes its affine as four text rows mapping fixed to moving millimetres (RAS).
function readGreedyAffine(bytes) {
  return bytes.toString("utf8").trim().split("\n").map((line) => line.trim().split(/\s+/).map(Number));
}

// Runs affine registration through the automation contract, checks that every
// artifact's reported name, size and hash match the downloaded bytes, and
// returns the downloads by role.
async function registerThroughAutomation(page, inputs) {
  await page.goto("/");
  await expect(page.locator("#movingInput")).toBeEnabled({ timeout: 120_000 });
  for (const role of ["moving", "fixed"]) {
    await page.locator("#neurodesk-input-transfer").setInputFiles({ name: `${role}.nii.gz`, mimeType: "application/gzip", buffer: gzipSync(encodeNifti(inputs[role])) });
    await page.evaluate((role) => globalThis.neurodeskAutomation.dispatch("adopt", { role }), role);
  }
  await page.evaluate((parameters) => globalThis.neurodeskAutomation.dispatch("start", { operation: "register", parameters }), { method: "affine" });
  await expect.poll(async () => (await page.evaluate(() => globalThis.neurodeskAutomation.dispatch("snapshot"))).state, { timeout: 240_000 }).toBe("succeeded");
  const { report } = await page.evaluate(() => globalThis.neurodeskAutomation.dispatch("snapshot"));
  expect(report.inputs.moving[0].filename).toBe("moving.nii.gz");
  expect(report.inputs.fixed[0].filename).toBe("fixed.nii.gz");
  expect(Object.values(report.artifacts).map((artifact) => artifact.role).sort()).toEqual(["registered", "affine"].sort());
  const downloads = {};
  for (const [artifactId, artifact] of Object.entries(report.artifacts)) {
    const downloaded = page.waitForEvent("download");
    await page.evaluate((artifactId) => globalThis.neurodeskAutomation.dispatch("download", { artifactId }), artifactId);
    const download = await downloaded;
    const bytes = await readFile(await download.path());
    expect(bytes.length).toBeGreaterThan(0);
    expect(artifact).toMatchObject({ filename: download.suggestedFilename(), bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    downloads[artifact.role] = bytes;
  }
  return downloads;
}

// Measured on the example pair at 3 mm: NCC 0.597 before, 0.948 after.
test("automation registers the example pair onto the fixed grid and reports input and artifact identities", async ({ page }) => {
  test.setTimeout(600_000);
  const { moving, fixed } = await downsampledExamplePair(examples[0], 3);
  const downloads = await registerThroughAutomation(page, { moving, fixed });
  const warped = await readVolume(downloads.registered);
  const before = ncc(resampleToGrid(moving, fixed).data, fixed.data);
  const after = ncc(warped.data, fixed.data);
  test.info().annotations.push({ type: "ncc", description: `before ${before.toFixed(3)}, after ${after.toFixed(3)}` });
  expect(warped.dims).toEqual(fixed.dims);
  expect(affineDifference(warped.affine, fixed.affine)).toBeLessThan(1e-3);
  expect(before).toBeLessThan(0.7);
  expect(after).toBeGreaterThan(0.9);
});

// The moving image is the example template turned 8 degrees and shifted by
// 9, -6 and 6 mm, so the right answer is known. ANTs recovers this displacement
// to 0.28 mm with NCC 0.997 (apps/ants/e2e/automation.spec.js).
test("automation recovers a known rigid displacement in the affine artifact", async ({ page }) => {
  test.setTimeout(600_000);
  const { fixed } = await downsampledExamplePair(examples[0], 3);
  const { moving, fixedToMoving } = displaceVolume(fixed, { translationVoxels: [3, -2, 2], rotationDegreesZ: 8 });
  const downloads = await registerThroughAutomation(page, { moving, fixed });
  const warped = await readVolume(downloads.registered);
  const before = ncc(moving.data, fixed.data);
  const after = ncc(warped.data, fixed.data);
  const errorMm = transformErrorMm(readGreedyAffine(downloads.affine), fixedToMoving, fixed);
  test.info().annotations.push({ type: "alignment", description: `ncc before ${before.toFixed(3)}, after ${after.toFixed(3)}, affine error ${errorMm.toFixed(2)} mm` });
  expect(before).toBeLessThan(0.9);
  expect(after).toBeGreaterThan(0.98);
  expect(errorMm).toBeLessThan(3);
});
