#!/usr/bin/env node
// Portable release validation for @neurodesk/histo2mri.
// Prefetches the pinned AHEAD 7 T R1 MRI and coronal thionin section into tmpdir()
// BEFORE running any CLI invocation, runs offline under `unshare -rn`, and independently
// inspects raw NIfTI headers via DataView (never importing the package's own parser) for
// dimensions, datatype, payload length, verbatim MRI-grid qform/sform fidelity, and warp fields.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";

const { values } = parseArgs({ options: { executable: { type: "string" } } });
const command = values.executable
  ? [resolve(values.executable)]
  : [process.execPath, fileURLToPath(new URL("../bin/histo2mri.js", import.meta.url))];

const examples = JSON.parse(await readFile(new URL("../../../apps/histo2mri/examples.json", import.meta.url), "utf8"));
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

/** Independent raw DataView NIfTI-1 / NIfTI-2 header inspector (no package imports). */
function inspectRawNifti(gzOrRawBytes) {
  const raw = gzOrRawBytes[0] === 0x1f && gzOrRawBytes[1] === 0x8b
    ? new Uint8Array(gunzipSync(gzOrRawBytes))
    : new Uint8Array(gzOrRawBytes);
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const hdrLe = view.getInt32(0, true);
  const hdrBe = view.getInt32(0, false);
  const readAscii = (off, len) => String.fromCharCode(...raw.subarray(off, off + len));

  if (hdrLe === 348 || hdrBe === 348) {
    const le = hdrLe === 348;
    const magic = readAscii(344, 4);
    const dims = Array.from({ length: 8 }, (_, i) => view.getInt16(40 + i * 2, le));
    const intentCode = view.getInt16(68, le);
    const datatype = view.getInt16(70, le);
    const bitpix = view.getInt16(72, le);
    const pixdim = Array.from({ length: 8 }, (_, i) => view.getFloat32(76 + i * 4, le));
    const voxOffset = view.getFloat32(108, le);
    const xyztUnits = view.getUint8(123);
    const qformCode = view.getInt16(252, le);
    const sformCode = view.getInt16(254, le);
    const quatern = [view.getFloat32(256, le), view.getFloat32(260, le), view.getFloat32(264, le)];
    const qoffset = [view.getFloat32(268, le), view.getFloat32(272, le), view.getFloat32(276, le)];
    const srow = [0, 1, 2].map((r) => [0, 1, 2, 3].map((c) => view.getFloat32(280 + (r * 4 + c) * 4, le)));
    return {
      version: 1, magic, dims, intentCode, datatype, bitpix, pixdim, voxOffset, xyztUnits,
      qformCode, sformCode, quatern, qoffset, srow, payloadBytes: raw.byteLength - voxOffset,
    };
  }
  if (hdrLe === 540 || hdrBe === 540) {
    const le = hdrLe === 540;
    const magic = readAscii(4, 4);
    const datatype = view.getInt16(12, le);
    const bitpix = view.getInt16(14, le);
    const dims = Array.from({ length: 8 }, (_, i) => Number(view.getBigInt64(16 + i * 8, le)));
    const pixdim = Array.from({ length: 8 }, (_, i) => view.getFloat64(104 + i * 8, le));
    const voxOffset = Number(view.getBigInt64(168, le));
    const intentCode = view.getInt32(504, le);
    const qformCode = view.getInt32(344, le);
    const sformCode = view.getInt32(348, le);
    const quatern = [view.getFloat64(352, le), view.getFloat64(360, le), view.getFloat64(368, le)];
    const qoffset = [view.getFloat64(376, le), view.getFloat64(384, le), view.getFloat64(392, le)];
    const srow = [0, 1, 2].map((r) => [0, 1, 2, 3].map((c) => view.getFloat64(400 + (r * 4 + c) * 8, le)));
    const xyztUnits = view.getInt32(500, le);
    return {
      version: 2, magic, dims, intentCode, datatype, bitpix, pixdim, voxOffset, xyztUnits,
      qformCode, sformCode, quatern, qoffset, srow, payloadBytes: raw.byteLength - voxOffset,
    };
  }
  throw new Error(`Unrecognized NIfTI sizeof_hdr (${hdrLe}/${hdrBe}).`);
}

const arraysClose = (a, b, tol = 1e-5) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tol);

async function prefetchRole(role, workDir) {
  const file = examples[0].files.find((entry) => entry.role === role);
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

const work = await mkdtemp(join(tmpdir(), "histo2mri-cli-check-"));
try {
  // Prefetch pinned MRI + thionin section into tmpdir() before invoking CLI
  const mriPath = await prefetchRole("mri", work);
  const sectionPath = await prefetchRole("section", work);
  const mriHdr = inspectRawNifti(await readFile(mriPath));

  // 1. self-check
  const selfCheck = runCli(["self-check"]);
  check(selfCheck.status === 0, `self-check exits 0 (status ${selfCheck.status})`);
  const selfInfo = JSON.parse(selfCheck.stdout.trim());
  check(selfInfo.ok === true && selfInfo.greedy === "wasm-single", `self-check Greedy WASM verified (${selfInfo.version})`);

  // 2. Register AHEAD 152017 thionin section 150 to 7 T R1 map at coronal slice 50 offline
  const outDir = join(work, "out");
  const run = runCli([mriPath, sectionPath, outDir, "--axis", "2", "--slice", "50", "--offline"]);
  check(run.status === 0, `ahead-152017-section150 exits 0${run.status ? ` (${run.stderr.trim()})` : ""}`);

  const base = "ahead152017_thionin_section150_85um";
  const report = JSON.parse(await readFile(join(outDir, `${base}_registration.json`), "utf8"));
  check(report.app === "histo2mri", `registration.json identifies histo2mri (${report.version})`);
  check(report.nmi.final > report.nmi.initial + 0.05,
    `registration improves NMI ${report.nmi.initial.toFixed(4)} → ${report.nmi.final.toFixed(4)}`);

  const affineText = await readFile(join(outDir, `${base}_affine.mat`), "utf8");
  const rows = affineText.trim().split(/\r?\n/);
  check(rows.length === 4 && rows[3].trim().startsWith("0 0 0 1"), `affine.mat is a valid 4×4 transform`);

  const warpedHdr = inspectRawNifti(await readFile(join(outDir, `${base}_warped_rgba.nii.gz`)));
  const expectedWarpedBytes = warpedHdr.dims[1] * warpedHdr.dims[2] * warpedHdr.dims[3] * 4;
  check(
    warpedHdr.magic === "n+1\0"
      && warpedHdr.datatype === 2304
      && warpedHdr.bitpix === 32
      && warpedHdr.dims[1] > 100
      && warpedHdr.dims[2] > 100
      && warpedHdr.dims[3] === 1
      && warpedHdr.payloadBytes === expectedWarpedBytes,
    `warped RGBA NIfTI raw header & payload valid (${warpedHdr.dims.slice(1, 4).join("×")}, ${warpedHdr.payloadBytes} bytes)`,
  );

  const volHdr = inspectRawNifti(await readFile(join(outDir, "sections_in_mri.nii.gz")));
  const expectedVolBytes = mriHdr.dims[1] * mriHdr.dims[2] * mriHdr.dims[3] * 4;
  const transformsMatch =
    volHdr.version === mriHdr.version
    && volHdr.xyztUnits === mriHdr.xyztUnits
    && volHdr.qformCode === mriHdr.qformCode
    && volHdr.sformCode === mriHdr.sformCode
    && arraysClose(volHdr.pixdim.slice(0, 4), mriHdr.pixdim.slice(0, 4))
    && arraysClose(volHdr.quatern, mriHdr.quatern)
    && arraysClose(volHdr.qoffset, mriHdr.qoffset)
    && arraysClose(volHdr.srow.flat(), mriHdr.srow.flat());
  check(
    volHdr.datatype === 2304
      && volHdr.bitpix === 32
      && volHdr.dims[1] === mriHdr.dims[1]
      && volHdr.dims[2] === mriHdr.dims[2]
      && volHdr.dims[3] === mriHdr.dims[3]
      && volHdr.payloadBytes === expectedVolBytes
      && transformsMatch,
    `sections_in_mri.nii.gz matches MRI grid (${volHdr.dims.slice(1, 4).join("×")}), payload (${volHdr.payloadBytes} B), and verbatim qform/sform`,
  );

  const warpPath = join(outDir, `${base}_warp.nii.gz`);
  const warpExists = await access(warpPath).then(() => true, () => false);
  if (!report.deformableRejected) {
    check(warpExists, `deformable warp file emitted (${base}_warp.nii.gz)`);
    if (warpExists) {
      const warpHdr = inspectRawNifti(await readFile(warpPath));
      const expectedWarpBytes = warpHdr.dims[1] * warpHdr.dims[2] * warpHdr.dims[3] * 3 * 4;
      check(
        warpHdr.dims[0] === 5
          && warpHdr.dims[5] === 3
          && warpHdr.intentCode === 1007
          && warpHdr.datatype === 16
          && warpHdr.bitpix === 32
          && warpHdr.payloadBytes === expectedWarpBytes,
        `displacement field warp NIfTI raw header & payload valid (${warpHdr.dims.slice(1, 6).join("×")}, ${warpHdr.payloadBytes} B)`,
      );
    }
  } else {
    check(!warpExists, `deformable warp omitted when deformable stage rejected`);
  }
} finally {
  await rm(work, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log(`\nAll @neurodesk/histo2mri portable CLI checks passed${useUnshare ? " (network-isolated via unshare -rn)" : ""}.`);
