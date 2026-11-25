#!/usr/bin/env node
// Portable release validation for @neurodesk/microscope-qc.
// Prefetches both pinned examples (EVOS TetraSpeck bead stack + synthetic field illumination)
// into tmpdir() BEFORE running any CLI invocation, runs offline under `unshare -rn`, and
// independently verifies PSF FWHM and field uniformity/centering against MetroloJ_QC expectations.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { executable: { type: "string" } } });
const command = values.executable
  ? [resolve(values.executable)]
  : [process.execPath, fileURLToPath(new URL("../bin/microscope-qc.js", import.meta.url))];

const examples = JSON.parse(await readFile(new URL("../../../apps/microscope-qc/examples.json", import.meta.url), "utf8"));
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

async function prefetch(id, workDir) {
  const example = examples.find((entry) => entry.id === id);
  const file = example.files[0];
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

const work = await mkdtemp(join(tmpdir(), "microscope-qc-cli-check-"));
try {
  // Prefetch both pinned examples into tmpdir() before invoking CLI
  const beadsPath = await prefetch("evos-beads", work);
  const fieldPath = await prefetch("synthetic-field", work);

  // 1. self-check
  const selfCheck = runCli(["self-check"]);
  check(selfCheck.status === 0, `self-check exits 0 (status ${selfCheck.status})`);
  const selfInfo = JSON.parse(selfCheck.stdout.trim());
  check(selfInfo.ok === true && selfInfo.phantom?.beadsUsed === 1, `self-check phantom verified (${selfInfo.version})`);

  // 2. EVOS 40x/0.95 TetraSpeck bead stack (PSF auto-selected from 81 planes + OME-XML optics)
  const outPsf = join(work, "out-psf");
  const runPsf = runCli([beadsPath, outPsf, "--offline"]);
  check(runPsf.status === 0, `evos-beads exits 0${runPsf.status ? ` (${runPsf.stderr.trim()})` : ""}`);
  const psfReport = JSON.parse(await readFile(join(outPsf, "evos-40x-na095-tetraspeck-100nm_psf_report.json"), "utf8"));
  const sum = psfReport.summary;
  check(sum.beads === 63 && sum.used === 5, `evos-beads detected ${sum.beads} beads, ${sum.used} well-fitted (MetroloJ_QC ref: 63, 5)`);
  check(Math.abs(sum.x.mean - 0.38) < 0.05 && Math.abs(sum.y.mean - 0.38) < 0.05,
    `evos-beads lateral FWHM (${sum.x.mean.toFixed(3)}, ${sum.y.mean.toFixed(3)} µm) matches ~0.38 µm`);
  check(Math.abs(sum.z.mean - 2.3) < 0.3, `evos-beads axial FWHM (${sum.z.mean.toFixed(3)} µm) matches ~2.3 µm`);

  // 3. Synthetic field illumination (auto-selected from 1 plane)
  const outField = join(work, "out-field");
  const runField = runCli([fieldPath, outField, "--offline"]);
  check(runField.status === 0, `synthetic-field exits 0${runField.status ? ` (${runField.stderr.trim()})` : ""}`);
  const fieldReport = JSON.parse(await readFile(join(outField, "synthetic-field-illumination_field_report.json"), "utf8"));
  const m = fieldReport.metrics;
  check(Math.abs(m.uniformity - 45.0) < 0.5, `synthetic-field uniformity = ${m.uniformity.toFixed(2)} % (expected ~45.0 %)`);
  check(Math.abs(m.fieldUniformity - 88.1) < 0.5, `synthetic-field fieldUniformity = ${m.fieldUniformity.toFixed(2)} % (expected ~88.1 %)`);
  check(Math.abs(m.centeringAccuracy - 91.4) < 0.5, `synthetic-field centeringAccuracy = ${m.centeringAccuracy.toFixed(2)} % (expected ~91.4 %)`);
} finally {
  await rm(work, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log(`\nAll @neurodesk/microscope-qc portable CLI checks passed${useUnshare ? " (network-isolated via unshare -rn)" : ""}.`);
