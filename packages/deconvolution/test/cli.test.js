import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  assert.equal(JSON.parse(scCache.stdout).cacheDir, "/tmp/c");

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
