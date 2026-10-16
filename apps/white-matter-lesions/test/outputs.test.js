import { test } from "node:test";
import assert from "node:assert/strict";
import { applyMaskEdit, lesionStatistics, segmentationOutputs } from "../src/outputs.js";

const pipeline = () => segmentationOutputs("flair.nii.gz", {
  mask: new Uint8Array([1]),
  probability: new Uint8Array([2]),
  tsv: "lesion\tvoxels\n1\t3\n2\t1\n",
  summary: { count: 2, totalMl: 0.032 },
  lesions: [{ ml: 0.024, world: [1, 2, 3] }, { ml: 0.008, world: [4, 5, 6] }],
});
const affine = [[2, 0, 0, -4], [0, 2, 0, -4], [0, 0, 2, -4], [0, 0, 0, 1]];

test("only the lesion mask is editable", () => {
  const outputs = pipeline();
  assert.equal(outputs.mask.editable, true);
  assert.equal(outputs.mask.description, "Lesion mask · 2 lesions · 0.03 ml");
  assert.equal(outputs.probability.editable, undefined);
  assert.equal(outputs.table.editable, undefined);
});

test("an applied edit replaces the mask and recomputes its summary and table", async () => {
  const outputs = pipeline();
  const data = new Float32Array(64);
  data[0] = 1;
  data[1] = 1;
  const edited = new File([new Uint8Array([3])], "flair_lesions.nii");
  const next = applyMaskEdit(outputs, edited, outputs.mask.file, { data, dims: [4, 4, 4], affine });
  assert.equal(next.mask.file, edited);
  assert.equal(next.mask.original, outputs.mask.file);
  assert.equal(next.mask.edited, true);
  assert.deepEqual(next.mask.lesions, [{ ml: 0.016, world: [-3, -4, -4] }]);
  assert.equal(next.mask.description, "Lesion mask · 1 lesion · 0.02 ml");
  assert.equal(next.table.edited, true);
  assert.equal(next.table.file.name, "flair_lesions.tsv");
  assert.equal(next.table.file.type, "text/tab-separated-values");
  assert.equal(await next.table.file.text(), "lesion\tvoxels\tvolume_ml\tx_mm\ty_mm\tz_mm\n1\t2\t0.0160\t-3.0\t-4.0\t-4.0\n");
  assert.equal(next.table.original, outputs.table.file);
  assert.equal(next.probability, outputs.probability);
  const again = applyMaskEdit(next, new File([], "flair_lesions.nii"), edited, { data: new Float32Array(64), dims: [4, 4, 4], affine });
  assert.equal(again.mask.original, outputs.mask.file);
  assert.equal(again.table.original, outputs.table.file);
  assert.equal(again.mask.description, "Lesion mask · 0 lesions · 0.00 ml");
});

test("a segmentation keeps its ranked lesions with the mask", () => {
  assert.deepEqual(pipeline().mask.lesions, [{ ml: 0.024, world: [1, 2, 3] }, { ml: 0.008, world: [4, 5, 6] }]);
});

test("lesion statistics give the count, total and the spread of single volumes", () => {
  const lesions = [6.1234, 0.0021, 0.05, 0.3].map((ml) => ({ ml, world: [0, 0, 0] }));
  assert.deepEqual(lesionStatistics(lesions), [
    ["Lesions", "4"],
    ["Total volume", "6.48 ml"],
    ["Largest", "6.123 ml"],
    ["Median", "0.175 ml"],
    ["Smallest", "0.002 ml"],
  ]);
  assert.deepEqual(lesionStatistics(lesions.slice(0, 3))[3], ["Median", "0.050 ml"]);
  assert.deepEqual(lesionStatistics([]), [["Lesions", "0"]]);
});
