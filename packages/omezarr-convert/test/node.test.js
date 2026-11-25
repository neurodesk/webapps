import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { createNiftiFromVolume } from "@neurodesk/webapp-components/file-io";
import { unzipSync } from "fflate";
import {
  checkInstallation,
  claimOutputDir,
  commitOutputs,
  convertFiles,
  gunzipBounded,
  niftiAffine,
  parseCliOptions,
} from "../src/node.js";

const BIN = fileURLToPath(new URL("../bin/omezarr-convert.js", import.meta.url));
const FIXTURES = fileURLToPath(new URL("./fixtures", import.meta.url));

function runBin(args) {
  return spawnSync(process.execPath, [BIN, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
}

test("parseCliOptions validates enums, numeric ranges and rejects empty flags", () => {
  const defaults = parseCliOptions({});
  assert.equal(defaults.settings.version, "0.5");
  assert.equal(defaults.settings.method, "mean");
  assert.equal(defaults.settings.chunk, 256);
  assert.equal(defaults.settings.compressionLevel, 6);
  assert.equal(defaults.format, "archive");

  assert.throws(() => parseCliOptions({ version: "" }), /non-empty/);
  assert.throws(() => parseCliOptions({ method: "  " }), /non-empty/);
  assert.throws(() => parseCliOptions({ version: "0.3" }), /--version must be one of/);
  assert.throws(() => parseCliOptions({ method: "cubic" }), /--method must be one of/);
  assert.throws(() => parseCliOptions({ chunk: "200" }), /--chunk must be one of/);
  assert.throws(() => parseCliOptions({ chunk: "128.5" }), /integer/);
  assert.throws(() => parseCliOptions({ "compression-level": "10" }), /0 to 9/);
  assert.throws(() => parseCliOptions({ "compression-level": "-1" }), /0 to 9/);
  assert.throws(() => parseCliOptions({ format: "tar" }), /--format must be one of/);
});

test("CLI rejects disallowed flags on self-check and download-models and empty flags", () => {
  const help = runBin(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: omezarr-convert/);

  const sc = runBin(["self-check"]);
  assert.equal(sc.status, 0, sc.stderr);
  const info = JSON.parse(sc.stdout);
  assert.equal(info.ok, true);
  assert.equal(info.executable, process.execPath);
  assert.equal(info.node, process.version);

  const scWithCache = runBin(["self-check", "--cache-dir", "/tmp/cache"]);
  assert.equal(scWithCache.status, 0, scWithCache.stderr);
  assert.equal(JSON.parse(scWithCache.stdout).cacheDir, "/tmp/cache");

  assert.notEqual(runBin(["self-check", "--cache-dir="]).status, 0);
  assert.notEqual(runBin(["self-check", "--method", "mean"]).status, 0);
  assert.notEqual(runBin(["self-check", "extra"]).status, 0);
  assert.notEqual(runBin(["download-models", "--method", "mean"]).status, 0);
  assert.notEqual(runBin(["download-models", "--cache-dir="]).status, 0);
  assert.equal(runBin(["download-models", "--cache-dir", "/tmp/models"]).status, 0);
  assert.notEqual(runBin(["in.tif", "out", "--cache-dir", "/tmp/models"]).status, 0);
  assert.notEqual(runBin(["in.tif", "out", "--version="]).status, 0);
});

test("gunzipBounded enforces maxOutputLength and CRC32 validation", () => {
  const payload = Buffer.alloc(1024, 0x41);
  const gz = gzipSync(payload);
  assert.equal(gunzipBounded(gz, 2048).byteLength, 1024);
  assert.throws(() => gunzipBounded(gz, 512), /exceeds|limit|large/i);
  const corrupted = Buffer.from(gz);
  corrupted[corrupted.length - 5] ^= 0xff;
  assert.throws(() => gunzipBounded(corrupted, 2048), /invalid gzip stream/i);
});

test("niftiAffine follows NiBabel sform > qform > LAS-centered fallback precedence", () => {
  const buf = createNiftiFromVolume({
    hdr: { dims: [3, 4, 6, 8, 1, 1, 1, 1], pixDims: [1, 2, 3, 4, 1, 1, 1, 1] },
    img: new Float32Array(4 * 6 * 8),
  });
  const view = new DataView(buf);
  view.setInt16(252, 0, true);
  view.setInt16(254, 0, true);
  const affine = niftiAffine(buf);
  assert.deepEqual(Array.from(affine[0]), [-2, 0, 0, 3]);
  assert.deepEqual(Array.from(affine[1]), [0, 3, 0, -7.5]);
  assert.deepEqual(Array.from(affine[2]), [0, 0, 4, -14]);
});

test("claimOutputDir enforces O_EXCL lock and cleans up lock and newly created dir on error", async (t) => {
  const work = await mkdtemp(join(tmpdir(), "omezarr-lock-"));
  t.after(() => rm(work, { recursive: true, force: true }));

  const outDir = join(work, "nested", "out");
  const first = await claimOutputDir(outDir);
  await assert.rejects(() => claimOutputDir(outDir), /locked by another running/);
  await first.release({ removeCreated: true });
  await assert.rejects(() => lstat(join(work, "nested")), { code: "ENOENT" });

  // Simulate readdir failure: lock and newly created directory must both be cleaned up.
  const failingDir = join(work, "readdir-fail", "child");
  await assert.rejects(
    () => claimOutputDir(failingDir, { readdirFn: async () => { throw new Error("simulated EIO"); } }),
    /simulated EIO/,
  );
  await assert.rejects(() => lstat(join(work, "readdir-fail")), { code: "ENOENT" });

  // Non-empty directory refusal without --overwrite.
  const occupied = join(work, "occupied");
  await mkdir(occupied);
  await writeFile(join(occupied, "keep.txt"), "keep");
  await assert.rejects(() => claimOutputDir(occupied, { overwrite: false }), /not empty/);
  assert.deepEqual(await readdir(occupied), ["keep.txt"]);
});

test("commitOutputs stages .partial files and rolls back already-renamed outputs on failure", async (t) => {
  const work = await mkdtemp(join(tmpdir(), "omezarr-commit-"));
  t.after(() => rm(work, { recursive: true, force: true }));

  await writeFile(join(work, "a.bin"), "original-a");
  let renames = 0;
  await assert.rejects(
    () => commitOutputs(
      work,
      [
        { kind: "file", name: "a.bin", data: Buffer.from("new-a") },
        { kind: "file", name: "b.bin", data: Buffer.from("new-b") },
      ],
      {
        overwrite: true,
        renameFn: async (src, dst) => {
          renames += 1;
          // 1st rename backs up a.bin, 2nd renames a.bin.partial -> a.bin, 3rd fails on b.bin.partial -> b.bin
          if (renames === 3) throw new Error("simulated rename failure");
          return rename(src, dst);
        },
      },
    ),
    /simulated rename failure/,
  );
  assert.equal(await readFile(join(work, "a.bin"), "utf8"), "original-a");
  assert.deepEqual(await readdir(work), ["a.bin"]);
});

test("convertFiles converts local TIFF, PNG, and gzipped NIfTI fixtures offline", async (t) => {
  const work = await mkdtemp(join(tmpdir(), "omezarr-e2e-"));
  t.after(() => rm(work, { recursive: true, force: true }));

  const outTiff = join(work, "tiff-out");
  const resTiff = await convertFiles({
    inputs: [join(FIXTURES, "bioformats-style.ome.tif")],
    outputDir: outTiff,
    options: { version: "0.5", method: "mean", chunk: "128" },
  });
  assert.equal(resTiff.summary.ngffVersion, "0.5");
  const entries = unzipSync(new Uint8Array(await readFile(resTiff.primaryOutput)));
  assert.ok("zarr.json" in entries);

  const outDirMode = join(work, "dir-out");
  const resDir = await convertFiles({
    inputs: [join(FIXTURES, "phys-16bit.png")],
    outputDir: outDirMode,
    options: { version: "0.4", method: "nearest", format: "dir" },
  });
  const zattrs = JSON.parse(await readFile(join(resDir.primaryOutput, ".zattrs"), "utf8"));
  assert.equal(zattrs.multiscales[0].version, "0.4");

  // Gzipped NIfTI input
  const niiPath = join(work, "vol.nii.gz");
  const niiBuf = createNiftiFromVolume({
    hdr: { dims: [3, 8, 8, 2, 1, 1, 1, 1], pixDims: [1, 0.5, 0.5, 1.0, 1, 1, 1, 1] },
    img: Float32Array.from({ length: 128 }, (_, i) => i),
  });
  await writeFile(niiPath, gzipSync(new Uint8Array(niiBuf)));
  const outNii = join(work, "nii-out");
  const resNii = await convertFiles({
    inputs: [niiPath],
    outputDir: outNii,
    options: { version: "0.5" },
  });
  assert.equal(resNii.summary.format, "NIfTI");
  assert.equal(resNii.summary.shape.z, 2);

  const check = await checkInstallation();
  assert.equal(check.ok, true);
});
