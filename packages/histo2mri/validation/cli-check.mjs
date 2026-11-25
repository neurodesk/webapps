#!/usr/bin/env node
// Portable release validation for @neurodesk/histo2mri.
// Prefetches the pinned AHEAD 7 T R1 MRI and coronal thionin section into tmpdir()
// BEFORE running any CLI invocation, runs offline under `unshare -rn`, and independently
// verifies Greedy registration outputs, NMI gain, and affine/warp/volume NIfTI validity.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";
import { parseStrictNiftiHeader } from "../src/nifti-io.js";

const { values } = parseArgs({ options: { executable: { type: "string" } } });
const command = values.executable
  ? [resolve(values.executable)]
  : [process.execPath, fileURLToPath(new URL("../bin/histo2mri.js", import.meta.url))];

const examples = JSON.parse(await readFile(new URL("../../../apps/histo2mri/examples.json", import.meta.url), "utf8"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const failures = [];
function check(passed, message) {
  if (!passed) failures.push(message);
  console.log(`${passed ? "PASS" : "FAIL"} ${message}`);
}

function canUnshareNet() {
  if (process.platform !== "linux") return false;
  return spawnSync("unshare", ["-rn", "true"], { stdio: "ignore" }).status === 0;
}

const useUnshare = canUnshareNet();

function runCli(args) {
  const fullCmd = useUnshare ? ["unshare", "-rn", ...command, ...args] : [...command, ...args];
  const run = spawnSync(fullCmd[0], fullCmd.slice(1), {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  if (run.error) throw run.error;
  return run;
}

async function prefetchRole(role, workDir) {
  const file = examples[0].files.find((entry) => entry.role === role);
  const response = await fetch(file.url);
  if (!response.ok) throw new Error(`Failed to fetch ${file.url}: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== file.bytes || sha256(bytes) !== file.sha256) {
    throw new Error(`${file.name}: integrity check failed`);
  }
  const target = join(workDir, file.name);
  await writeFile(target, bytes);
  return target;
}

const work = await mkdtemp(join(tmpdir(), "histo2mri-cli-check-"));
try {
  // Prefetch pinned MRI + thionin section into tmpdir() before invoking CLI
  const mriPath = await prefetchRole("mri", work);
  const sectionPath = await prefetchRole("section", work);

  // 1. self-check
  const selfCheck = runCli(["self-check"]);
  check(selfCheck.status === 0, `self-check exits 0 (status ${selfCheck.status})`);
  const selfInfo = JSON.parse(selfCheck.stdout.trim());
  check(selfInfo.ok === true && selfInfo.greedy === "wasm-single", `self-check Greedy WASM verified (${selfInfo.version})`);

  // 2. Register AHEAD 152017 thionin section 150 to 7 T R1 map at coronal slice 50 offline
  const outDir = join(work, "out");
  const run = runCli([mriPath, sectionPath, outDir, "--axis", "2", "--slice", "50", "--offline"]);
  check(run.status === 0, `ahead-152017-section150 exits 0${run.status ? ` (${run.stderr.trim()})` : ""}`);

  const base = "ahead152017_thionin_section150_85um";
  const report = JSON.parse(await readFile(join(outDir, `${base}_registration.json`), "utf8"));
  check(report.app === "histo2mri", `registration.json identifies histo2mri (${report.version})`);
  check(report.nmi.final > report.nmi.initial + 0.05,
    `registration improves NMI ${report.nmi.initial.toFixed(4)} → ${report.nmi.final.toFixed(4)}`);

  const affineText = await readFile(join(outDir, `${base}_affine.mat`), "utf8");
  const rows = affineText.trim().split(/\r?\n/);
  check(rows.length === 4 && rows[3].trim().startsWith("0 0 0 1"), `affine.mat is a valid 4×4 transform`);

  const warpedHdr = parseStrictNiftiHeader(gunzipSync(await readFile(join(outDir, `${base}_warped_rgba.nii.gz`))));
  check(warpedHdr.datatype === 2304 && warpedHdr.dims[1] > 100 && warpedHdr.dims[2] > 100,
    `warped RGBA NIfTI is valid (${warpedHdr.dims.slice(1, 4).join("×")}, datatype 2304)`);

  const volHdr = parseStrictNiftiHeader(gunzipSync(await readFile(join(outDir, "sections_in_mri.nii.gz"))));
  check(volHdr.datatype === 2304 && volHdr.dims[3] > 50,
    `sections_in_mri.nii.gz matches 3D MRI grid (${volHdr.dims.slice(1, 4).join("×")})`);
} finally {
  await rm(work, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log(`\nAll @neurodesk/histo2mri portable CLI checks passed${useUnshare ? " (network-isolated via unshare -rn)" : ""}.`);
