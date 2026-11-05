// Convert the example with every version and method and check each against
// example-reference.json (bioformats2raw 0.14.0 and numpy):
//   node validation/check-example.mjs [path/to/retina-crop.ome.tif]
// Without a path it downloads the pinned example and checks its sha256.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { unzipSync } from "fflate";
import examples from "../../../apps/omezarr-convert/examples.json" with { type: "json" };
import { openSource, writeOmeZarr, zipStore } from "../src/index.js";
import { archiveStore, checkExample } from "./checks.mjs";

const EXAMPLE_SHA256 = "a76758337ac07c0ffd2fa9f423409a31e576eb820e91c8b0830b221b6bdb8225";
const { url, name } = examples[0].files[0];
const bytes = process.argv[2] ? await readFile(process.argv[2]) : new Uint8Array(await (await fetch(url)).arrayBuffer());
if (createHash("sha256").update(bytes).digest("hex") !== EXAMPLE_SHA256) throw new Error("The example's sha256 differs from the pinned file.");
let failed = false;
for (const version of ["0.4", "0.5"]) {
  for (const method of ["nearest", "mean"]) {
    const source = await openSource([new File([bytes], name)]);
    const map = new Map();
    const started = performance.now();
    await writeOmeZarr(source, { set: (key, value) => map.set(key, value) }, { version, method });
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    // Check what a user downloads: the archive, unpacked again.
    const problems = await checkExample(archiveStore(unzipSync(zipStore(map, version))), version, method);
    failed ||= problems.length > 0;
    console.log(`NGFF ${version} ${method}: ${problems.length ? problems.join("; ") : "matches the reference"} (${seconds} s)`);
  }
}
process.exitCode = failed ? 1 : 0;
