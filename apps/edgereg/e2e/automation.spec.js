import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { affineDifference, displaceVolume, downsampledExamplePair, encodeNifti, ncc, readVolume } from "../../../test-utils/registration-similarity.mjs";

const examples = JSON.parse(await readFile(new URL("../examples.json", import.meta.url), "utf8"));
const fixture = await readFile(new URL("../../../exes/synthseg/test/fixtures/small.nii.gz", import.meta.url));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function adopt(page, role, name, buffer = fixture) {
  await page.locator("#neurodesk-input-transfer").setInputFiles({ name, mimeType: "application/gzip", buffer });
  await page.evaluate((role) => globalThis.neurodeskAutomation.dispatch("adopt", { role }), role);
}

// The moving image is the example template turned 8 degrees and shifted by
// 9, -6 and 6 mm, so a correct registration reproduces the template. Measured
// at 3 mm: NCC 0.723 before and 0.957 after. EdgeReg publishes no transform
// artifact, so the resliced image is the only evidence.
test("automation registers a known displacement on explicit input roles and exports the aligned output", async ({ page }) => {
  test.setTimeout(300_000);
  const { fixed } = await downsampledExamplePair(examples[0], 3);
  const { moving } = displaceVolume(fixed, { translationVoxels: [3, -2, 2], rotationDegreesZ: 8 });
  const movingBytes = gzipSync(encodeNifti(moving));
  const fixedBytes = gzipSync(encodeNifti(fixed));
  await page.goto("/");
  await expect(page.locator("#movingInput")).toBeEnabled({ timeout: 120_000 });
  await adopt(page, "moving", "subject.nii.gz", movingBytes);
  await adopt(page, "fixed", "reference.nii.gz", fixedBytes);
  const run = await page.evaluate(() => globalThis.neurodeskAutomation.dispatch("start", {
    operation: "register", parameters: { robustFov: false },
  }));
  await expect.poll(async () => (await page.evaluate(() => globalThis.neurodeskAutomation.dispatch("snapshot"))).state, { timeout: 240_000 }).toBe("succeeded");
  const snapshot = await page.evaluate(() => globalThis.neurodeskAutomation.dispatch("snapshot"));
  expect(snapshot.runId).toBe(run.runId);
  expect(snapshot.report.inputs.moving[0]).toMatchObject({ filename: "subject.nii.gz", sha256: sha256(movingBytes) });
  expect(snapshot.report.inputs.fixed[0]).toMatchObject({ filename: "reference.nii.gz", sha256: sha256(fixedBytes) });
  expect(snapshot.report.provenance.algorithm).toBe("niimath allineate");
  const [id, artifact] = Object.entries(snapshot.report.artifacts).find(([, value]) => value.role === "registered");
  const downloaded = page.waitForEvent("download");
  await page.evaluate((artifactId) => globalThis.neurodeskAutomation.dispatch("download", { artifactId }), id);
  const download = await downloaded;
  const image = await readFile(await download.path());
  expect(download.suggestedFilename()).toBe("subject_registered.nii");
  expect(artifact).toMatchObject({ space: "fixed", bytes: image.length, sha256: sha256(image) });
  await expect(page.locator("#movingInfo")).toHaveText("subject.nii.gz");
  await expect(page.locator("#stationaryInfo")).toHaveText("reference.nii.gz");
  const warped = await readVolume(image);
  const before = ncc(moving.data, fixed.data);
  const after = ncc(warped.data, fixed.data);
  test.info().annotations.push({ type: "ncc", description: `before ${before.toFixed(3)}, after ${after.toFixed(3)}` });
  expect(warped.dims).toEqual(fixed.dims);
  expect(affineDifference(warped.affine, fixed.affine)).toBeLessThan(1e-3);
  expect(before).toBeLessThan(0.9);
  expect(after).toBeGreaterThan(0.9);
});

test("an invalid input fails before registration without publishing artifacts", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#movingInput")).toBeEnabled();
  await adopt(page, "moving", "broken.nii", Buffer.from("not a NIfTI"));
  await adopt(page, "fixed", "reference.nii.gz");
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch("start", { operation: "register" }));
  await expect.poll(async () => (await page.evaluate(() => globalThis.neurodeskAutomation.dispatch("snapshot"))).state).toBe("failed");
  const snapshot = await page.evaluate(() => globalThis.neurodeskAutomation.dispatch("snapshot"));
  expect(snapshot.error.message).toBeTruthy();
  expect(snapshot.report).toBeUndefined();
  await expect(page.locator("#resultList").getByRole("button", { name: "Download" })).toHaveCount(0);
});
