// The classifier's input on the pinned examples, without a browser: every
// 224 x 224 slice must equal the image the original container fed its model
// (packages/brainqcnet/validation/references). The workflow tests compare
// predictions and tables, which a small preprocessing drift could leave unchanged.
import { test, expect } from "@playwright/test";
import { readVolume } from "@neurodesk/brainqcnet";
import { cropToForeground, modelSlice } from "@neurodesk/brainqcnet/slices";
import { exampleBytes, examples, reference, sha256 } from "./fixtures.mjs";

const IDS = { "mr-art-standard": "sub-000103-standard", "mr-art-headmotion": "sub-000103-headmotion2" };

for (const example of examples) {
  test(`example ${example.id}: every slice image equals the original's`, async () => {
    test.setTimeout(5 * 60 * 1000);
    const original = await reference(IDS[example.id]);
    const volume = cropToForeground(await readVolume(await exampleBytes(example.files[0])));
    const differing = original.slices
      .filter((s) => sha256(modelSlice(volume, s.axis, s.slice)) !== s.resized_sha256)
      .map((s) => `${s.axis}${s.slice}`);
    expect(differing).toEqual([]);
    expect(original.slices.length).toBeGreaterThan(600);
  });
}
