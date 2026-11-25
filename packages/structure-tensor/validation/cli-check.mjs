#!/usr/bin/env node
// Verifies a built structure-tensor executable on both pinned examples:
// 1. 2D SHG collagen dermis image checked against apps/structure-tensor/validation/reference.json
// 2. 3D synthetic fibre stack checking azimuth, elevation, coherency, RGB TIFF, and NIfTI vectors.
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
import { decode as decodePng } from "fast-png";
import { readTiff } from "../src/tiff.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const examples = JSON.parse(readFileSync(join(repoRoot, "apps/structure-tensor/examples.json"), "utf8"));
const reference = JSON.parse(readFileSync(join(repoRoot, "apps/structure-tensor/validation/reference.json"), "utf8")).example;

const { values } = parseArgs({ options: { executable: { type: "string" } } });
const command = values.executable
  ? [resolve(values.executable)]
  : [process.execPath, resolve(here, "../bin/structure-tensor.js")];

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

function angleDiff(a, b) {
  return ((((a - b) % 180) + 270) % 180) - 90;
}

function readTiffData(filePath) {
  const buf = readFileSync(filePath);
  return readTiff(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

const work = mkdtempSync(join(tmpdir(), "structure-tensor-cli-check-"));
try {
  // 1. Offline self-check
  const selfCheck = runExe(["self-check"]);
  const info = JSON.parse(selfCheck.stdout);
  assert.equal(info.ok, true);
  assert.ok(Math.abs(info.testAngleDeg - 45) < 1e-3);

  // 2. Prefetch both pinned examples into tmpdir()
  const shgEntry = examples.find((e) => e.id === "shg-dermis").files[0];
  const fibEntry = examples.find((e) => e.id === "synthetic-3d").files[0];
  const shgPath = await fetchPinned(shgEntry, join(work, shgEntry.name));
  const fibPath = await fetchPinned(fibEntry, join(work, fibEntry.name));

  // 3. Run 2D SHG dermis example with reference settings
  const out2d = join(work, "out-2d");
  runExe([
    shgPath,
    out2d,
    "--sigma", String(reference.settings.sigma),
    "--rho", String(reference.settings.rho),
    "--min-coherency", String(reference.settings.minCoherency),
    "--min-energy", String(reference.settings.minEnergy),
    "--offline",
  ]);

  const summary2d = JSON.parse(readFileSync(join(out2d, "skin12_shg_polarisation_sum_summary.json"), "utf8"));
  assert.equal(summary2d.dimensions, 2);
  assert.deepEqual(summary2d.dims, reference.dims);
  assert.equal(summary2d.countedVoxels, reference.counted);
  assert.ok(Math.abs(angleDiff(summary2d.dominant.orientation, reference.dominant.orientation)) < 1e-6);
  assert.ok(Math.abs(summary2d.dominant.coherency - reference.dominant.coherency) < 1e-6);

  const orientTiff = await readTiffData(join(out2d, "skin12_shg_polarisation_sum_orientation.tif"));
  const cohTiff = await readTiffData(join(out2d, "skin12_shg_polarisation_sum_coherency.tif"));
  const [nx] = reference.dims;
  reference.points.forEach(([x, y], k) => {
    const i = x + nx * y;
    assert.ok(Math.abs(angleDiff(orientTiff.data[i], reference.orientation[k])) < 1e-4, `point ${k} angle drift`);
    assert.ok(Math.abs(cohTiff.data[i] - reference.coherency[k]) < 1e-5, `point ${k} coherency drift`);
  });

  const hsbPng = decodePng(readFileSync(join(out2d, "skin12_shg_polarisation_sum_hsb.png")));
  assert.equal(hsbPng.width, reference.dims[0]);
  assert.equal(hsbPng.height, reference.dims[1]);

  // 4. Run 3D synthetic fibres example
  const out3d = join(work, "out-3d");
  runExe([fibPath, out3d, "--offline"]);

  const summary3d = JSON.parse(readFileSync(join(out3d, "synthetic_fibres_3d_summary.json"), "utf8"));
  assert.equal(summary3d.dimensions, 3);
  assert.deepEqual(summary3d.dims, [64, 64, 32]);
  assert.ok(summary3d.countedVoxels > 10000);

  const azTiff = await readTiffData(join(out3d, "synthetic_fibres_3d_azimuth.tif"));
  const elTiff = await readTiffData(join(out3d, "synthetic_fibres_3d_elevation.tif"));
  // Left half (x=16, y=32, z=16): azimuth ~30°, elevation ~0°; right half (x=48, y=32, z=16): azimuth ~-45°, elevation ~40°
  const leftIdx = 16 + 64 * 32 + 64 * 64 * 16;
  const rightIdx = 48 + 64 * 32 + 64 * 64 * 16;
  assert.ok(Math.abs(angleDiff(azTiff.data[leftIdx], 30)) < 3, `left azimuth ${azTiff.data[leftIdx]}`);
  assert.ok(Math.abs(elTiff.data[leftIdx]) < 3, `left elevation ${elTiff.data[leftIdx]}`);
  assert.ok(Math.abs(angleDiff(azTiff.data[rightIdx], -45)) < 3, `right azimuth ${azTiff.data[rightIdx]}`);
  assert.ok(Math.abs(elTiff.data[rightIdx] - 40) < 3, `right elevation ${elTiff.data[rightIdx]}`);

  const vecRaw = gunzipSync(readFileSync(join(out3d, "synthetic_fibres_3d_fibre_vectors.nii.gz")), { maxOutputLength: 32 * 1024 * 1024 });
  const dv = new DataView(vecRaw.buffer, vecRaw.byteOffset, vecRaw.byteLength);
  assert.equal(dv.getInt32(0, true), 348);
  assert.deepEqual([dv.getInt16(42, true), dv.getInt16(44, true), dv.getInt16(46, true), dv.getInt16(48, true)], [64, 64, 32, 3]);

  console.log(
    `PASS structure-tensor (${useUnshare ? "unshare -rn" : "offline"}): 2D dominant=${summary2d.dominant.orientation.toFixed(2)}° (counted=${summary2d.countedVoxels}), 3D left=(${azTiff.data[leftIdx].toFixed(1)}°, ${elTiff.data[leftIdx].toFixed(1)}°) right=(${azTiff.data[rightIdx].toFixed(1)}°, ${elTiff.data[rightIdx].toFixed(1)}°)`,
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
