#!/usr/bin/env node
// Portable release validation for @neurodesk/lightsheet-atlas.
// Prefetches pinned examples from apps/lightsheet-atlas/examples.json into tmpdir()
// BEFORE running any CLI invocation (never touches isolated $HOME), then runs the CLI
// offline (under `unshare -rn` on Linux when available) and independently verifies
// cellfinder candidate detection AND Allen CCFv3 brain registration outputs.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";
import { parseNiftiHeader } from "@neurodesk/webapp-components/file-io/nifti";
import { defaultCacheDir, downloadModels } from "../src/models.js";

const { values } = parseArgs({ options: { executable: { type: "string" } } });
const command = values.executable
  ? [resolve(values.executable)]
  : [process.execPath, fileURLToPath(new URL("../bin/lightsheet-atlas.js", import.meta.url))];

const examples = JSON.parse(await readFile(new URL("../../../apps/lightsheet-atlas/examples.json", import.meta.url), "utf8"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const failures = [];
function check(passed, message) {
  if (!passed) failures.push(message);
  console.log(`${passed ? "PASS" : "FAIL"} ${message}`);
}

function canUnshareNet() {
  if (process.platform !== "linux") return false;
  const probe = spawnSync("unshare", ["-rn", "true"], { stdio: "ignore" });
  return probe.status === 0;
}

const useUnshare = canUnshareNet();

function runCli(args, { extraEnv = {} } = {}) {
  const fullCmd = useUnshare ? ["unshare", "-rn", ...command, ...args] : [...command, ...args];
  const run = spawnSync(fullCmd[0], fullCmd.slice(1), {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
  });
  if (run.error) throw run.error;
  return run;
}

async function prefetchExample(id, workDir) {
  const example = examples.find((entry) => entry.id === id);
  if (!example) throw new Error(`Missing example ${id}`);
  const file = example.files[0];
  const target = join(workDir, file.name);
  const response = await fetch(file.url);
  if (!response.ok) throw new Error(`Failed to fetch ${file.url}: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== file.bytes) {
    throw new Error(`${file.name}: expected ${file.bytes} bytes, got ${bytes.byteLength}`);
  }
  const digest = sha256(bytes);
  if (digest !== file.sha256) {
    throw new Error(`${file.name}: sha256 mismatch (expected ${file.sha256}, got ${digest})`);
  }
  await writeFile(target, bytes);
  return target;
}

const work = await mkdtemp(join(tmpdir(), "lightsheet-atlas-cli-check-"));
try {
  // Prefetch pinned examples (and atlas cache if running directly without packaged models/)
  const cropPath = await prefetchExample("cellfinder-crop", work);
  const brainPath = await prefetchExample("brainreg-test-brain", work);

  let atlasEnv = {};
  if (!values.executable) {
    const atlasDir = join(work, "atlas-cache");
    await downloadModels({ cacheDir: atlasDir, offline: false });
    atlasEnv = { NEURODESK_LIGHTSHEET_ATLAS_MODEL_DIR: atlasDir };
  }

  // 1. self-check offline
  const selfCheck = runCli(["self-check"], { extraEnv: atlasEnv });
  check(selfCheck.status === 0, `self-check exits 0 (status ${selfCheck.status}${selfCheck.status ? `: ${selfCheck.stderr.trim()}` : ""})`);
  const selfInfo = JSON.parse(selfCheck.stdout.trim());
  check(selfInfo.ok === true && selfInfo.greedy === "wasm-single", `self-check confirms Greedy WASM (${selfInfo.version})`);
  check(selfInfo.atlas?.ready === true && selfInfo.atlas?.count === 3, `self-check confirms all 3 bundled Allen CCFv3 atlas assets verified (${selfInfo.atlas?.directory ?? defaultCacheDir()})`);

  // 2. Cell detection example (cellfinder-crop: expects exactly 38 cell candidates)
  const cropOut = join(work, "out-crop");
  const cropRun = runCli([cropPath, cropOut, "--no-register", "--detect", "--orientation", "asr", "--offline"], { extraEnv: atlasEnv });
  check(cropRun.status === 0, `cellfinder-crop exits 0${cropRun.status ? ` (${cropRun.stderr.trim()})` : ""}`);
  const cropCsv = await readFile(join(cropOut, "cellfinder-crop_candidates.csv"), "utf8");
  const cropLines = cropCsv.trim().split("\n");
  check(cropLines[0] === "x,y,z,x_um,y_um,z_um", `cellfinder-crop writes expected candidate CSV header`);
  const detectedCount = cropLines.length - 1;
  check(detectedCount === 38, `cellfinder-crop detects exact cellfinder reference count: ${detectedCount} (expected 38)`);
  const cropMarks = gunzipSync(await readFile(join(cropOut, "cellfinder-crop_candidates.nii.gz")));
  const cropMarksHdr = parseNiftiHeader(cropMarks.buffer.slice(cropMarks.byteOffset, cropMarks.byteOffset + cropMarks.byteLength));
  check(cropMarksHdr.dims[1] > 0 && cropMarksHdr.dims[2] > 0 && cropMarksHdr.dims[3] > 0, `cellfinder-crop candidate marks NIfTI is valid (${cropMarksHdr.dims.slice(1, 4).join("x")})`);

  // 3. Whole-brain Allen atlas registration example (brainreg-test-brain)
  const brainOut = join(work, "out-brain");
  const brainRun = runCli([brainPath, brainOut, "--orientation", "psl", "--offline"], { extraEnv: atlasEnv });
  check(brainRun.status === 0, `brainreg-test-brain exits 0${brainRun.status ? ` (${brainRun.stderr.trim()})` : ""}`);
  const regAtlasGz = await readFile(join(brainOut, "brainreg-test-brain_registered-atlas.nii.gz"));
  const regAtlasRaw = gunzipSync(regAtlasGz);
  const regHdr = parseNiftiHeader(regAtlasRaw.buffer.slice(regAtlasRaw.byteOffset, regAtlasRaw.byteOffset + regAtlasRaw.byteLength));
  check(regHdr.dims[1] > 100 && regHdr.dims[2] > 100 && regHdr.dims[3] > 100, `brainreg-test-brain registered atlas NIfTI shape ${regHdr.dims.slice(1, 4).join("x")}`);
  const regionsCsv = await readFile(join(brainOut, "brainreg-test-brain_regions.csv"), "utf8");
  const regionLines = regionsCsv.trim().split("\n");
  check(regionLines.length > 200, `brainreg-test-brain regions.csv reports ${regionLines.length - 1} Allen atlas structures`);
  const prov = JSON.parse(await readFile(join(brainOut, "brainreg-test-brain_provenance.json"), "utf8"));
  check(prov.app === "lightsheet-atlas" && prov.regionRows > 200, `brainreg-test-brain writes valid provenance JSON (${prov.seconds} s)`);
} finally {
  await rm(work, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log(`\nAll @neurodesk/lightsheet-atlas portable CLI checks passed${useUnshare ? " (network-isolated via unshare -rn)" : ""}.`);
