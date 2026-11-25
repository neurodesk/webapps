#!/usr/bin/env node
// Portable release validation for @neurodesk/derm-compare.
// Prefetches pinned ISIC paired dermoscopy images from apps/derm-compare/examples.json into
// tmpdir() (never touching isolated $HOME), verifies SHA-256 up front, then runs every
// packaged CLI invocation under network isolation (unshare -rn on Linux when available),
// checking NCC improvement, overlap, CIEDE2000 metrics, and PNG outputs.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { PNG } from "pngjs";

const { values } = parseArgs({ options: { executable: { type: "string" } } });
const command = values.executable
  ? [resolve(values.executable)]
  : [process.execPath, fileURLToPath(new URL("../bin/derm-compare.js", import.meta.url))];

const examples = JSON.parse(
  await readFile(new URL("../../../apps/derm-compare/examples.json", import.meta.url), "utf8"),
);

const failures = [];
function check(passed, message) {
  if (!passed) failures.push(message);
  console.log(`${passed ? "PASS" : "FAIL"} ${message}`);
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function probeNetworkIsolation() {
  if (process.platform !== "linux") return false;
  const probe = spawnSync("unshare", ["-rn", "sh", "-c", "ip link set lo up && true"], {
    stdio: "ignore",
  });
  return !probe.error && probe.status === 0;
}

const useNetIsolation = probeNetworkIsolation();
console.log(
  `INFO network_isolation=${useNetIsolation ? "unshare-rn" : "none (platform/unprivileged)"}`,
);

async function fetchPinnedExample(entry) {
  const cacheDir = join(tmpdir(), "neurodesk-dermatology-examples");
  await mkdir(cacheDir, { recursive: true });
  const target = join(cacheDir, `${entry.sha256.slice(0, 12)}-${entry.name}`);
  try {
    const existing = await readFile(target);
    if (existing.byteLength === entry.bytes && sha256(existing) === entry.sha256) {
      return target;
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const response = await fetch(entry.url);
  if (!response.ok) throw new Error(`Failed to fetch ${entry.url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength !== entry.bytes || sha256(bytes) !== entry.sha256) {
    throw new Error(`Checksum mismatch for ${entry.name}`);
  }
  const partial = `${target}.${process.pid}.part`;
  await writeFile(partial, bytes);
  await rename(partial, target);
  return target;
}

function runCli(args) {
  const spawnCmd = useNetIsolation
    ? ["unshare", "-rn", "sh", "-c", 'ip link set lo up && exec "$@"', "--", ...command, ...args]
    : [...command, ...args];
  const run = spawnSync(spawnCmd[0], spawnCmd.slice(1), {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  if (run.error) throw run.error;
  return run;
}

// Prefetch & SHA-256 verify all pinned fixtures up front before any CLI invocation.
const pair = examples.find((item) => item.id === "isic-nevus-pair");
const baseEntry = pair.files.find((f) => f.role === "baseline");
const follEntry = pair.files.find((f) => f.role === "followup");
const [basePath, follPath] = await Promise.all([
  fetchPinnedExample(baseEntry),
  fetchPinnedExample(follEntry),
]);

const work = await mkdtemp(join(tmpdir(), "derm-compare-cli-check-"));
try {
  const selfCheck = runCli(["self-check"]);
  check(selfCheck.status === 0, `self-check exits 0 (status ${selfCheck.status})`);
  const selfInfo = JSON.parse(selfCheck.stdout.trim());
  check(selfInfo.ok === true, `self-check reports ok=true (${selfInfo.version})`);

  const outDir = join(work, "out-pair");
  const run = runCli([basePath, follPath, outDir]);
  check(run.status === 0, `isic-nevus-pair: CLI exits 0${run.status ? ` (${run.stderr.trim()})` : ""}`);

  const baseStem = `${baseEntry.sha256.slice(0, 12)}-ISIC_0011414_1024`;
  const follStem = `${follEntry.sha256.slice(0, 12)}-ISIC_0011415_1024`;
  const stem = `${baseStem}_vs_${follStem}`;

  const prov = JSON.parse(await readFile(join(outDir, `${stem}_provenance.json`), "utf8"));
  const csv = await readFile(join(outDir, `${stem}_metrics.csv`), "utf8");
  const alignedPng = PNG.sync.read(await readFile(join(outDir, `${stem}_aligned.png`)), { checkCRC: true });
  const diffPng = PNG.sync.read(await readFile(join(outDir, `${stem}_deltaE2000.png`)), { checkCRC: true });

  check(
    prov.registration.registered === true && prov.registration.alignedNcc > prov.registration.initialNcc,
    `isic-nevus-pair: NCC improved ${prov.registration.initialNcc.toFixed(3)} -> ${prov.registration.alignedNcc.toFixed(3)}`,
  );
  check(
    prov.registration.overlapPct > 40 && Number.isFinite(prov.metrics.overlapMeanDeltaE),
    `isic-nevus-pair: overlap ${prov.registration.overlapPct.toFixed(1)}%, mean ΔE2000 ${prov.metrics.overlapMeanDeltaE.toFixed(2)}`,
  );
  check(
    alignedPng.width === diffPng.width && alignedPng.height === diffPng.height && alignedPng.width > 0,
    `isic-nevus-pair: aligned and ΔE2000 PNGs verified with CRC (${alignedPng.width}x${alignedPng.height})`,
  );
  check(
    csv.includes("aligned_ncc,") && csv.includes("overlap_mean_delta_e2000,"),
    "isic-nevus-pair: metrics CSV contains registration and ΔE2000 rows",
  );
} finally {
  await rm(work, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("\nAll @neurodesk/derm-compare portable CLI checks passed.");
