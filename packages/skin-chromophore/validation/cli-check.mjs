#!/usr/bin/env node
// Portable release validation for @neurodesk/skin-chromophore.
// Prefetches pinned ISIC examples from apps/skin-chromophore/examples.json into tmpdir()
// (never touching isolated $HOME), verifies SHA-256 up front, then runs every packaged CLI
// invocation under network isolation (unshare -rn on Linux when available), checking
// hemoglobin vs melanin separation, ITA° maps, ΔE2000, CSV, and honest Node provenance.
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
  : [process.execPath, fileURLToPath(new URL("../bin/skin-chromophore.js", import.meta.url))];

const examples = JSON.parse(
  await readFile(new URL("../../../apps/skin-chromophore/examples.json", import.meta.url), "utf8"),
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
const hem = examples.find((item) => item.id === "isic-hemangioma");
const pig = examples.find((item) => item.id === "isic-pigmented-melanoma");
const [hemPath, pigPath] = await Promise.all([
  fetchPinnedExample(hem.files[0]),
  fetchPinnedExample(pig.files[0]),
]);

const work = await mkdtemp(join(tmpdir(), "skin-chromophore-cli-check-"));
try {
  const selfCheck = runCli(["self-check"]);
  check(selfCheck.status === 0, `self-check exits 0 (status ${selfCheck.status})`);
  const selfInfo = JSON.parse(selfCheck.stdout.trim());
  check(selfInfo.ok === true, `self-check reports ok=true (${selfInfo.version})`);

  // 1. Vascular hemangioma: elevated hemoglobin OD and erythema index vs perilesional skin
  const hemOut = join(work, "out-hemangioma");
  const hemRun = runCli([hemPath, hemOut]);
  check(hemRun.status === 0, `isic-hemangioma: CLI exits 0${hemRun.status ? ` (${hemRun.stderr.trim()})` : ""}`);

  const hemStem = `${hem.files[0].sha256.slice(0, 12)}-ISIC_0001115`;
  const hemProv = JSON.parse(await readFile(join(hemOut, `${hemStem}_provenance.json`), "utf8"));
  const hemCsv = await readFile(join(hemOut, `${hemStem}_colorimetry.csv`), "utf8");
  const hbPng = PNG.sync.read(await readFile(join(hemOut, `${hemStem}_hemoglobin.png`)), { checkCRC: true });
  const melPng = PNG.sync.read(await readFile(join(hemOut, `${hemStem}_melanin.png`)), { checkCRC: true });
  const itaPng = PNG.sync.read(await readFile(join(hemOut, `${hemStem}_ita.png`)), { checkCRC: true });

  check(
    hemProv.summary.comparison.deltaHemoglobin > 0 && hemProv.summary.comparison.deltaE2000 > 5,
    `isic-hemangioma: elevated hemoglobin proxy (ΔHb=${hemProv.summary.comparison.deltaHemoglobin.toFixed(3)}, ΔE2000=${hemProv.summary.comparison.deltaE2000.toFixed(1)})`,
  );
  check(
    hbPng.width === melPng.width && melPng.width === itaPng.width && hbPng.width > 0,
    `isic-hemangioma: encoded hemoglobin, melanin, and ITA° PNGs verified with CRC (${hbPng.width}x${hbPng.height})`,
  );
  check(
    hemProv.input.colorSpace.includes("Node"),
    `isic-hemangioma: provenance records honest Node decode colorSpace (${hemProv.input.colorSpace})`,
  );
  check(
    hemCsv.includes("target,") && hemCsv.includes("reference,") && hemCsv.includes("target_minus_reference,"),
    "isic-hemangioma: colorimetry CSV contains target, reference, and diff rows",
  );

  // 2. Heavily pigmented melanoma: elevated melanin OD and depressed ITA°
  const pigOut = join(work, "out-melanoma");
  const pigRun = runCli([pigPath, pigOut, "--white-balance"]);
  check(pigRun.status === 0, `isic-pigmented-melanoma: CLI exits 0`);
  const pigStem = `${pig.files[0].sha256.slice(0, 12)}-ISIC_0000013`;
  const pigProv = JSON.parse(await readFile(join(pigOut, `${pigStem}_provenance.json`), "utf8"));
  check(
    pigProv.summary.comparison.deltaMelanin > 0 && pigProv.summary.comparison.deltaE2000 > 5,
    `isic-pigmented-melanoma: elevated melanin proxy (ΔMel=${pigProv.summary.comparison.deltaMelanin.toFixed(3)}, ΔE2000=${pigProv.summary.comparison.deltaE2000.toFixed(1)})`,
  );
} finally {
  await rm(work, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("\nAll @neurodesk/skin-chromophore portable CLI checks passed.");
