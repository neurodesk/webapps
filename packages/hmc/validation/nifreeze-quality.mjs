// The shell-mean correlation from the pinned scripts/qc_registration.py:
// Pearson r inside the run's brain mask, against the mean of raw same-shell volumes.
//   node packages/hmc/validation/nifreeze-quality.mjs ROOT OUT trivial|gp
// This reports image agreement only; it is not a substitute for Q53.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeNiftiBuffer, readNiftiFrames } from "@neurodesk/webapp-components/file-io/nifti";
import { readSeries } from "../src/pipeline.js";
import { outputNames } from "../src/outputs.js";

const [root, out, model] = process.argv.slice(2);
if (!root || !out || !["trivial", "gp"].includes(model)) throw new Error("Usage: nifreeze-quality.mjs ROOT OUT trivial|gp");
const raw = await readSeries(await readFile(join(root, "input/sub-107_dir-AP_dwi.nii.gz")));
const names = outputNames("sub-107_dir-AP_dwi.nii.gz");
const corrected = await readSeries(await readFile(join(out, names.image)));
const bvals = (await readFile(join(root, "input/sub-107_dir-AP_dwi.bval"), "utf8")).trim().split(/\s+/).map(Number);
const maskPath = model === "gp" ? "nifreeze-gp/work/brainmask.nii.gz" : "mask/sub-107_dir-AP_desc-mindgrab_mask.nii.gz";
const mask = readNiftiFrames(await decodeNiftiBuffer(await readFile(join(root, maskPath)))).data;
const indices = [];
for (let i = 0; i < mask.length; i++) if (mask[i] > 0) indices.push(i);
const voxels = mask.length;
const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
function correlation(data, frame, mean) {
  let sx = 0, sy = 0;
  const offset = frame * voxels;
  for (let i = 0; i < indices.length; i++) { sx += data[offset + indices[i]]; sy += mean[i]; }
  sx /= indices.length;
  sy /= indices.length;
  let xy = 0, xx = 0, yy = 0;
  for (let i = 0; i < indices.length; i++) {
    const x = data[offset + indices[i]] - sx;
    const y = mean[i] - sy;
    xy += x * y;
    xx += x * x;
    yy += y * y;
  }
  return xy / Math.sqrt(xx * yy);
}
const byShell = {};
for (const shell of [...new Set(bvals.filter(b => b > 50))].sort((a, b) => a - b)) {
  const frames = bvals.flatMap((b, frame) => b === shell ? [frame] : []);
  const mean = new Float64Array(indices.length);
  for (const frame of frames) for (let i = 0; i < indices.length; i++) mean[i] += raw.data[frame * voxels + indices[i]];
  for (let i = 0; i < mean.length; i++) mean[i] /= frames.length;
  const rows = frames.map(frame => ({ frame, before: correlation(raw.data, frame, mean), after: correlation(corrected.data, frame, mean) }));
  byShell[shell] = { volumes: rows.length, beforeMedian: median(rows.map(row => row.before)), afterMedian: median(rows.map(row => row.after)), dropsOver002: rows.filter(row => row.after < row.before - 0.02).length, rows };
}
const report = JSON.parse(await readFile(join(out, "estimator-report.json"), "utf8"));
report.shellMeanCorrelations = { definition: "Pearson r in the run's brain mask against the mean of raw same-shell volumes, pinned scripts/qc_registration.py", maskVoxels: indices.length, byShell };
await writeFile(join(out, "estimator-report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ model, maskVoxels: indices.length, byShell: Object.fromEntries(Object.entries(byShell).map(([shell, row]) => [shell, { ...row, rows: undefined }])) }));
