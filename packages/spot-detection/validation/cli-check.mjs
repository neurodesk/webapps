#!/usr/bin/env node
// Verifies a built spot-detection executable on the pinned Big-FISH smFISH example stack and cell labels.
// Prefetches pinned assets into tmpdir() before invoking the CLI offline (under unshare -rn on Linux when available).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const examples = JSON.parse(readFileSync(join(repoRoot, "apps/spot-detection/examples.json"), "utf8"));
const reference = JSON.parse(readFileSync(join(repoRoot, "apps/spot-detection/validation/reference.json"), "utf8"));

const { values } = parseArgs({ options: { executable: { type: "string" } } });
const command = values.executable
  ? [resolve(values.executable)]
  : [process.execPath, resolve(here, "../bin/spot-detection.js")];

function hasUnshareNet() {
  if (process.platform !== "linux") return false;
  const probe = spawnSync("unshare", ["-rn", "true"], { stdio: "ignore" });
  return probe.status === 0;
}

const useUnshare = hasUnshareNet();

function runExe(args) {
  const full = [...command, ...args];
  const cmd = useUnshare ? "unshare" : full[0];
  const cmdArgs = useUnshare ? ["-rn", ...full] : full.slice(1);
  const result = spawnSync(cmd, cmdArgs, {
    encoding: "utf8",
    env: { ...process.env, NEURODESK_OFFLINE: "1" },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Command failed (${result.status}): ${full.join(" ")}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return result;
}

async function fetchPinned(entry, destPath) {
  const response = await fetch(entry.url);
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${entry.url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.length, entry.bytes, `${entry.name}: byte length mismatch`);
  const digest = createHash("sha256").update(bytes).digest("hex");
  assert.equal(digest, entry.sha256, `${entry.name}: sha256 mismatch`);
  writeFileSync(destPath, bytes);
  return destPath;
}

function parseCsvRows(text) {
  const lines = text.trim().split(/\r?\n/);
  const headers = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const parts = line.split(",");
    const row = {};
    for (let i = 0; i < headers.length; i += 1) row[headers[i]] = parts[i];
    return row;
  });
}

function assertValidNiftiGz(filePath, expectedDims) {
  const gz = readFileSync(filePath);
  const raw = gunzipSync(gz, { maxOutputLength: 128 * 1024 * 1024 });
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  assert.equal(view.getInt32(0, true), 348, `${filePath}: invalid NIfTI-1 sizeof_hdr`);
  assert.equal(raw.subarray(344, 348).toString("ascii"), "n+1\0", `${filePath}: invalid NIfTI-1 magic`);
  const dim = [view.getInt16(42, true), view.getInt16(44, true), view.getInt16(46, true)];
  assert.deepEqual(dim, expectedDims, `${filePath}: unexpected NIfTI dimensions`);
}

const work = mkdtempSync(join(tmpdir(), "spot-detection-cli-check-"));
try {
  // 1. Offline self-check
  const selfCheck = runExe(["self-check"]);
  const info = JSON.parse(selfCheck.stdout);
  assert.equal(info.ok, true);
  assert.equal(info.spotsRecovered, 12);

  // 2. Prefetch pinned Big-FISH example stack + cell labels into tmpdir()
  const example = examples[0];
  const imageEntry = example.files.find((f) => f.role === "image");
  const labelsEntry = example.files.find((f) => f.role === "labels");
  const imagePath = await fetchPinned(imageEntry, join(work, imageEntry.name));
  const labelsPath = await fetchPinned(labelsEntry, join(work, labelsEntry.name));

  // 3. 3D detection with cell labels (offline + network-isolated)
  const out3d = join(work, "out-3d");
  runExe([imagePath, out3d, "--labels", labelsPath, "--offline"]);

  const ref3d = reference.cases["example-3d"];
  const prov3d = JSON.parse(readFileSync(join(out3d, "experiment_1_smfish_fov_1_provenance.json"), "utf8"));
  assert.equal(prov3d.spots, ref3d.spots.length, "3D spot count must match Big-FISH reference");
  assert.equal(prov3d.threshold, ref3d.threshold, "3D auto threshold must match Big-FISH reference");
  assert.equal(prov3d.cells, ref3d.cells.length, "3D cell count must match Big-FISH reference");

  const spots3d = parseCsvRows(readFileSync(join(out3d, "experiment_1_smfish_fov_1_spots.csv"), "utf8"));
  assert.equal(spots3d.length, ref3d.spots.length);
  const cells3d = parseCsvRows(readFileSync(join(out3d, "experiment_1_smfish_fov_1_cell_counts.csv"), "utf8"))
    .filter((r) => Number(r.cell_id) > 0);
  assert.deepEqual(
    cells3d.map((r) => [Number(r.cell_id), Number(r.spots), Number(r.area_px)]),
    ref3d.cells,
  );
  assertValidNiftiGz(join(out3d, "experiment_1_smfish_fov_1_spots.nii.gz"), [500, 650, 23]);

  // 4. 2D maximum intensity projection detection with cell labels
  const outMip = join(work, "out-mip");
  runExe([imagePath, outMip, "--labels", labelsPath, "--projection", "--offline"]);

  const refMip = reference.cases["example-mip-2d"];
  const provMip = JSON.parse(readFileSync(join(outMip, "experiment_1_smfish_fov_1_mip_provenance.json"), "utf8"));
  assert.equal(provMip.spots, refMip.spots.length, "MIP spot count must match Big-FISH reference");
  assert.equal(provMip.threshold, refMip.threshold, "MIP auto threshold must match Big-FISH reference");

  const cellsMip = parseCsvRows(readFileSync(join(outMip, "experiment_1_smfish_fov_1_mip_cell_counts.csv"), "utf8"))
    .filter((r) => Number(r.cell_id) > 0);
  assert.deepEqual(
    cellsMip.map((r) => [Number(r.cell_id), Number(r.spots), Number(r.area_px)]),
    refMip.cells,
  );
  assertValidNiftiGz(join(outMip, "experiment_1_smfish_fov_1_mip_spots.nii.gz"), [500, 650, 1]);

  console.log(
    `PASS spot-detection (${useUnshare ? "unshare -rn" : "offline"}): 3D=${prov3d.spots} spots @ t=${prov3d.threshold}, MIP=${provMip.spots} spots @ t=${provMip.threshold}`,
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
