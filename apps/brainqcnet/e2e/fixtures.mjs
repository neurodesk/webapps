// Test inputs and references for the browser tests: the pinned examples, the original BIDS
// app's outputs on them, and a small 4D series the app must refuse.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { syntheticNifti } from "../../../test-utils/nifti-fixture.mjs";

export const examples = JSON.parse(await readFile(new URL("../examples.json", import.meta.url), "utf8"));
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** The original container's outputs (validation/run_reference.sh) for an example. */
export async function reference(id) {
  return JSON.parse(await readFile(new URL(`../../../packages/brainqcnet/validation/references/${id}.json`, import.meta.url), "utf8"));
}

/** An example file, downloaded and checked against its pinned SHA-256. */
export async function exampleBytes(file) {
  const response = await fetch(file.url);
  if (!response.ok) throw new Error(`${file.name}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256(bytes) !== file.sha256) throw new Error(`${file.name}: SHA-256 does not match examples.json`);
  return bytes;
}

/** tot_df.csv with its `t` column, the processing time, blanked: the one field allowed to differ. */
export function withoutTime(totDf) {
  const [header, row, ...rest] = totDf.split("\n");
  if (!header.startsWith("subid,proba,t,")) throw new Error(`Unexpected tot_df.csv header: ${header}`);
  return [header, row.replace(/^([^,]*,[^,]*,)[^,]*,/, "$1,"), ...rest].join("\n");
}

/** A gzipped 4D series: three volumes of a small grid. */
export function series4d() {
  const volume = syntheticNifti({ dims: [8, 8, 8], spacing: [2, 2, 2], gzip: false, value: (i) => i % 17 });
  const header = Buffer.from(volume.subarray(0, 352));
  header.writeInt16LE(4, 40);
  header.writeInt16LE(3, 48);
  const data = volume.subarray(352);
  return gzipSync(Buffer.concat([header, data, data, data]));
}
