#!/usr/bin/env node
// Portable release validation for @neurodesk/dermvit.
// Prefetches pinned ISIC Archive examples from apps/dermvit/examples.json into tmpdir()
// (never touching isolated $HOME), verifies SHA-256 up front, then runs every packaged
// dermvit CLI invocation offline (and under unshare -rn network isolation on Linux when
// available), validating 7-class HAM10000 predictions, provenance, and 5x5 saliency PNG.
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
  : [process.execPath, fileURLToPath(new URL("../bin/dermvit.js", import.meta.url))];

const examples = JSON.parse(
  await readFile(new URL("../../../apps/dermvit/examples.json", import.meta.url), "utf8"),
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
const nevus = examples.find((item) => item.id === "isic-nevus");
const melanoma = examples.find((item) => item.id === "isic-melanoma");
const [nevusPath, melanomaPath] = await Promise.all([
  fetchPinnedExample(nevus.files[0]),
  fetchPinnedExample(melanoma.files[0]),
]);

const work = await mkdtemp(join(tmpdir(), "dermvit-cli-check-"));
try {
  const selfCheck = runCli(["self-check"]);
  check(selfCheck.status === 0, `self-check exits 0 (status ${selfCheck.status})`);
  const selfInfo = JSON.parse(selfCheck.stdout.trim());
  check(
    selfInfo.ok === true && typeof selfInfo.onnxRuntime === "string",
    `self-check reports ok=true and ONNX Runtime ${selfInfo.onnxRuntime}`,
  );

  const nevusOut = join(work, "out-nevus");
  const nevusRun = runCli([nevusPath, nevusOut, "--offline"]);
  check(nevusRun.status === 0, `isic-nevus (--offline): CLI exits 0${nevusRun.status ? ` (${nevusRun.stderr.trim()})` : ""}`);

  const nevusStem = `${nevus.files[0].sha256.slice(0, 12)}-ISIC_0000000`;
  const nevusCsv = await readFile(join(nevusOut, `${nevusStem}_dermvit-predictions.csv`), "utf8");
  const nevusProv = JSON.parse(await readFile(join(nevusOut, `${nevusStem}_dermvit-provenance.json`), "utf8"));
  const nevusProbSum = nevusProv.prediction.classes.reduce((sum, item) => sum + item.softmaxScore, 0);
  check(
    nevusProv.prediction.topClass === "NV",
    `isic-nevus: top predicted class is NV (got ${nevusProv.prediction.topClass}, score ${nevusProv.prediction.topSoftmaxScore})`,
  );
  check(
    nevusProv.prediction.classes.length === 7 && Math.abs(nevusProbSum - 1) < 1e-3,
    `isic-nevus: 7 valid softmax probabilities sum to ${nevusProbSum.toFixed(6)}`,
  );
  check(nevusCsv.includes(",NV,Melanocytic nevi,"), "isic-nevus: predictions CSV contains NV row");

  // Exercise --color-constancy and --saliency offline on the melanoma example
  const melOut = join(work, "out-melanoma");
  const melRun = runCli([melanomaPath, melOut, "--color-constancy", "--saliency", "--offline"]);
  check(
    melRun.status === 0,
    `isic-melanoma (--saliency --offline): CLI exits 0${melRun.status ? ` (${melRun.stderr.trim()})` : ""}`,
  );
  const melStem = `${melanoma.files[0].sha256.slice(0, 12)}-ISIC_0000013`;
  const melProv = JSON.parse(await readFile(join(melOut, `${melStem}_dermvit-provenance.json`), "utf8"));
  const melSaliency = PNG.sync.read(await readFile(join(melOut, `${melStem}_dermvit-saliency.png`)), {
    checkCRC: true,
  });
  check(
    melProv.parameters.colorConstancy === true && melProv.preprocessing.colorConstancyGains !== null,
    "isic-melanoma: Shades of Gray gains recorded in provenance",
  );
  check(
    melProv.saliency?.grid === 5 && melSaliency.width > 0 && melSaliency.height > 0,
    `isic-melanoma: 5x5 occlusion saliency PNG verified with CRC (${melSaliency.width}x${melSaliency.height})`,
  );
} finally {
  await rm(work, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("\nAll @neurodesk/dermvit portable CLI checks passed.");
