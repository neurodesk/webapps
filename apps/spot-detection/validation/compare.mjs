// Compare the app's pipeline with Big-FISH's recorded results (reference.json) on
// the example: node validation/compare.mjs DIR, where DIR holds
// experiment_1_smfish_fov_1.tif and experiment_1_cell_label.tif.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { analyse } from "../src/pipeline.js";
import { logFilter, objectRadiusPixel } from "../src/bigfish.js";
import { readImageStack } from "../src/image-stack.js";

const directory = process.argv[2];
const reference = JSON.parse(readFileSync(new URL("./reference.json", import.meta.url), "utf8"));
const read = async (name) => {
  const bytes = readFileSync(join(directory, name));
  return readImageStack(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
};
const image = await read("experiment_1_smfish_fov_1.tif");
const labels = await read("experiment_1_cell_label.tif");
let failed = false;
for (const [name, projection] of [["example-3d", false], ["example-mip-2d", true]]) {
  const expected = reference.cases[name];
  const result = analyse(image, { voxelSize: [300, 103, 103], spotRadius: [350, 150, 150], projection, labels });
  const log = logFilter(result.image, objectRadiusPixel(expected.voxelSize, expected.spotRadius));
  const logSha = createHash("sha256").update(Buffer.from(log.data.buffer)).digest("hex");
  const sameSpots = JSON.stringify(result.spots) === JSON.stringify(expected.spots);
  const sameCells = JSON.stringify(result.cells.cells.map((c) => [c.id, c.spots, c.area])) === JSON.stringify(expected.cells) && result.cells.outside === expected.spotsOutsideCells;
  const distance = result.subpixel.map((s, i) => Math.max(...s.map((v, a) => Math.abs(v - expected.subpixel[i][a]))));
  const close = distance.filter((d) => d <= 1e-3);
  const ok = logSha === expected.logSha256 && result.threshold === expected.threshold && sameSpots && sameCells && close.length >= 0.97 * distance.length;
  failed ||= !ok;
  console.log(JSON.stringify({
    case: name,
    logImageIdentical: logSha === expected.logSha256,
    threshold: [result.threshold, expected.threshold],
    spots: [result.spots.length, expected.spots.length],
    identicalSpotSet: sameSpots,
    identicalCellCounts: sameCells,
    subpixelWithin1e3px: `${close.length}/${distance.length}`,
    subpixelMaxDifferenceThere: Math.max(...close),
  }));
}
process.exitCode = failed ? 1 : 0;
