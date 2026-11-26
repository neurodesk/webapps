import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { createNiftiFromVolume, parseNiftiHeader } from "@neurodesk/webapp-components/file-io";
import { stackNifti, stackTiff } from "../src/format.js";
import { niftiAffine, readVolume } from "../src/input.js";
import {
  checkInstallation,
  claimOutputDir,
  commitOutputs,
  deconvolveFile,
  gunzipBounded,
  parseCliOptions,
} from "../src/node.js";

const BIN = fileURLToPath(new URL("../bin/deconvolution.js", import.meta.url));

function runBin(args) {
  return spawnSync(process.execPath, [BIN, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
}

test("parseCliOptions validates enums, ranges, odd PSF sizes and rejects empty flags", () => {
  const defaults = parseCliOptions({});
  assert.equal(defaults.settings.method, "rl");
  assert.equal(defaults.settings.iterations, 20);
  assert.equal(defaults.optics.modality, "widefield");

  assert.throws(() => parseCliOptions({ method: "" }), /non-empty/);
  assert.throws(() => parseCliOptions({ modality: "lightsheet" }), /--modality must be one of/);
  assert.throws(() => parseCliOptions({ iterations: "0" }), /between 1 and/);
  assert.throws(() => parseCliOptions({ iterations: "2.5" }), /integer/);
  assert.throws(() => parseCliOptions({ "tv-weight": "0.5" }), /between 0.0001 and/);
  assert.throws(() => parseCliOptions({ "psf-xy": "10" }), /odd integer/);
  assert.throws(() => parseCliOptions({ "psf-z": "4" }), /odd integer/);
  assert.throws(() => parseCliOptions({ na: "1.6", "immersion-index": "1.33" }), /below the immersion index/);
});

test("CLI rejects disallowed flags on self-check and download-models", () => {
  assert.equal(runBin(["--help"]).status, 0);
  const sc = runBin(["self-check"]);
  assert.equal(sc.status, 0, sc.stderr);
  assert.equal(JSON.parse(sc.stdout).ok, true);

  const scCache = runBin(["self-check", "--cache-dir", "/tmp/c"]);
  assert.equal(scCache.status, 0);
  assert.equal(JSON.parse(scCache.stdout).cacheDir, resolve("/tmp/c"));

  assert.notEqual(runBin(["self-check", "--cache-dir="]).status, 0);
  assert.notEqual(runBin(["self-check", "--iterations", "5"]).status, 0);
  assert.notEqual(runBin(["download-models", "--method", "rl"]).status, 0);
  assert.equal(runBin(["download-models", "--cache-dir", "/tmp/m"]).status, 0);
  assert.notEqual(runBin(["a.tif", "out", "--cache-dir", "/tmp/m"]).status, 0);
  assert.notEqual(runBin(["a.tif", "out", "--psf="]).status, 0);
});

test("bounded gunzip, NiBabel affine fallback, and Float32 overflow finiteness check", async () => {
  const gz = gzipSync(Buffer.alloc(512, 7));
  assert.throws(() => gunzipBounded(gz, 128), /large|limit|exceeds/i);
  const corrupt = Buffer.from(gz);
  corrupt[corrupt.length - 6] ^= 0xff;
  assert.throws(() => gunzipBounded(corrupt, 1024), /invalid gzip/i);

  // Float64 value that overflows to Infinity after Float32Array narrowing
  const f64 = new Float64Array(8);
  f64[3] = 1e39;
  const niiBuf = createNiftiFromVolume({
    hdr: { dims: [3, 2, 2, 2, 1, 1, 1, 1], pixDims: [1, 0.1, 0.1, 0.2, 1, 1, 1, 1] },
    img: f64,
  });
  const view = new DataView(niiBuf);
  view.setInt16(252, 0, true);
  view.setInt16(254, 0, true);
  const affine = niftiAffine(niiBuf);
  assert.equal(affine[0][0], -Math.fround(0.1));
  await assert.rejects(
    () => readVolume(new File([niiBuf], "overflow.nii"), { gunzip: gunzipBounded }),
    /non-finite/i,
  );
});

test("claimOutputDir locks exclusively and cleans up on error; commitOutputs rolls back on failure", async (t) => {
  const work = await mkdtemp(join(tmpdir(), "deconv-lock-"));
  t.after(() => rm(work, { recursive: true, force: true }));

  const outDir = join(work, "a", "b");
  const claim = await claimOutputDir(outDir);
  await assert.rejects(() => claimOutputDir(outDir), /locked by another/);
  await claim.release({ removeCreated: true });
  await assert.rejects(() => lstat(join(work, "a")), { code: "ENOENT" });

  const failDir = join(work, "rfail", "sub");
  await assert.rejects(
    () => claimOutputDir(failDir, { readdirFn: async () => { throw new Error("boom"); } }),
    /boom/,
  );
  await assert.rejects(() => lstat(join(work, "rfail")), { code: "ENOENT" });

  const commitDir = join(work, "commit");
  await mkdir(commitDir);
  await writeFile(join(commitDir, "first.tif"), "old");
  let count = 0;
  await assert.rejects(
    () => commitOutputs(
      commitDir,
      [
        { name: "first.tif", data: Buffer.from("new") },
        { name: "second.tif", data: Buffer.from("new2") },
      ],
      {
        overwrite: true,
        renameFn: async (src, dst) => {
          count += 1;
          if (count === 3) throw new Error("disk full");
          return rename(src, dst);
        },
      },
    ),
    /disk full/,
  );
  assert.equal(await readFile(join(commitDir, "first.tif"), "utf8"), "old");
  assert.deepEqual(await readdir(commitDir), ["first.tif"]);
});

test("deconvolveFile runs RL, RL-TV, measured PSF and preserves NIfTI qform & sform offline", async (t) => {
  const work = await mkdtemp(join(tmpdir(), "deconv-e2e-"));
  t.after(() => rm(work, { recursive: true, force: true }));

  const dims = [9, 16, 16];
  const spacing = { x: 0.1, y: 0.1, z: 0.2 };
  const data = new Float32Array(9 * 16 * 16);
  for (let z = 0; z < 9; z++) {
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const d2 = (z - 4) ** 2 + (y - 8) ** 2 + (x - 8) ** 2;
        data[(z * 16 + y) * 16 + x] = 5 + 100 * Math.exp(-d2 / 3);
      }
    }
  }

  // 1. TIFF input with RL-TV
  const inTiff = join(work, "bead.tif");
  await writeFile(inTiff, new Uint8Array(stackTiff(data, dims, spacing)));
  const outTiffDir = join(work, "out-tiff");
  const r1 = await deconvolveFile({
    input: inTiff,
    outputDir: outTiffDir,
    options: { modality: "confocal", method: "rltv", iterations: "3", "tv-weight": "0.002", "psf-xy": "5", "psf-z": "5" },
  });
  assert.equal(r1.dims.join("x"), "9x16x16");
  assert.equal(r1.psfDims.join("x"), "5x5x5");

  // 2. Gzipped NIfTI input with measured PSF, preserving both qform and sform
  const inNii = join(work, "bead.nii.gz");
  const origNii = stackNifti(data, dims, spacing);
  const origHdr = parseNiftiHeader(origNii);
  await writeFile(inNii, gzipSync(new Uint8Array(origNii)));

  const psfData = new Float32Array(5 * 5 * 5);
  psfData[(2 * 5 + 2) * 5 + 2] = 10;
  const psfPath = join(work, "measured_psf.tif");
  await writeFile(psfPath, new Uint8Array(stackTiff(psfData, [5, 5, 5], spacing)));

  const outNiiDir = join(work, "out-nii");
  const r2 = await deconvolveFile({
    input: inNii,
    outputDir: outNiiDir,
    options: { psf: psfPath, method: "rl", iterations: "2" },
  });
  assert.equal(r2.provenance.psf.source, "measured");
  const outNiiBytes = gunzipBounded(await readFile(join(outNiiDir, "bead_deconvolved.nii.gz")));
  const outHdr = parseNiftiHeader(outNiiBytes);
  assert.equal(outHdr.qformCode, origHdr.qformCode);
  assert.equal(outHdr.sformCode, origHdr.sformCode);

  const check = await checkInstallation();
  assert.equal(check.ok, true);
});

test("deconvolveFile preserves NIfTI sform diagonal [2, -3, 4] with pixdim [1, 1, 1] verbatim when no spacing override is passed", async (t) => {
  const work = await mkdtemp(join(tmpdir(), "deconv-sform-"));
  t.after(() => rm(work, { recursive: true, force: true }));

  const dims = [9, 16, 16];
  const data = new Float32Array(9 * 16 * 16).fill(10);
  data[(4 * 16 + 8) * 16 + 8] = 200;

  // Build NIfTI-1 with pixdim=[1, 1, 1] (unit=3 micrometres -> 1 um isotropic) and distinct sform diagonal [2, -3, 4] + qform!
  const niiBuf = stackNifti(data, dims, { x: 1, y: 1, z: 1 });
  const dv = new DataView(niiBuf);
  dv.setUint8(123, 3); // micrometres
  dv.setFloat32(80, 1, true);
  dv.setFloat32(84, 1, true);
  dv.setFloat32(88, 1, true);
  dv.setInt16(252, 1, true); // qform_code = 1
  dv.setFloat32(268, 11, true);
  dv.setFloat32(272, 22, true);
  dv.setFloat32(276, 33, true);
  dv.setInt16(254, 2, true); // sform_code = 2
  dv.setFloat32(280, 2, true);
  dv.setFloat32(284, 0, true);
  dv.setFloat32(288, 0, true);
  dv.setFloat32(292, 100, true);
  dv.setFloat32(296, 0, true);
  dv.setFloat32(300, -3, true);
  dv.setFloat32(304, 0, true);
  dv.setFloat32(308, 200, true);
  dv.setFloat32(312, 0, true);
  dv.setFloat32(316, 0, true);
  dv.setFloat32(320, 4, true);
  dv.setFloat32(324, 300, true);

  const inNii = join(work, "aniso_sform.nii.gz");
  await writeFile(inNii, gzipSync(new Uint8Array(niiBuf)));

  const psfData = new Float32Array(5 * 5 * 5);
  psfData[(2 * 5 + 2) * 5 + 2] = 10;
  const psfPath = join(work, "psf.tif");
  await writeFile(psfPath, new Uint8Array(stackTiff(psfData, [5, 5, 5], { x: 1, y: 1, z: 1 })));

  const outDir = join(work, "out");
  await deconvolveFile({
    input: inNii,
    outputDir: outDir,
    options: { psf: psfPath, method: "rl", iterations: "2" },
  });

  const outBytes = gunzipBounded(await readFile(join(outDir, "aniso_sform_deconvolved.nii.gz")));
  const odv = new DataView(outBytes);
  assert.equal(odv.getInt16(252, true), 1);
  assert.equal(odv.getFloat32(268, true), 11);
  assert.equal(odv.getFloat32(272, true), 22);
  assert.equal(odv.getFloat32(276, true), 33);
  assert.equal(odv.getInt16(254, true), 2);
  assert.equal(odv.getFloat32(280, true), 2);
  assert.equal(odv.getFloat32(292, true), 100);
  assert.equal(odv.getFloat32(300, true), -3);
  assert.equal(odv.getFloat32(308, true), 200);
  assert.equal(odv.getFloat32(320, true), 4);
  assert.equal(odv.getFloat32(324, true), 300);
  assert.equal(odv.getFloat32(80, true), 1);
  assert.equal(odv.getFloat32(84, true), 1);
  assert.equal(odv.getFloat32(88, true), 1);
});

test("deconvolveFile supports NIfTI-2 input and preserves qform and sform in NIfTI-2 output", async (t) => {
  const work = await mkdtemp(join(tmpdir(), "deconv-nifti2-"));
  t.after(() => rm(work, { recursive: true, force: true }));

  const dims = [9, 16, 16];
  const voxels = new Float32Array(9 * 16 * 16).fill(10);
  voxels[(4 * 16 + 8) * 16 + 8] = 200;

  const buf = new ArrayBuffer(544 + voxels.byteLength);
  const v = new DataView(buf);
  v.setInt32(0, 540, true);
  new Uint8Array(buf, 4, 8).set([0x6e, 0x2b, 0x32, 0x00, 0x0d, 0x0a, 0x1a, 0x0a]);
  v.setInt16(12, 16, true);
  v.setInt16(14, 32, true);
  v.setBigInt64(16, 3n, true);
  v.setBigInt64(24, 16n, true);
  v.setBigInt64(32, 16n, true);
  v.setBigInt64(40, 9n, true);
  for (let i = 0; i < 4; i += 1) v.setBigInt64(48 + i * 8, 1n, true);
  v.setFloat64(104, 1, true);
  v.setFloat64(112, 0.1, true);
  v.setFloat64(120, 0.1, true);
  v.setFloat64(128, 0.2, true);
  v.setBigInt64(168, 544n, true);
  v.setFloat64(176, 1, true);
  v.setFloat64(184, 0, true);
  v.setInt32(344, 1, true); // qform_code
  v.setFloat64(376, 5, true);
  v.setFloat64(384, 6, true);
  v.setFloat64(392, 7, true);
  v.setInt32(348, 2, true); // sform_code
  v.setFloat64(400, 2, true);
  v.setFloat64(440, -3, true);
  v.setFloat64(480, 4, true);
  v.setInt32(500, 3, true); // micrometres
  new Uint8Array(buf, 544).set(new Uint8Array(voxels.buffer));

  const inNii2 = join(work, "stack2.nii.gz");
  await writeFile(inNii2, gzipSync(new Uint8Array(buf)));
  const outDir = join(work, "out-nifti2");
  await deconvolveFile({
    input: inNii2,
    outputDir: outDir,
    options: { modality: "widefield", method: "rl", iterations: "2", "psf-xy": "5", "psf-z": "5" },
  });
  const outBytes = gunzipBounded(await readFile(join(outDir, "stack2_deconvolved.nii.gz")));
  const odv = new DataView(outBytes);
  assert.equal(odv.getInt32(0, true), 540, "NIfTI-2 output preserved");
  assert.equal(odv.getInt32(344, true), 1);
  assert.equal(odv.getFloat64(376, true), 5);
  assert.equal(odv.getInt32(348, true), 2);
  assert.equal(odv.getFloat64(400, true), 2);
  assert.equal(odv.getFloat64(440, true), -3);
  assert.equal(odv.getFloat64(480, true), 4);
});

test("strict Node API validation and failed-write .partial cleanup", async (t) => {
  const work = await mkdtemp(join(tmpdir(), "deconv-strict-"));
  t.after(() => rm(work, { recursive: true, force: true }));

  assert.throws(() => parseCliOptions({ bogusFlag: "1" }), /Unknown option/);
  assert.throws(() => parseCliOptions({ overwrite: "false" }), /must be a boolean/);
  assert.throws(() => parseCliOptions({ offline: "true" }), /must be a boolean/);
  await assert.rejects(() => checkInstallation({ cacheDir: "" }), /non-empty/);
  await assert.rejects(() => checkInstallation({ extra: 1 }), /Unknown option/);

  const prevOffline = process.env.NEURODESK_OFFLINE;
  try {
    process.env.NEURODESK_OFFLINE = "1";
    assert.throws(() => parseCliOptions({ offline: false }), /NEURODESK_OFFLINE=1/);
  } finally {
    if (prevOffline === undefined) delete process.env.NEURODESK_OFFLINE;
    else process.env.NEURODESK_OFFLINE = prevOffline;
  }

  const dir = join(work, "efbig");
  await mkdir(dir);
  await assert.rejects(
    () => commitOutputs(dir, [{ name: "a.tif", data: Buffer.from("abc") }], {
      writeFileFn: async (p) => {
        await writeFile(p, Buffer.from("a"));
        throw Object.assign(new Error("EFBIG"), { code: "EFBIG" });
      },
    }),
    /EFBIG/,
  );
  assert.deepEqual(await readdir(dir), []);

  // Sol r2: strict plain options, undefined unknown key, inherited prototype, null alias, symlink refusal, TOCTOU non-overwrite
  assert.throws(() => parseCliOptions(new Date()), /plain object/);
  assert.throws(() => parseCliOptions(Object.create({ overwrite: true })), /plain object/);
  assert.throws(() => parseCliOptions({ unknownKey: undefined }), /Unknown option/);
  assert.throws(() => parseCliOptions({ "voxel-xy": null }), /finite number/);
  await assert.rejects(() => checkInstallation(new Date()), /plain object/);
  await assert.rejects(() => checkInstallation({ extra: undefined }), /Unknown option/);

  // Strict NIfTI-1/2 header & NiBabel 5.3.3 quaternion parity
  const { niftiAffine } = await import("../src/input.js");
  const badMagic2 = new ArrayBuffer(544);
  new DataView(badMagic2).setInt32(0, 540, true);
  new Uint8Array(badMagic2, 4, 8).set([0x6e, 0x2b, 0x32, 0x00, 0x00, 0x0a, 0x1a, 0x0a]);
  assert.throws(() => niftiAffine(badMagic2), /NIfTI/);

  const badOff1 = new ArrayBuffer(352);
  new DataView(badOff1).setInt32(0, 348, true);
  new Uint8Array(badOff1, 344, 4).set([0x6e, 0x2b, 0x31, 0x00]);
  new DataView(badOff1).setFloat32(108, 348, true);
  assert.throws(() => niftiAffine(badOff1), /vox_offset/);
  new DataView(badOff1).setFloat32(108, 0, true);
  assert.throws(() => niftiAffine(badOff1), /vox_offset/);

  const badOff2 = new ArrayBuffer(544);
  new DataView(badOff2).setInt32(0, 540, true);
  new Uint8Array(badOff2, 4, 8).set([0x6e, 0x2b, 0x32, 0x00, 0x0d, 0x0a, 0x1a, 0x0a]);
  new DataView(badOff2).setBigInt64(168, 540n, true);
  assert.throws(() => niftiAffine(badOff2), /vox_offset/);
  new DataView(badOff2).setBigInt64(168, 0n, true);
  assert.throws(() => niftiAffine(badOff2), /vox_offset/);

  // NiBabel 5.3.3 quat2mat normalization: NIfTI-1 b = Math.fround(1 - 2^-23) => exact [1, 0, 0] first column
  const q1Buf = new ArrayBuffer(352);
  const q1 = new DataView(q1Buf);
  q1.setInt32(0, 348, true);
  new Uint8Array(q1Buf, 344, 4).set([0x6e, 0x2b, 0x31, 0x00]);
  q1.setFloat32(108, 352, true);
  q1.setFloat32(76, 1, true);
  q1.setFloat32(80, 1, true);
  q1.setFloat32(84, 1, true);
  q1.setFloat32(88, 1, true);
  q1.setInt16(252, 1, true);
  q1.setFloat32(256, Math.fround(1 - 2 ** -23), true);
  const aff1 = niftiAffine(q1Buf);
  assert.equal(aff1[0][0], 1);
  assert.equal(aff1[1][1], -1);
  assert.equal(aff1[2][2], -1);

  const q2Buf = new ArrayBuffer(544);
  const q2 = new DataView(q2Buf);
  q2.setInt32(0, 540, true);
  new Uint8Array(q2Buf, 4, 8).set([0x6e, 0x2b, 0x32, 0x00, 0x0d, 0x0a, 0x1a, 0x0a]);
  q2.setBigInt64(168, 544n, true);
  q2.setFloat64(104, 1, true);
  q2.setFloat64(112, 1, true);
  q2.setFloat64(120, 1, true);
  q2.setFloat64(128, 1, true);
  q2.setInt32(344, 1, true);
  q2.setFloat64(352, 1 + Number.EPSILON, true);
  q2.setFloat64(360, Math.sqrt(0.875 * Number.EPSILON), true);
  q2.setFloat64(368, 0, true);
  assert.ok(Number.isFinite(niftiAffine(q2Buf)[0][0]));
  q2.setFloat64(352, 1 + 2 * Number.EPSILON, true);
  q2.setFloat64(360, 0, true);
  assert.throws(() => niftiAffine(q2Buf), /Invalid NIfTI quaternion/);

  // Sol r3: non-enumerable & symbol keys, failed unlink rollback, missing backup lock retention, !overwrite never using renameFn, raced symlink
  const nonEnum = {};
  Object.defineProperty(nonEnum, "hidden", { value: undefined, enumerable: false });
  assert.throws(() => parseCliOptions(nonEnum), /Unknown option/);
  assert.throws(() => parseCliOptions({ [Symbol("s")]: undefined }), /Unknown option/);

  const unlinkDir = join(work, "unlink-fail");
  const claimU = await claimOutputDir(unlinkDir, { overwrite: false });
  await assert.rejects(
    () => commitOutputs(unlinkDir, [{ name: "a.tif", data: Buffer.from("x") }], {
      overwrite: false,
      claim: claimU,
      unlinkFn: () => {
        const err = new Error("unlink denied");
        err.code = "EACCES";
        throw err;
      },
    }),
    /unlink denied/,
  );
  assert.equal(existsSync(join(unlinkDir, "a.tif")), false);
  await claimU.release({ removeCreated: true });

  const missingBkDir = join(work, "missing-bk");
  const claimBk = await claimOutputDir(missingBkDir, { overwrite: true });
  await writeFile(join(missingBkDir, "a.tif"), "orig");
  let bkPath = null;
  await assert.rejects(
    () => commitOutputs(
      missingBkDir,
      [{ name: "a.tif", data: Buffer.from("n1") }, { name: "b.tif", data: Buffer.from("n2") }],
      {
        overwrite: true,
        claim: claimBk,
        renameFn: async (src, dst) => {
          if (dst.endsWith(".backup")) {
            bkPath = dst;
            await rename(src, dst);
            return;
          }
          if (bkPath && existsSync(bkPath)) await unlink(bkPath);
          throw new Error("publish fail");
        },
      },
    ),
    /publish fail/,
  );
  await claimBk.release();
  assert.equal(existsSync(join(missingBkDir, ".neurodesk-cli.lock")), true);

  // Symlink overwrite refusal and non-overwrite TOCTOU
  const { symlink } = await import("node:fs/promises");
  await writeFile(join(work, "target.tif"), "precious");
  await symlink(join(work, "target.tif"), join(dir, "sym.tif"));
  await assert.rejects(
    () => commitOutputs(dir, [{ name: "sym.tif", data: Buffer.from("x") }], { overwrite: true }),
    /symbolic link/,
  );
  assert.equal(await readFile(join(work, "target.tif"), "utf8"), "precious");

  const racedSymDir = join(work, "raced-sym");
  const claimSym = await claimOutputDir(racedSymDir, { overwrite: true });
  await writeFile(join(racedSymDir, "a.tif"), "orig");
  await assert.rejects(
    () => commitOutputs(racedSymDir, [{ name: "a.tif", data: Buffer.from("new") }], {
      overwrite: true,
      claim: claimSym,
      renameFn: async (src, dst) => {
        if (dst.endsWith(".backup")) {
          await unlink(src);
          await symlink(join(work, "target.tif"), src);
        }
        await rename(src, dst);
      },
    }),
    /symbolic link/,
  );
  assert.equal((await lstat(join(racedSymDir, "a.tif"))).isSymbolicLink(), true);
  assert.equal(await readFile(join(work, "target.tif"), "utf8"), "precious");
  await claimSym.release();

  const raceDir = join(work, "race");
  await mkdir(raceDir);
  let renameCalled = false;
  await assert.rejects(
    () => commitOutputs(raceDir, [{ name: "out.tif", data: Buffer.from("new") }], {
      overwrite: false,
      writeFileFn: async (p, data, opts) => {
        await writeFile(p, data, opts);
        await writeFile(join(raceDir, "out.tif"), "winner");
      },
      renameFn: async (src, dst) => {
        renameCalled = true;
        await rename(src, dst);
      },
    }),
    /already exists/,
  );
  assert.equal(renameCalled, false);
  assert.equal(await readFile(join(raceDir, "out.tif"), "utf8"), "winner");
});
