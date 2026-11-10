// Record e2e/expected.json: the example's deconvolution as the browser test runs it, computed
// in Node on the same WebAssembly module. Rerun after a module rebuild or an example change.
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { readVolume } from "../src/input.js";
import { EXAMPLE_OPTICS } from "../src/config.js";
import { deconvolveInNode, sha256 } from "../e2e/reference.mjs";
import examples from "../examples.json" with { type: "json" };

const [example] = examples;
const [asset] = example.files;
const bytes = new Uint8Array(await (await fetch(asset.url)).arrayBuffer());
if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256) throw new Error("example checksum mismatch");
const volume = await readVolume(new File([bytes], asset.name));
const iterations = 10;
const { estimate, psfDims } = deconvolveInNode(volume, { optics: EXAMPLE_OPTICS[example.id], iterations });
let sum = 0;
let max = 0;
for (const v of estimate) {
  sum += v;
  max = Math.max(max, v);
}
const expected = {
  example: example.id,
  method: "rl",
  iterations,
  dims: volume.dims,
  spacingUm: volume.spacingUm,
  psfDims,
  sha256: sha256(estimate),
  mean: sum / estimate.length,
  max,
};
await writeFile(new URL("../e2e/expected.json", import.meta.url), `${JSON.stringify(expected, null, 2)}\n`);
console.log(expected);
