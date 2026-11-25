#!/usr/bin/env node
// Portable release validation for @neurodesk/dermoscope.
// Prefetches pinned ISIC Archive examples from apps/dermoscope/examples.json into tmpdir()
// (never touching isolated $HOME), verifies SHA-256 up front, then runs every packaged
// dermoscope CLI invocation under network isolation (unshare -rn on Linux when available),
// verifying DullRazor hair removal, lesion segmentation, calibrated area math, ABCD scores, and PNG outputs.
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
  : [process.execPath, fileURLToPath(new URL("../bin/dermoscope.js", import.meta.url))];

const examples = JSON.parse(
  await readFile(new URL("../../../apps/dermoscope/examples.json", import.meta.url), "utf8"),
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
const hairy = examples.find((item) => item.id === "isic-melanoma-in-situ");
const nevus = examples.find((item) => item.id === "isic-benign-nevus");
const [hairyPath, nevusPath] = await Promise.all([
  fetchPinnedExample(hairy.files[0]),
  fetchPinnedExample(nevus.files[0]),
]);

const work = await mkdtemp(join(tmpdir(), "dermoscope-cli-check-"));
try {
  const selfCheck = runCli(["self-check"]);
  check(selfCheck.status === 0, `self-check exits 0 (status ${selfCheck.status})`);
  const selfInfo = JSON.parse(selfCheck.stdout.trim());
  check(selfInfo.ok === true, `self-check reports ok=true (${selfInfo.version})`);

  const hairyOut = join(work, "out-hairy");
  const hairyRun = runCli([hairyPath, hairyOut, "--pixels-per-mm", "15", "--differential-structures", "3"]);
  check(
    hairyRun.status === 0,
    `isic-melanoma-in-situ: CLI exits 0${hairyRun.status ? ` (${hairyRun.stderr.trim()})` : ""}`,
  );

  const hairyStem = `${hairy.files[0].sha256.slice(0, 12)}-ISIC_0000022`;
  const prov = JSON.parse(await readFile(join(hairyOut, `${hairyStem}_provenance.json`), "utf8"));
  const csv = await readFile(join(hairyOut, `${hairyStem}_abcd_metrics.csv`), "utf8");
  const prePng = PNG.sync.read(await readFile(join(hairyOut, `${hairyStem}_preprocessed.png`)), { checkCRC: true });
  const maskPng = PNG.sync.read(await readFile(join(hairyOut, `${hairyStem}_mask.png`)), { checkCRC: true });

  const expectedAreaMm2 =
    prov.abcd.geometry.areaPx / (prov.workingDimensions.scaleX * prov.workingDimensions.scaleY) / (15 * 15);
  check(
    prov.segmentation.segmented === true && prov.abcd.geometry.areaPx > 500,
    `isic-melanoma-in-situ: segmented lesion (${prov.abcd.geometry.areaPx} px, ${prov.abcd.geometry.areaMm2.toFixed(2)} mm^2)`,
  );
  check(
    Math.abs(prov.abcd.geometry.areaMm2 - expectedAreaMm2) / expectedAreaMm2 < 1e-3,
    `isic-melanoma-in-situ: calibrated areaMm2 matches areaPx/(scaleX*scaleY)/ppm^2 (${prov.abcd.geometry.areaMm2.toFixed(3)} vs ${expectedAreaMm2.toFixed(3)})`,
  );
  check(
    prov.preprocessing.repairedPixels > 0,
    `isic-melanoma-in-situ: DullRazor repaired ${prov.preprocessing.repairedPixels} hair pixels`,
  );
  check(
    prov.abcd.scores.A !== null && prov.abcd.scores.C >= 1 && prov.abcd.scores.D === 3,
    `isic-melanoma-in-situ: ABCD scores computed (A=${prov.abcd.scores.A}, B=${prov.abcd.scores.B}, C=${prov.abcd.scores.C}, D=${prov.abcd.scores.D})`,
  );
  check(
    prePng.width === maskPng.width && prePng.height === maskPng.height && prePng.width > 0,
    `isic-melanoma-in-situ: preprocessed and mask PNG dimensions agree (${prePng.width}x${prePng.height})`,
  );
  check(
    csv.includes("score_A_asymmetry") && csv.includes("tds_total_dermoscopy_score"),
    "isic-melanoma-in-situ: metrics CSV contains ABCD and TDS rows",
  );

  const nevusOut = join(work, "out-nevus");
  const nevusRun = runCli([nevusPath, nevusOut]);
  check(nevusRun.status === 0, `isic-benign-nevus: CLI exits 0`);
  const nevusStem = `${nevus.files[0].sha256.slice(0, 12)}-ISIC_0000000`;
  const nevusProv = JSON.parse(await readFile(join(nevusOut, `${nevusStem}_provenance.json`), "utf8"));
  check(
    nevusProv.segmentation.segmented === true && nevusProv.abcd.geometry.areaPx > 500,
    `isic-benign-nevus: segmented lesion (${nevusProv.abcd.geometry.areaPx} px)`,
  );
} finally {
  await rm(work, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("\nAll @neurodesk/dermoscope portable CLI checks passed.");
