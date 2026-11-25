#!/usr/bin/env node
// Portable release validation for @neurodesk/calcium-imaging.
// Prefetches the pinned 400-frame mouse A1 GCaMP example into tmpdir() BEFORE running
// any CLI invocation, runs the CLI offline (under `unshare -rn` on Linux when available),
// and verifies rigid shifts against CaImAn's recorded reference + ROI, ΔF/F & OASIS outputs.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parseShiftsCsv } from "../src/outputs.js";

const { values } = parseArgs({ options: { executable: { type: "string" } } });
const command = values.executable
  ? [resolve(values.executable)]
  : [process.execPath, fileURLToPath(new URL("../bin/calcium-imaging.js", import.meta.url))];

const examples = JSON.parse(await readFile(new URL("../../../apps/calcium-imaging/examples.json", import.meta.url), "utf8"));
const caimanRef = JSON.parse(await readFile(new URL("../../../apps/calcium-imaging/validation/caiman-rigid-shifts.json", import.meta.url), "utf8"));
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

const work = await mkdtemp(join(tmpdir(), "calcium-imaging-cli-check-"));
try {
  // Prefetch pinned example into tmpdir() before invoking CLI
  const file = examples[0].files[0];
  const moviePath = join(work, file.name);
  const response = await fetch(file.url);
  if (!response.ok) throw new Error(`Failed to fetch ${file.url}: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== file.bytes || sha256(bytes) !== file.sha256) {
    throw new Error(`${file.name}: integrity check failed`);
  }
  await writeFile(moviePath, bytes);

  // 1. self-check
  const selfCheck = runCli(["self-check"]);
  check(selfCheck.status === 0, `self-check exits 0 (status ${selfCheck.status})`);
  const selfInfo = JSON.parse(selfCheck.stdout.trim());
  check(selfInfo.ok === true && selfInfo.phantom?.shiftErrorPx?.y < 0.25, `self-check phantom verified (${selfInfo.version})`);

  // 2. Run on pinned 400-frame Froemke A1 GCaMP example offline
  const outDir = join(work, "out");
  const run = runCli([moviePath, outDir, "--offline"]);
  check(run.status === 0, `froemke-a1-gcamp exits 0${run.status ? ` (${run.stderr.trim()})` : ""}`);

  const stem = "froemke-nv60-a1-gcamp-400frames";
  const shifts = parseShiftsCsv(await readFile(join(outDir, `${stem}_shifts.csv`), "utf8"));
  check(shifts.length === 400, `shifts.csv contains all 400 frames (got ${shifts.length})`);

  // Compare rigid shifts against CaImAn's recorded reference (fail loudly if fixture key is missing/malformed)
  const refShifts = caimanRef?.caimanRegisterTranslation;
  const validRef =
    Array.isArray(refShifts)
    && refShifts.length === shifts.length
    && refShifts.every((pair) => Array.isArray(pair) && pair.length === 2 && Number.isFinite(pair[0]) && Number.isFinite(pair[1]));
  check(validRef, `caimanRegisterTranslation reference fixture is valid (${Array.isArray(refShifts) ? refShifts.length : "missing"} shifts)`);
  if (validRef) {
    const meanDy = shifts.reduce((s, v, i) => s + (v[0] - refShifts[i][0]), 0) / shifts.length;
    const meanDx = shifts.reduce((s, v, i) => s + (v[1] - refShifts[i][1]), 0) / shifts.length;
    let maxErr = 0;
    for (let i = 0; i < shifts.length; i++) {
      maxErr = Math.max(maxErr, Math.abs(shifts[i][0] - refShifts[i][0] - meanDy), Math.abs(shifts[i][1] - refShifts[i][1] - meanDx));
    }
    check(maxErr <= 0.6, `rigid shifts agree with CaImAn reference within 0.6 px (max diff ${maxErr.toFixed(3)} px)`);
  }

  const roisLines = (await readFile(join(outDir, `${stem}_rois.csv`), "utf8")).trim().split("\n");
  check(roisLines.length > 5, `rois.csv extracted ${roisLines.length - 1} active neurons`);

  const tracesLines = (await readFile(join(outDir, `${stem}_traces.csv`), "utf8")).trim().split("\n");
  check(tracesLines.length === 401 && tracesLines[0].includes("_dFF") && tracesLines[0].includes("_spikes"),
    `traces.csv writes 400 rows with ΔF/F and OASIS spikes`);

  const prov = JSON.parse(await readFile(join(outDir, `${stem}_provenance.json`), "utf8"));
  check(prov.app === "calcium-imaging" && prov.rois.count === roisLines.length - 1, `provenance JSON matches ROI count (${prov.rois.count})`);
} finally {
  await rm(work, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log(`\nAll @neurodesk/calcium-imaging portable CLI checks passed${useUnshare ? " (network-isolated via unshare -rn)" : ""}.`);
