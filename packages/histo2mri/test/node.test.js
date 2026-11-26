import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { link, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { mriVolume, rgbaNifti, scalarNifti } from "../src/core/nifti.js";
import { sectionsInVolume } from "../src/core/outputs.js";
import { parseStrictNiftiHeader, readStrictNiftiVolume } from "../src/nifti-io.js";
import {
  OUTPUT_LOCK_FILE,
  allocateUniqueOutputNames,
  checkInstallation,
  claimOutputDirectory,
  decodeJpegSection,
  decodePngSection,
  parseCliOptions,
  runHisto2Mri,
  writeStagedOutputs,
} from "../src/node.js";

const BIN = fileURLToPath(new URL("../bin/histo2mri.js", import.meta.url));
const NODE_MODULE_URL = new URL("../src/node.js", import.meta.url).href;

function runCli(args) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8" });
}

function buildNifti1({
  dims = [4, 4, 4],
  datatype = 16,
  bitpix = 32,
  magic = "n+1\0",
  voxOffset = 352,
  qformCode = 0,
  sformCode = 0,
  quatern = [0, 0, 0],
  qoffset = [0, 0, 0],
  srow = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]],
  pixdim = [1, 1, 1, 1, 1, 1, 1, 1],
  xyztUnits = 2,
  values = null,
} = {}) {
  const voxels = dims[0] * dims[1] * dims[2];
  const bytesPerVoxel = datatype === 64 ? 8 : datatype === 16 ? 4 : 2;
  const payloadOffset = Number.isFinite(voxOffset) && voxOffset >= 348 ? Math.trunc(voxOffset) : 352;
  const buf = new ArrayBuffer(payloadOffset + voxels * bytesPerVoxel);
  const view = new DataView(buf);
  view.setInt32(0, 348, true);
  view.setInt16(40, 3, true);
  view.setInt16(42, dims[0], true);
  view.setInt16(44, dims[1], true);
  view.setInt16(46, dims[2], true);
  view.setInt16(70, datatype, true);
  view.setInt16(72, bitpix, true);
  for (let i = 0; i < 8; i++) view.setFloat32(76 + i * 4, pixdim[i] ?? 1, true);
  view.setFloat32(108, voxOffset, true);
  view.setFloat32(112, 1, true);
  view.setFloat32(116, 0, true);
  view.setUint8(123, xyztUnits);
  view.setInt16(252, qformCode, true);
  view.setInt16(254, sformCode, true);
  for (let i = 0; i < 3; i++) view.setFloat32(256 + i * 4, quatern[i], true);
  for (let i = 0; i < 3; i++) view.setFloat32(268 + i * 4, qoffset[i], true);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) view.setFloat32(280 + (r * 4 + c) * 4, srow[r][c], true);
  }
  const u8 = new Uint8Array(buf);
  for (let i = 0; i < 4; i++) u8[344 + i] = magic.charCodeAt(i);
  if (values) {
    for (let i = 0; i < voxels; i++) {
      if (datatype === 64) view.setFloat64(payloadOffset + i * 8, values[i], true);
      else view.setFloat32(payloadOffset + i * 4, values[i], true);
    }
  }
  return u8;
}

function buildNifti2({
  dims = [4, 4, 4],
  datatype = 16,
  bitpix = 32,
  magic = [0x6e, 0x2b, 0x32, 0x00, 0x0d, 0x0a, 0x1a, 0x0a],
  voxOffset = 544,
  qformCode = 1,
  sformCode = 2,
  quatern = [0, 0, 0],
  qoffset = [-10, -20, -30],
  srow = [[1.5, 0, 0, -10], [0, 2.0, 0, -20], [0, 0, 2.5, -30]],
  pixdim = [1, 1.5, 2.0, 2.5, 1, 1, 1, 1],
  xyztUnits = 2,
} = {}) {
  const voxels = dims[0] * dims[1] * dims[2];
  const buf = new ArrayBuffer(544 + voxels * 4);
  const view = new DataView(buf);
  view.setInt32(0, 540, true);
  new Uint8Array(buf, 4, 8).set(magic);
  view.setInt16(12, datatype, true);
  view.setInt16(14, bitpix, true);
  view.setBigInt64(16, 3n, true);
  view.setBigInt64(24, BigInt(dims[0]), true);
  view.setBigInt64(32, BigInt(dims[1]), true);
  view.setBigInt64(40, BigInt(dims[2]), true);
  for (let i = 4; i < 8; i++) view.setBigInt64(16 + i * 8, 1n, true);
  for (let i = 0; i < 8; i++) view.setFloat64(104 + i * 8, pixdim[i] ?? 1, true);
  view.setBigInt64(168, BigInt(voxOffset), true);
  view.setFloat64(176, 1, true);
  view.setFloat64(184, 0, true);
  view.setInt32(344, qformCode, true);
  view.setInt32(348, sformCode, true);
  for (let i = 0; i < 3; i++) view.setFloat64(352 + i * 8, quatern[i], true);
  for (let i = 0; i < 3; i++) view.setFloat64(376 + i * 8, qoffset[i], true);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) view.setFloat64(400 + (r * 4 + c) * 8, srow[r][c], true);
  }
  view.setInt32(500, xyztUnits, true);
  for (let i = 0; i < voxels; i++) view.setFloat32(544 + i * 4, i + 1, true);
  return new Uint8Array(buf);
}

test("CLI rejects empty string flags, invalid ranges, and disallowed subcommand flags", () => {
  assert.equal(runCli(["--help"]).status, 0);

  const emptyFlag = runCli(["mri.nii.gz", "sec.tif", "out", "--slice="]);
  assert.notEqual(emptyFlag.status, 0);
  assert.match(emptyFlag.stderr, /non-empty/);

  const badAxis = runCli(["mri.nii.gz", "sec.tif", "out", "--axis=constructor"]);
  assert.notEqual(badAxis.status, 0);
  assert.match(badAxis.stderr, /axis/);

  const badContrast = runCli(["mri.nii.gz", "sec.tif", "out", "--contrast=constructor"]);
  assert.notEqual(badContrast.status, 0);
  assert.match(badContrast.stderr, /contrast/);

  const disallowed = runCli(["self-check", "--axis", "2"]);
  assert.notEqual(disallowed.status, 0);
  assert.match(disallowed.stderr, /not valid for self-check/);

  const cacheOnMain = runCli(["mri.nii.gz", "sec.tif", "out", "--cache-dir", "/tmp/x"]);
  assert.notEqual(cacheOnMain.status, 0);
  assert.match(cacheOnMain.stderr, /only valid for self-check/);
});

test("parseCliOptions validates unknown keys, types, enums, axis aliases, and schedules before I/O", () => {
  const opts = parseCliOptions({ axis: "k", slice: "50", contrast: "haematoxylin", orientation: "3", "linear-iterations": "50x20x0" });
  assert.equal(opts.axis, 2);
  assert.equal(opts.sliceIndex, 50);
  assert.equal(opts.contrast, "haematoxylin");
  assert.equal(opts.orientation, "3");
  assert.throws(() => parseCliOptions({ unknownFlag: "1" }), /Unknown option/);
  assert.throws(() => parseCliOptions(Object.create({ axis: "1" })), /plain object/);
  assert.throws(() => parseCliOptions({ axis: null }), /axis/);
  assert.throws(() => parseCliOptions({ contrast: null }), /contrast/);
  assert.throws(() => parseCliOptions({ slice: true }), /finite number/);
  assert.throws(() => parseCliOptions({ "no-deformable": "yes" }), /boolean/);
  assert.throws(() => parseCliOptions({ axis: "toString" }), /axis/);
  assert.throws(() => parseCliOptions({ contrast: "constructor" }), /contrast/);
  assert.throws(() => parseCliOptions({ contrast: "bad" }), /contrast/);
  assert.throws(() => parseCliOptions({ orientation: "9" }), /orientation/);
  assert.throws(() => parseCliOptions({ "tilt-a": "45" }), /tilt-a/);
  assert.throws(() => parseCliOptions({ "linear-iterations": "20x10" }), /linear-iterations/);
  assert.throws(() => parseCliOptions({ "linear-iterations": "fast" }), /linear-iterations/);
});

test("parseStrictNiftiHeader and readStrictNiftiVolume strictly validate magic, bitpix, vox_offset, and dims", () => {
  // Reject missing magic, ni1, ni2, and corrupted NIfTI-2 trailing magic bytes 4..7
  assert.throws(() => parseStrictNiftiHeader(buildNifti1({ magic: "\0\0\0\0" })), /Invalid NIfTI-1 magic/);
  assert.throws(() => parseStrictNiftiHeader(buildNifti1({ magic: "ni1\0" })), /Two-file NIfTI-1/);
  assert.throws(
    () => parseStrictNiftiHeader(buildNifti2({ magic: [0x6e, 0x69, 0x32, 0x00, 0, 0, 0, 0] })),
    /Two-file NIfTI-2/,
  );
  assert.throws(
    () => parseStrictNiftiHeader(buildNifti2({ magic: [0x6e, 0x2b, 0x32, 0x00, 0x00, 0x00, 0x00, 0x00] })),
    /Invalid NIfTI-2 magic/,
  );

  // Reject unknown datatype right in header parser and reject bitpix mismatch
  assert.throws(() => parseStrictNiftiHeader(buildNifti1({ datatype: 999, bitpix: 32 })), /Unsupported NIfTI datatype/);
  assert.throws(() => parseStrictNiftiHeader(buildNifti1({ datatype: 16, bitpix: 16 })), /bitpix/);

  // Reject NaN, negative, fractional, and < 352 (NIfTI-1) / < 544 (NIfTI-2) vox_offset
  assert.throws(() => parseStrictNiftiHeader(buildNifti1({ voxOffset: Number.NaN })), /vox_offset/);
  assert.throws(() => parseStrictNiftiHeader(buildNifti1({ voxOffset: -352 })), /vox_offset/);
  assert.throws(() => parseStrictNiftiHeader(buildNifti1({ voxOffset: 352.5 })), /vox_offset/);
  assert.throws(() => parseStrictNiftiHeader(buildNifti1({ voxOffset: 348 })), /vox_offset/);
  assert.throws(() => parseStrictNiftiHeader(buildNifti1({ voxOffset: 100 })), /vox_offset/);
  assert.throws(() => parseStrictNiftiHeader(buildNifti2({ voxOffset: 540 })), /vox_offset/);

  // Reject invalid dims
  const badDim = buildNifti1();
  new DataView(badDim.buffer).setInt16(42, 0, true);
  assert.throws(() => parseStrictNiftiHeader(badDim), /Invalid NIfTI dimension/);

  // 1. sform wins over qform, both preserved
  const sformWins = buildNifti1({
    qformCode: 1,
    sformCode: 2,
    qoffset: [1, 2, 3],
    srow: [[2, 0, 0, 10], [0, 2, 0, 20], [0, 0, 2, 30]],
  });
  const p1 = readStrictNiftiVolume(sformWins);
  assert.equal(p1.affine[0][3], 10);
  assert.equal(p1.header.qformCode, 1);
  assert.equal(p1.header.sformCode, 2);
  assert.equal(p1.header.qoffset[0], 1);

  // 2. qform used when sform_code === 0
  const qformOnly = buildNifti1({
    qformCode: 1,
    sformCode: 0,
    qoffset: [5, 6, 7],
    pixdim: [1, 2, 3, 4, 1, 1, 1, 1],
  });
  const p2 = readStrictNiftiVolume(qformOnly);
  assert.equal(p2.affine[0][3], 5);
  assert.equal(p2.affine[1][1], 3);

  // 3. LAS-centered fallback when both qform_code and sform_code are 0
  const fallback = buildNifti1({ dims: [5, 5, 5], qformCode: 0, sformCode: 0, pixdim: [1, 2, 2, 2, 1, 1, 1, 1] });
  const p3 = readStrictNiftiVolume(fallback);
  assert.deepEqual(p3.affine, [
    [-2, 0, 0, 4],
    [0, 2, 0, -4],
    [0, 0, 2, -4],
    [0, 0, 0, 1],
  ]);

  // 4. Float64 value overflowing Float32Array narrowing must be rejected
  const huge = new Float64Array(4 * 4 * 4).fill(1e100);
  const overflowing = buildNifti1({ datatype: 64, bitpix: 64, values: huge });
  assert.throws(() => readStrictNiftiVolume(overflowing), /non-finite intensities after Float32/);
});

test("rgbaNifti and sectionsInVolume preserve NIfTI-1/NIfTI-2 dual qform+sform and promote on dim>32767 or float32 overflow", () => {
  // 1. NIfTI-2 preservation verbatim through mriVolume -> sectionsInVolume
  const nii2Bytes = buildNifti2({
    dims: [4, 4, 4],
    qformCode: 1,
    sformCode: 2,
    quatern: [0.1, 0.2, 0.3],
    qoffset: [-11.25, -22.5, -33.75],
    srow: [[1.25, 0, 0, -11.25], [0, 1.5, 0, -22.5], [0, 0, 2.0, -33.75]],
    pixdim: [-1, 1.25, 1.5, 2.0, 1, 1, 1, 1],
    xyztUnits: 2,
  });
  const parsed2 = readStrictNiftiVolume(nii2Bytes);
  const vol2 = mriVolume(parsed2, "mri2.nii");
  const { bytes: out2 } = sectionsInVolume(vol2, []);
  const hdr2 = parseStrictNiftiHeader(out2);
  assert.equal(hdr2.niftiVersion, 2);
  assert.equal(hdr2.datatype, 2304);
  assert.equal(hdr2.bitpix, 32);
  assert.equal(hdr2.qformCode, 1);
  assert.equal(hdr2.sformCode, 2);
  assert.deepEqual(hdr2.quatern, [0.1, 0.2, 0.3]);
  assert.deepEqual(hdr2.qoffset, [-11.25, -22.5, -33.75]);
  assert.deepEqual(hdr2.srow[0], [1.25, 0, 0, -11.25]);
  assert.equal(hdr2.pixdim[0], -1);

  // 2. Float32 overflow in pixdim/sform promotes NIfTI-1 to NIfTI-2 automatically
  const hugeSform = [[1e40, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  const outOverflow = rgbaNifti(new Uint8Array(4), [1, 1, 1], hugeSform);
  const hdrOverflow = parseStrictNiftiHeader(outOverflow);
  assert.equal(hdrOverflow.niftiVersion, 2);
  assert.equal(hdrOverflow.srow[0][0], 1e40);

  // 3. dim = 32768 (> 32767) promotes automatically to NIfTI-2
  const outBigDim = rgbaNifti(new Uint8Array(32768 * 4), [32768, 1, 1], [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]);
  const hdrBigDim = parseStrictNiftiHeader(outBigDim);
  assert.equal(hdrBigDim.niftiVersion, 2);
  assert.equal(hdrBigDim.dims[1], 32768);
});

test("PNG decoder verifies chunk CRC32 (rejecting corrupted IHDR) and zeros hidden RGB under alpha === 0", () => {
  const png = new PNG({ width: 2, height: 2 });
  // Pixel 0: hidden bright RGB (250, 180, 90) with alpha === 0 -> MUST become (0, 0, 0)
  // Pixel 1: opaque (10, 20, 30, 255) -> kept as (10, 20, 30)
  // Pixel 2: semi-transparent (40, 50, 60, 128) -> kept as (40, 50, 60)
  // Pixel 3: opaque (70, 80, 90, 255) -> kept as (70, 80, 90)
  png.data = Buffer.from([
    250, 180, 90, 0,
    10, 20, 30, 255,
    40, 50, 60, 128,
    70, 80, 90, 255,
  ]);
  const validBuf = PNG.sync.write(png);
  const decoded = decodePngSection(validBuf, "alpha.png");
  assert.equal(decoded.width, 2);
  assert.equal(decoded.height, 2);
  assert.equal(decoded.channels, 3);
  assert.deepEqual([...decoded.data.slice(0, 12)], [0, 0, 0, 10, 20, 30, 40, 50, 60, 70, 80, 90]);

  // Corrupt IHDR CRC byte (offset 8 + 4 + 4 + 13 = 29..32)
  const badCrc = Uint8Array.from(validBuf);
  badCrc[31] ^= 0xff;
  assert.throws(() => decodePngSection(badCrc, "bad.png"), /IHDR.*CRC32/);

  // JPEG decode sanity
  const jpg = jpeg.encode({ width: 4, height: 4, data: new Uint8Array(4 * 4 * 4).fill(180) }, 90).data;
  const jpgSec = decodeJpegSection(jpg, "sample.jpg");
  assert.equal(jpgSec.width, 4);
  assert.equal(jpgSec.channels, 3);
});

test("allocateUniqueOutputNames avoids collisions for slice_3.png, slice.png, SLICE.png", () => {
  const allocated = allocateUniqueOutputNames(["slice_3.png", "slice.png", "SLICE.png", "slice.png"]);
  const regs = allocated.map((entry) => entry.registration);
  const lower = new Set(regs.map((r) => r.toLowerCase()));
  assert.equal(lower.size, 4, `expected 4 case-insensitive unique stems, got ${JSON.stringify(regs)}`);
  assert.equal(regs[0], "slice_3_registration.json");
  assert.equal(regs[1], "slice_registration.json");
  assert.equal(regs[2], "SLICE_2_registration.json");
  assert.equal(regs[3], "slice_4_registration.json");
});

test("self-check honors --cache-dir and exercises Greedy WASM registration offline", async () => {
  const work = await mkdtemp(join(tmpdir(), "histo2mri-self-check-"));
  try {
    const info = await checkInstallation({ cacheDir: work });
    assert.equal(info.ok, true);
    assert.equal(info.greedy, "wasm-single");
    assert.equal(info.cacheDir, work);
    assert.ok(info.phantom.nmiFinal > 1.2);

    const cli = runCli(["self-check", "--cache-dir", work]);
    assert.equal(cli.status, 0, cli.stderr);
    const parsed = JSON.parse(cli.stdout.trim());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.cacheDir, work);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("claimOutputDirectory uses shared .neurodesk-cli.lock, rejects symlinks, and cleans up on SIGTERM", async () => {
  const work = await mkdtemp(join(tmpdir(), "histo2mri-lock-"));
  try {
    assert.equal(OUTPUT_LOCK_FILE, ".neurodesk-cli.lock");
    const fresh = join(work, "fresh");
    const claim = await claimOutputDirectory(fresh);
    await assert.rejects(claimOutputDirectory(fresh), /already in use/);
    await claim.release({ removeDirIfEmpty: true });
    await assert.rejects(stat(fresh), { code: "ENOENT" });

    // Reject directory symlink as OUTPUT_DIR
    const realTarget = join(work, "real-dir");
    const linkPath = join(work, "link-dir");
    await symlink(realTarget, linkPath);
    await assert.rejects(claimOutputDirectory(linkPath), /symbolic link/);

    // SIGTERM cleans up lock and newly created dir synchronously
    if (process.platform !== "win32") {
      const sigDir = join(work, "sigterm-dir");
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { claimOutputDirectory } from ${JSON.stringify(NODE_MODULE_URL)};
           await claimOutputDirectory(${JSON.stringify(sigDir)});
           process.stdout.write("LOCKED\\n");
           setInterval(() => {}, 1000);`,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      await new Promise((resolveReady, rejectReady) => {
        let out = "";
        child.stdout.on("data", (chunk) => {
          out += chunk.toString();
          if (out.includes("LOCKED")) resolveReady();
        });
        child.on("error", rejectReady);
        child.on("exit", (code) => rejectReady(new Error(`child exited early: ${code}`)));
      });
      child.kill("SIGTERM");
      await new Promise((resolveExit) => child.on("exit", resolveExit));
      await assert.rejects(stat(sigDir), { code: "ENOENT" });
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("writeStagedOutputs enforces atomic non-overwrite, cleans failed .partial, and rolls back on mid-publication SIGTERM", async () => {
  const work = await mkdtemp(join(tmpdir(), "histo2mri-stage-"));
  try {
    // 1. Failed writeFile cleans up .partial file
    await assert.rejects(
      writeStagedOutputs(
        work,
        [{ name: "a.nii.gz", bytes: new Uint8Array([1, 2, 3]) }],
        {
          writeFileFn: async (p, bytes, opts) => {
            await writeFile(p, bytes.subarray(0, 1), opts);
            throw Object.assign(new Error("EFBIG: file too large"), { code: "EFBIG" });
          },
        },
      ),
      /EFBIG/,
    );
    assert.deepEqual(await readdir(work), []);

    // 2. Atomic non-overwrite: a file created at destination right before publish fails with EEXIST without being touched
    const racingDest = join(work, "race.nii.gz");
    await assert.rejects(
      writeStagedOutputs(
        work,
        [
          { name: "race.nii.gz", bytes: new Uint8Array([9, 9, 9]) },
          { name: "b.mat", bytes: new Uint8Array([2]) },
        ],
        {
          linkFn: async (src, dst) => {
            await writeFile(racingDest, "preexisting-data");
            return link(src, dst);
          },
        },
      ),
      /Refusing to overwrite/,
    );
    assert.equal(await readFile(racingDest, "utf8"), "preexisting-data");
    assert.deepEqual(await readdir(work), ["race.nii.gz"]);
    await rm(racingDest);

    // 3. Rollback removes only files with matching dev/ino (never an unrelated replacement file)
    let calls = 0;
    const replacementContent = "external-replacement";
    await assert.rejects(
      writeStagedOutputs(
        work,
        [
          { name: "a.nii.gz", bytes: new Uint8Array([1]) },
          { name: "b.mat", bytes: new Uint8Array([2]) },
        ],
        {
          linkFn: async (src, dst) => {
            calls += 1;
            if (calls === 1) {
              await link(src, dst);
              await rm(dst);
              await writeFile(dst, replacementContent);
              return;
            }
            throw new Error("link fail");
          },
        },
      ),
      /link fail/,
    );
    assert.equal(await readFile(join(work, "a.nii.gz"), "utf8"), replacementContent);
    assert.deepEqual(await readdir(work), ["a.nii.gz"]);

    // 4. Mid-publication SIGTERM rolls back first published file, removes remaining .partial and lock, and cleans newly created dir
    if (process.platform !== "win32") {
      const sigPubDir = join(work, "sigterm-mid-pub");
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { link } from "node:fs/promises";
           import { claimOutputDirectory, writeStagedOutputs } from ${JSON.stringify(NODE_MODULE_URL)};
           const claim = await claimOutputDirectory(${JSON.stringify(sigPubDir)});
           let n = 0;
           await writeStagedOutputs(
             claim.directory,
             [
               { name: "first.mat", bytes: new Uint8Array([1, 2]) },
               { name: "second.mat", bytes: new Uint8Array([3, 4]) },
             ],
             {
               claim,
               linkFn: async (src, dst) => {
                 n += 1;
                 if (n === 1) return link(src, dst);
                 setInterval(() => {}, 1000);
                 process.kill(process.pid, "SIGTERM");
                 await new Promise(() => {});
               },
             },
           );`,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      const exitSignal = await new Promise((resolveExit) => child.on("exit", (_code, signal) => resolveExit(signal)));
      assert.equal(exitSignal, "SIGTERM");
      await assert.rejects(stat(sigPubDir), { code: "ENOENT" });
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("runHisto2Mri registers a PNG section to a gzipped NIfTI MRI offline", async () => {
  const work = await mkdtemp(join(tmpdir(), "histo2mri-e2e-"));
  try {
    const nu = 48;
    const nv = 48;
    const nz = 7;
    const slice = new Float32Array(nu * nv);
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        const dx = (i - 24) / 1.15;
        const dy = j - 24;
        const r = Math.hypot(dx, dy);
        slice[j * nu + i] = r < 16 ? (r > 12 ? 600 : 950) : 0;
      }
    }
    const volData = new Float32Array(nu * nv * nz);
    for (let k = 0; k < nz; k++) volData.set(slice, k * nu * nv);
    const mriNii = scalarNifti(volData, [nu, nv, nz], [[1, 0, 0, -24], [0, 1, 0, -24], [0, 0, 1, -3], [0, 0, 0, 1]]);
    const mriPath = join(work, "brain.nii.gz");
    await writeFile(mriPath, gzipSync(mriNii));

    const png = new PNG({ width: nu, height: nv });
    for (let i = 0; i < nu * nv; i++) {
      const v = Math.round((slice[i] / 1000) * 255);
      png.data[i * 4] = v;
      png.data[i * 4 + 1] = v;
      png.data[i * 4 + 2] = v;
      png.data[i * 4 + 3] = 255;
    }
    const secPath = join(work, "sec01.png");
    await writeFile(secPath, PNG.sync.write(png));

    const outDir = join(work, "out");
    const result = await runHisto2Mri({
      mriPath,
      sectionPaths: [secPath],
      outputDir: outDir,
      options: {
        axis: "2",
        slice: "3",
        orientation: "0",
        "pixel-size": "1000",
        "no-refine-plane": true,
        "no-deformable": true,
        "linear-iterations": "20x10x0",
      },
    });
    for (const expected of [
      "sec01_warped_rgba.nii.gz",
      "sec01_mri_plane.nii.gz",
      "sec01_section.nii.gz",
      "sec01_affine.mat",
      "sec01_registration.json",
      "sections_in_mri.nii.gz",
    ]) {
      assert.ok(result.files.includes(expected), `missing ${expected}`);
    }
    const report = JSON.parse(await readFile(join(outDir, "sec01_registration.json"), "utf8"));
    assert.equal(report.app, "histo2mri");
    assert.ok(report.nmi.final > 1.2, `expected high NMI, got ${report.nmi.final}`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
