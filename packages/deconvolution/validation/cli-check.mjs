#!/usr/bin/env node
// Portable release validation for @neurodesk/deconvolution.
// Prefetches the pinned HeLa phalloidin confocal stack into tmpdir(), runs the packaged CLI
// offline (and under unshare -rn on Linux when available), and checks exact output parity
// against apps/deconvolution/e2e/expected.json.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";
import examples from "../../../apps/deconvolution/examples.json" with { type: "json" };
import expected from "../../../apps/deconvolution/e2e/expected.json" with { type: "json" };
import { readVolume } from "../src/input.js";

const { values } = parseArgs({ options: { executable: { type: "string" } } });
const command = values.executable
  ? [resolve(values.executable)]
  : [process.execPath, fileURLToPath(new URL("../bin/deconvolution.js", import.meta.url))];

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const failures = [];
function check(passed, message) {
  if (!passed) failures.push(message);
  console.log(`${passed ? "PASS" : "FAIL"} ${message}`);
}

const canUnshare = process.platform === "linux"
  && spawnSync("unshare", ["-rn", "true"], { stdio: "ignore" }).status === 0;

function runCliOffline(args) {
  const execCmd = canUnshare ? ["unshare", "-rn", ...command, ...args] : [...command, ...args];
  const run = spawnSync(execCmd[0], execCmd.slice(1), {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (run.error) throw run.error;
  return run;
}

async function fetchPinned(fileSpec) {
  const dir = join(tmpdir(), "neurodesk-deconvolution-validation");
  const target = join(dir, fileSpec.name);
  const existing = await readFile(target).catch(() => null);
  if (existing && existing.byteLength === fileSpec.bytes && sha256(existing) === fileSpec.sha256) {
    return target;
  }
  const response = await fetch(fileSpec.url);
  if (!response.ok) throw new Error(`Failed to fetch ${fileSpec.url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength !== fileSpec.bytes || sha256(bytes) !== fileSpec.sha256) {
    throw new Error(`${fileSpec.name}: SHA-256 or byte size differs from pinned example.`);
  }
  await mkdir(dir, { recursive: true });
  const partial = `${target}.${process.pid}.partial`;
  await writeFile(partial, bytes);
  await rename(partial, target);
  return target;
}

const inputPath = await fetchPinned(examples[0].files[0]);

const work = await mkdtemp(join(tmpdir(), "deconvolution-cli-check-"));
try {
  // 1. self-check
  const selfCheck = runCliOffline(["self-check"]);
  check(selfCheck.status === 0, `self-check exits 0 (status ${selfCheck.status})`);
  const selfInfo = JSON.parse(selfCheck.stdout.trim());
  check(selfInfo.ok === true && selfInfo.methods?.includes("rl") && selfInfo.methods?.includes("rltv"),
    `self-check reports ok=true and rl/rltv (${selfInfo.version})`);

  // 2. Confocal HeLa stack with 10 RL iterations matching apps/deconvolution/e2e/expected.json
  const outDir = join(work, "hela-rl");
  const run = runCliOffline([
    inputPath,
    outDir,
    "--modality", "confocal",
    "--na", "1.4",
    "--immersion-index", "1.518",
    "--sample-index", "1.47",
    "--emission-nm", "525",
    "--excitation-nm", "488",
    "--method", "rl",
    "--iterations", String(expected.iterations),
    "--offline",
  ]);
  check(run.status === 0, `hela-rl: CLI exits 0${run.status ? ` (${run.stderr.trim()})` : ""}`);

  const outTiff = await readVolume(new File([await readFile(join(outDir, "hela-phalloidin488-confocal_deconvolved.tif"))], "hela-phalloidin488-confocal_deconvolved.tif"));
  const psfTiff = await readVolume(new File([await readFile(join(outDir, "hela-phalloidin488-confocal_psf.tif"))], "hela-phalloidin488-confocal_psf.tif"));
  const prov = JSON.parse(await readFile(join(outDir, "hela-phalloidin488-confocal_provenance.json"), "utf8"));

  // Independently inspect the raw NIfTI-1 output header and float32 voxel payload (without calling our own NIfTI reader).
  const rawNii = gunzipSync(await readFile(join(outDir, "hela-phalloidin488-confocal_deconvolved.nii.gz")), { maxOutputLength: 64 * 1024 * 1024 });
  const niiView = new DataView(rawNii.buffer, rawNii.byteOffset, rawNii.byteLength);
  const sizeofHdr = niiView.getInt32(0, true);
  const magic = rawNii.subarray(344, 348).toString("ascii");
  const niiDims = [niiView.getInt16(46, true), niiView.getInt16(44, true), niiView.getInt16(42, true)];
  const datatype = niiView.getInt16(70, true);
  const bitpix = niiView.getInt16(72, true);
  const voxOffset = Math.ceil(niiView.getFloat32(108, true));
  const qformCode = niiView.getInt16(252, true);
  const sformCode = niiView.getInt16(254, true);
  const niiVoxels = new Float32Array(
    rawNii.buffer,
    rawNii.byteOffset + voxOffset,
    niiDims[0] * niiDims[1] * niiDims[2],
  );
  let niiSum = 0;
  let niiMax = -Infinity;
  for (let i = 0; i < niiVoxels.length; i += 1) {
    niiSum += niiVoxels[i];
    if (niiVoxels[i] > niiMax) niiMax = niiVoxels[i];
  }
  const niiMean = niiSum / niiVoxels.length;
  const niiDigest = sha256(new Uint8Array(niiVoxels.buffer, niiVoxels.byteOffset, niiVoxels.byteLength));

  check(outTiff.dims.join("x") === expected.dims.join("x"), `deconvolved TIFF dims ${outTiff.dims.join("x")} == ${expected.dims.join("x")}`);
  check(sizeofHdr === 348 && magic === "n+1\0" && datatype === 16 && bitpix === 32 && qformCode > 0 && sformCode > 0,
    `raw NIfTI-1 header valid (sizeof_hdr=${sizeofHdr}, datatype=${datatype}, bitpix=${bitpix}, qform=${qformCode}, sform=${sformCode})`);
  check(niiDims.join("x") === expected.dims.join("x"), `raw NIfTI dims ${niiDims.join("x")} == ${expected.dims.join("x")}`);
  check(niiDigest === expected.sha256, `raw NIfTI voxels SHA-256 matches e2e reference (${niiDigest.slice(0, 12)})`);
  check(Math.abs(niiMean - expected.mean) < 1e-4 && Math.abs(niiMax - expected.max) < 1e-3,
    `raw NIfTI mean ${niiMean.toFixed(4)} (~${expected.mean.toFixed(4)}), max ${niiMax.toFixed(2)} (~${expected.max.toFixed(2)})`);
  check(psfTiff.dims.join("x") === expected.psfDims.join("x"), `PSF TIFF dims ${psfTiff.dims.join("x")} == ${expected.psfDims.join("x")}`);

  let sum = 0;
  let max = -Infinity;
  for (let i = 0; i < outTiff.data.length; i += 1) {
    sum += outTiff.data[i];
    if (outTiff.data[i] > max) max = outTiff.data[i];
  }
  const mean = sum / outTiff.data.length;
  const digest = sha256(new Uint8Array(outTiff.data.buffer, outTiff.data.byteOffset, outTiff.data.byteLength));
  check(digest === expected.sha256, `deconvolved TIFF voxels SHA-256 matches e2e reference (${digest.slice(0, 12)})`);
  check(Math.abs(mean - expected.mean) < 1e-4 && Math.abs(max - expected.max) < 1e-3,
    `TIFF mean ${mean.toFixed(4)} (~${expected.mean.toFixed(4)}), max ${max.toFixed(2)} (~${expected.max.toFixed(2)})`);
  check(prov.iterations === expected.iterations && prov.psf.source === "Gibson-Lanni", "writes valid provenance JSON");
} finally {
  await rm(work, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log(`network_isolation=${canUnshare ? "unshare-rn" : "fallback"}`);
console.log(`\nAll @neurodesk/deconvolution portable CLI checks passed (${canUnshare ? "unshare -rn" : "fallback"}).`);
