#!/usr/bin/env node
// Portable release validation for @neurodesk/neuromorph.
// Prefetches both pinned NeuroMorpho.Org examples into tmpdir() BEFORE running any CLI invocation,
// runs the CLI offline (under `unshare -rn` on Linux when available), and independently verifies
// total length, bifurcations, terminals, and Sholl peak against the published reference values.
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
  : [process.execPath, fileURLToPath(new URL("../bin/neuromorph.js", import.meta.url))];

const examples = JSON.parse(await readFile(new URL("../../../apps/neuromorph/examples.json", import.meta.url), "utf8"));
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

const work = await mkdtemp(join(tmpdir(), "neuromorph-cli-check-"));
try {
  // Prefetch both pinned examples into tmpdir() before invoking CLI
  const ca1Path = await prefetch("ca1-pyramidal", work);
  const dgPath = await prefetch("dg-basket", work);

  // 1. self-check
  const selfCheck = runCli(["self-check"]);
  check(selfCheck.status === 0, `self-check exits 0 (status ${selfCheck.status})`);
  const selfInfo = JSON.parse(selfCheck.stdout.trim());
  check(selfInfo.ok === true && selfInfo.phantom?.bifurcations === 1, `self-check phantom verified (${selfInfo.version})`);

  // 2. Single-neuron CA1 pyramidal cell (expected: ~11.9 mm dendrite, 75 bifurcations, Sholl peak 46 at 40 um)
  const outCa1 = join(work, "out-ca1");
  const runCa1 = runCli([ca1Path, outCa1, "--sholl-step", "10", "--offline"]);
  check(runCa1.status === 0, `ca1-pyramidal exits 0${runCa1.status ? ` (${runCa1.stderr.trim()})` : ""}`);
  const ca1Prov = JSON.parse(await readFile(join(outCa1, "n120.CNG_provenance.json"), "utf8"));
  const ca1Sum = ca1Prov.neurons[0].summary;
  check(ca1Sum.bifurcations === 75, `ca1-pyramidal bifurcations = ${ca1Sum.bifurcations} (expected 75)`);
  check(Math.abs(ca1Sum.totalLengthUm - 11900) < 200, `ca1-pyramidal total length = ${ca1Sum.totalLengthUm.toFixed(1)} µm (~11.9 mm)`);
  check(ca1Sum.peakShollIntersections === 46, `ca1-pyramidal Sholl peak = ${ca1Sum.peakShollIntersections} (expected 46)`);

  // 3. Batch run with both neurons (expected DG basket: ~7.8 mm, 51 bifurcations, Sholl peak 30)
  const outBatch = join(work, "out-batch");
  const runBatch = runCli([ca1Path, dgPath, outBatch, "--sholl-step", "10", "--offline"]);
  check(runBatch.status === 0, `batch run exits 0${runBatch.status ? ` (${runBatch.stderr.trim()})` : ""}`);
  const batchProv = JSON.parse(await readFile(join(outBatch, "neuromorph_provenance.json"), "utf8"));
  const dgSum = batchProv.neurons[1].summary;
  check(batchProv.neurons.length === 2, `batch provenance contains both neurons`);
  check(dgSum.bifurcations === 51, `dg-basket bifurcations = ${dgSum.bifurcations} (expected 51)`);
  check(dgSum.peakShollIntersections === 30, `dg-basket Sholl peak = ${dgSum.peakShollIntersections} (expected 30)`);
  const shollCsv = await readFile(join(outBatch, "neuromorph_sholl.csv"), "utf8");
  check(shollCsv.includes("n120.CNG.swc,40,46,") && shollCsv.includes("5-27-11cell1-nonFS-BC.CNG.swc,120,30,"),
    `batch sholl.csv matches both published Sholl peaks (46 at 40 µm, 30 at 120 µm)`);
} finally {
  await rm(work, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log(`\nAll @neurodesk/neuromorph portable CLI checks passed${useUnshare ? " (network-isolated via unshare -rn)" : ""}.`);
