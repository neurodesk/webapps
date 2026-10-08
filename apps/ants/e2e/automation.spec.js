import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { affineDifference, displaceVolume, downsampledExamplePair, encodeNifti, ncc, readVolume, transformErrorMm } from "../../../test-utils/registration-similarity.mjs";

const examples = JSON.parse(await readFile(new URL("../examples.json", import.meta.url), "utf8"));

// ITK writes 0GenericAffine.mat as MATLAB level-4 variables: twelve affine
// parameters (row-major 3x3, then translation) and the fixed centre, in LPS.
// Returns the same fixed-to-moving map as a RAS world matrix.
function readItkAffine(bytes) {
  const variables = [];
  let offset = 0;
  while (offset < bytes.length) {
    const type = bytes.readInt32LE(offset);
    const count = bytes.readInt32LE(offset + 4) * bytes.readInt32LE(offset + 8);
    const nameLength = bytes.readInt32LE(offset + 16);
    offset += 20 + nameLength;
    const width = type === 10 ? 4 : 8;
    variables.push(Array.from({ length: count }, (_, index) => (type === 10 ? bytes.readFloatLE(offset + index * width) : bytes.readDoubleLE(offset + index * width))));
    offset += count * width;
  }
  const [parameters, centre] = variables;
  const lpsToRas = [-1, -1, 1];
  const rows = [0, 1, 2].map((row) => {
    const linear = parameters.slice(row * 3, row * 3 + 3);
    const offsetMm = parameters[9 + row] + centre[row] - (linear[0] * centre[0] + linear[1] * centre[1] + linear[2] * centre[2]);
    return [...linear.map((value, column) => value * lpsToRas[row] * lpsToRas[column]), offsetMm * lpsToRas[row]];
  });
  return [...rows, [0, 0, 0, 1]];
}

// The moving image is the example template turned 8 degrees and shifted by
// 9, -6 and 6 mm, so the right answer is known. Measured at 3 mm: NCC 0.832
// before and 0.997 after, and the affine artifact within 0.28 mm of the truth
// (an identity transform is 21.33 mm off).
test("automation registers a known displacement, recovers it in the affine artifact and reports artifact identities", async ({ page }) => {
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
  await page.evaluate((parameters) => globalThis.neurodeskAutomation.dispatch("start", { operation: "register", parameters }), {});
  await expect.poll(async () => (await page.evaluate(() => globalThis.neurodeskAutomation.dispatch("snapshot"))).state, { timeout: 480_000 }).toBe("succeeded");
  const { report } = await page.evaluate(() => globalThis.neurodeskAutomation.dispatch("snapshot"));
  expect(report.inputs.moving[0].filename).toBe("moving.nii.gz");
  expect(report.inputs.fixed[0].filename).toBe("fixed.nii.gz");
  expect(Object.values(report.artifacts).map((artifact) => artifact.role).sort()).toEqual(["registered", "affine", "warp", "inverse-warp"].sort());
  const downloads = {};
  for (const [artifactId, artifact] of Object.entries(report.artifacts)) {
    const downloaded = page.waitForEvent("download");
    await page.evaluate((artifactId) => globalThis.neurodeskAutomation.dispatch("download", { artifactId }), artifactId);
    const download = await downloaded;
    const bytes = await readFile(await download.path());
    expect(artifact).toMatchObject({ filename: download.suggestedFilename(), bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    downloads[artifact.role] = bytes;
  }
  const warped = await readVolume(downloads.registered);
  const before = ncc(moving.data, fixed.data);
  const after = ncc(warped.data, fixed.data);
  const errorMm = transformErrorMm(readItkAffine(downloads.affine), fixedToMoving, fixed);
  test.info().annotations.push({ type: "alignment", description: `ncc before ${before.toFixed(3)}, after ${after.toFixed(3)}, affine error ${errorMm.toFixed(2)} mm` });
  expect(warped.dims).toEqual(fixed.dims);
  expect(affineDifference(warped.affine, fixed.affine)).toBeLessThan(1e-3);
  expect(before).toBeLessThan(0.9);
  expect(after).toBeGreaterThan(0.98);
  expect(errorMm).toBeLessThan(1);
});
