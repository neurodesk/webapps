#!/usr/bin/env node
// Portable release validation for @neurodesk/wound-planimetry.
// Prefetches pinned clinical wound examples from apps/wound-planimetry/examples.json into
// tmpdir() (never touching isolated $HOME), verifies SHA-256 up front, then runs every
// packaged CLI invocation under network isolation (unshare -rn on Linux when available),
// checking planimetry geometry, independent scale math, RYB totals, CSV, JSON, and PNGs.
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
  : [process.execPath, fileURLToPath(new URL("../bin/wound-planimetry.js", import.meta.url))];

const examples = JSON.parse(
  await readFile(new URL("../../../apps/wound-planimetry/examples.json", import.meta.url), "utf8"),
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
const heel = examples.find((item) => item.id === "diabetic-heel-ulcer");
const venous = examples.find((item) => item.id === "venous-leg-ulcer");
const [heelPath, venousPath] = await Promise.all([
  fetchPinnedExample(heel.files[0]),
  fetchPinnedExample(venous.files[0]),
]);

const work = await mkdtemp(join(tmpdir(), "wound-planimetry-cli-check-"));
try {
  const selfCheck = runCli(["self-check"]);
  check(selfCheck.status === 0, `self-check exits 0 (status ${selfCheck.status})`);
  const selfInfo = JSON.parse(selfCheck.stdout.trim());
  check(selfInfo.ok === true, `self-check reports ok=true (${selfInfo.version})`);

  // 1. Diabetic neuropathic heel ulcer (uncalibrated default matching webapp)
  const heelOut = join(work, "out-heel");
  const heelRun = runCli([heelPath, heelOut]);
  check(heelRun.status === 0, `diabetic-heel-ulcer: CLI exits 0${heelRun.status ? ` (${heelRun.stderr.trim()})` : ""}`);

  const heelStem = `${heel.files[0].sha256.slice(0, 12)}-neuropathic_heel_ulcer_diabetic`;
  const heelProv = JSON.parse(await readFile(join(heelOut, `${heelStem}_wound-provenance.json`), "utf8"));
  const heelCsv = await readFile(join(heelOut, `${heelStem}_wound-planimetry.csv`), "utf8");
  const heelOverlay = PNG.sync.read(await readFile(join(heelOut, `${heelStem}_wound-ryb-overlay.png`)), {
    checkCRC: true,
  });
  const heelMask = PNG.sync.read(await readFile(join(heelOut, `${heelStem}_wound-mask.png`)), { checkCRC: true });

  const rybSum =
    heelProv.ryb.classes.red.percent +
    heelProv.ryb.classes.yellow.percent +
    heelProv.ryb.classes.black.percent +
    heelProv.ryb.classes.unclassified.percent;

  check(
    heelProv.woundDetected === true && heelProv.planimetry.areaPx > 200,
    `diabetic-heel-ulcer: segmented wound bed (${heelProv.planimetry.areaPx} px, circularity ${heelProv.planimetry.circularity.toFixed(3)})`,
  );
  check(
    heelProv.planimetry.circularity > 0 && heelProv.planimetry.circularity <= 1 + 1e-6,
    `diabetic-heel-ulcer: circularity obeys isoperimetric bound (<= 1)`,
  );
  check(
    Math.abs(rybSum - 100) < 0.2,
    `diabetic-heel-ulcer: RYB tissue percentages sum to ${rybSum.toFixed(2)}%`,
  );
  check(
    heelOverlay.width === heelMask.width && heelOverlay.height === heelMask.height && heelOverlay.width > 0,
    `diabetic-heel-ulcer: overlay and mask PNGs verified with CRC (${heelOverlay.width}x${heelOverlay.height})`,
  );
  check(
    heelCsv.includes("wound_area_px,") && heelCsv.includes("ryb_red_granulation_pct,"),
    "diabetic-heel-ulcer: CSV contains planimetry and RYB rows",
  );

  // 2. Venous dorsal leg ulcer with --mm-per-pixel 0.1 calibration (= 10 px/mm)
  const venousOut = join(work, "out-venous");
  const venousRun = runCli([venousPath, venousOut, "--mm-per-pixel", "0.1"]);
  check(venousRun.status === 0, `venous-leg-ulcer (--mm-per-pixel): CLI exits 0`);
  const venousStem = `${venous.files[0].sha256.slice(0, 12)}-venous_ulcer_dorsal_leg`;
  const venousProv = JSON.parse(await readFile(join(venousOut, `${venousStem}_wound-provenance.json`), "utf8"));
  const expectedAreaMm2 = venousProv.planimetry.areaPx * 0.1 * 0.1;
  const expectedAreaCm2 = expectedAreaMm2 / 100;
  check(
    venousProv.woundDetected === true &&
      venousProv.planimetry.calibrated === true &&
      Math.abs(venousProv.planimetry.areaMm2 - expectedAreaMm2) < 1e-2 &&
      Math.abs(venousProv.planimetry.areaCm2 - expectedAreaCm2) < 1e-3,
    `venous-leg-ulcer: calibrated area ${venousProv.planimetry.areaCm2.toFixed(4)} cm^2 matches areaPx*(0.1^2)/100 = ${expectedAreaCm2.toFixed(4)} cm^2 (${venousProv.planimetry.areaPx} px)`,
  );
} finally {
  await rm(work, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("\nAll @neurodesk/wound-planimetry portable CLI checks passed.");
