import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { createNiftiFromVolume } from "@neurodesk/webapp-components/file-io";
import { unzipSync } from "fflate";
import {
  assertArchiveBudget,
  checkInstallation,
  claimOutputDir,
  commitOutputs,
  convertFiles,
  gunzipBounded,
  LOCK_NAME,
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
  assert.equal(JSON.parse(scWithCache.stdout).cacheDir, resolve("/tmp/cache"));

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

function buildNifti2Buffer(dims, pixDims, voxels, { sform = null } = {}) {
  const [nx, ny, nz] = dims;
  const buf = new ArrayBuffer(544 + voxels.byteLength);
  const v = new DataView(buf);
  v.setInt32(0, 540, true);
  new Uint8Array(buf, 4, 8).set([0x6e, 0x2b, 0x32, 0x00, 0x0d, 0x0a, 0x1a, 0x0a]);
  v.setInt16(12, 16, true); // float32
  v.setInt16(14, 32, true);
  v.setBigInt64(16, 3n, true);
  v.setBigInt64(24, BigInt(nx), true);
  v.setBigInt64(32, BigInt(ny), true);
  v.setBigInt64(40, BigInt(nz), true);
  for (let i = 0; i < 4; i += 1) v.setBigInt64(48 + i * 8, 1n, true);
  v.setFloat64(104, 1, true);
  v.setFloat64(112, pixDims[0], true);
  v.setFloat64(120, pixDims[1], true);
  v.setFloat64(128, pixDims[2], true);
  v.setBigInt64(168, 544n, true);
  v.setFloat64(176, 1, true);
  v.setFloat64(184, 0, true);
  v.setInt32(500, 2, true); // mm
  if (sform) {
    v.setInt32(348, 1, true);
    for (let r = 0; r < 3; r += 1) {
      for (let c = 0; c < 4; c += 1) {
        v.setFloat64(400 + (r * 4 + c) * 8, sform[r][c], true);
      }
    }
  }
  new Uint8Array(buf, 544).set(new Uint8Array(voxels.buffer, voxels.byteOffset, voxels.byteLength));
  return buf;
}

test("NIfTI-2 input conversion and affine precedence", async (t) => {
  const work = await mkdtemp(join(tmpdir(), "omezarr-nifti2-"));
  t.after(() => rm(work, { recursive: true, force: true }));

  const voxels = Float32Array.from({ length: 8 * 8 * 2 }, (_, i) => i + 1);
  const nifti2Fallback = buildNifti2Buffer([8, 8, 2], [2, 3, 4], voxels);
  const affFallback = niftiAffine(nifti2Fallback);
  assert.deepEqual(Array.from(affFallback[0]), [-2, 0, 0, 7]);
  assert.deepEqual(Array.from(affFallback[1]), [0, 3, 0, -10.5]);
  assert.deepEqual(Array.from(affFallback[2]), [0, 0, 4, -2]);

  const nifti2Sform = buildNifti2Buffer([8, 8, 2], [1, 1, 1], voxels, {
    sform: [[2, 0, 0, 10], [0, -3, 0, 20], [0, 0, 4, 30]],
  });
  const affSform = niftiAffine(nifti2Sform);
  assert.deepEqual(Array.from(affSform[0]), [2, 0, 0, 10]);
  assert.deepEqual(Array.from(affSform[1]), [0, -3, 0, 20]);

  const nii2Path = join(work, "vol2.nii.gz");
  await writeFile(nii2Path, gzipSync(new Uint8Array(nifti2Sform)));
  const outDir = join(work, "out");
  const res = await convertFiles({ inputs: [nii2Path], outputDir: outDir, options: { version: "0.5" } });
  assert.equal(res.summary.format, "NIfTI-2");
  assert.equal(res.summary.shape.x, 8);
  assert.equal(res.summary.shape.z, 2);
});

test("archive byte-budget rejects oversized in-memory zip plans upfront", () => {
  assert.throws(
    () => assertArchiveBudget(
      { t: 1, c: 1, z: 16, y: 8192, x: 8192 },
      "float32",
      { version: "0.5", method: "mean", chunk: 256, compressionLevel: 6 },
    ),
    /holds at most 1 GiB\. Use --format dir/,
  );
});

test("--format dir --overwrite refuses to delete an existing directory and leaves sentinel intact", async (t) => {
  const work = await mkdtemp(join(tmpdir(), "omezarr-dir-safe-"));
  t.after(() => rm(work, { recursive: true, force: true }));

  const outDir = join(work, "out");
  const existingStore = join(outDir, "phys-16bit.ome.zarr");
  await mkdir(existingStore, { recursive: true });
  const sentinel = join(existingStore, "important-sentinel.txt");
  await writeFile(sentinel, "do-not-delete");

  await assert.rejects(
    () => convertFiles({
      inputs: [join(FIXTURES, "phys-16bit.png")],
      outputDir: outDir,
      options: { format: "dir", overwrite: true },
    }),
    /Cannot overwrite existing path/,
  );
  assert.equal(await readFile(sentinel, "utf8"), "do-not-delete");
});

test("strict Node API validation, failed-write .partial cleanup, and SIGTERM lock cleanup", async (t) => {
  const work = await mkdtemp(join(tmpdir(), "omezarr-strict-"));
  t.after(() => rm(work, { recursive: true, force: true }));

  assert.throws(() => parseCliOptions({ versin: "0.5" }), /Unknown option/);
  assert.throws(() => parseCliOptions({ overwrite: "false" }), /must be a boolean/);
  assert.throws(() => parseCliOptions({ offline: "true" }), /must be a boolean/);
  await assert.rejects(() => checkInstallation({ cacheDir: "" }), /non-empty/);
  await assert.rejects(() => checkInstallation({ bogus: true }), /Unknown option/);

  const prevOffline = process.env.NEURODESK_OFFLINE;
  try {
    process.env.NEURODESK_OFFLINE = "1";
    assert.throws(() => parseCliOptions({ offline: false }), /NEURODESK_OFFLINE=1/);
  } finally {
    if (prevOffline === undefined) delete process.env.NEURODESK_OFFLINE;
    else process.env.NEURODESK_OFFLINE = prevOffline;
  }

  // Failed partial write (simulated EFBIG) still unlinks the .partial file
  const dir = join(work, "efbig");
  await mkdir(dir);
  await assert.rejects(
    () => commitOutputs(dir, [{ kind: "file", name: "a.bin", data: Buffer.from("abc") }], {
      writeFileFn: async (p) => {
        await writeFile(p, Buffer.from("a"));
        const err = new Error("file too large");
        err.code = "EFBIG";
        throw err;
      },
    }),
    /file too large/,
  );
  assert.deepEqual(await readdir(dir), []);

  // SIGTERM cleans up shared .neurodesk-cli.lock and newly created directory (POSIX only: Windows terminates child.kill('SIGTERM') without JS handlers)
  if (process.platform !== "win32") {
    const sigDir = join(work, "sigterm-out");
    const nodeUrl = new URL("../src/node.js", import.meta.url).href;
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { claimOutputDir } from ${JSON.stringify(nodeUrl)};
         await claimOutputDir(${JSON.stringify(sigDir)});
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
    // Verify shared lock file exists before SIGTERM
    await lstat(join(sigDir, LOCK_NAME));
    const exitPromise = new Promise((res) => child.on("exit", (code, signal) => res({ code, signal })));
    child.kill("SIGTERM");
    const exited = await exitPromise;
    assert.equal(exited.signal, "SIGTERM");
    await assert.rejects(() => lstat(sigDir), { code: "ENOENT" });
  }
});

test("Sol r2: signal-safe lock/overwrite rollback, atomic non-overwrite, empty-dir refusal, NIfTI-1/2 strictness, and plain options", async (t) => {
  const work = await mkdtemp(join(tmpdir(), "omezarr-r2-"));
  t.after(() => rm(work, { recursive: true, force: true }));

  // 1. Strict plain options: reject non-plain objects, unknown undefined keys, inherited props, null aliases
  assert.throws(() => parseCliOptions(new Date()), /plain object/);
  assert.throws(() => parseCliOptions(Object.create({ overwrite: true })), /plain object/);
  assert.throws(() => parseCliOptions({ unknownKey: undefined }), /Unknown option/);
  assert.throws(() => parseCliOptions({ "compression-level": null }), /integer/);
  await assert.rejects(() => checkInstallation(new Date()), /plain object/);
  await assert.rejects(() => checkInstallation({ unknownKey: undefined }), /Unknown option/);

  // 2. Symlink overwrite refusal
  const symDir = join(work, "sym-out");
  await mkdir(symDir);
  const { symlink } = await import("node:fs/promises");
  await writeFile(join(work, "target.txt"), "precious");
  await symlink(join(work, "target.txt"), join(symDir, "out.bin"));
  await assert.rejects(
    () => commitOutputs(symDir, [{ kind: "file", name: "out.bin", data: Buffer.from("new") }], { overwrite: true }),
    /symbolic link/,
  );
  assert.equal(await readFile(join(work, "target.txt"), "utf8"), "precious");

  // 3. Atomic non-overwrite TOCTOU: concurrent file created after lstat is untouched (linkSync EEXIST & ENOTSUP refusal)
  const raceDir = join(work, "race-out");
  await mkdir(raceDir);
  await assert.rejects(
    () => commitOutputs(raceDir, [{ kind: "file", name: "race.bin", data: Buffer.from("new") }], {
      overwrite: false,
      writeFileFn: async (p, data, opts) => {
        await writeFile(p, data, opts);
        await writeFile(join(raceDir, "race.bin"), "concurrent-winner");
      },
    }),
    /already exists/,
  );
  assert.equal(await readFile(join(raceDir, "race.bin"), "utf8"), "concurrent-winner");
  assert.deepEqual(await readdir(raceDir), ["race.bin"]);

  const enotsupDir = join(work, "enotsup-out");
  await mkdir(enotsupDir);
  await assert.rejects(
    () => commitOutputs(enotsupDir, [{ kind: "file", name: "race2.bin", data: Buffer.from("new") }], {
      overwrite: false,
      writeFileFn: async (p, data, opts) => {
        await writeFile(p, data, opts);
        await writeFile(join(enotsupDir, "race2.bin"), "concurrent-winner-2");
      },
      linkFn: () => {
        throw Object.assign(new Error("ENOTSUP"), { code: "ENOTSUP" });
      },
    }),
    /requires hard-link support/,
  );
  assert.equal(await readFile(join(enotsupDir, "race2.bin"), "utf8"), "concurrent-winner-2");
  assert.deepEqual(await readdir(enotsupDir), ["race2.bin"]);

  // 4. Concurrent empty-dir creation for --format dir --overwrite is atomically refused via mkdirSync
  const emptyRaceDir = join(work, "empty-dir-race");
  await mkdir(emptyRaceDir);
  const stagedSub = join(emptyRaceDir, ".sample.ome.zarr.abc.partial");
  await mkdir(stagedSub);
  await writeFile(join(stagedSub, "zarr.json"), "{}");
  await assert.rejects(
    () => commitOutputs(
      emptyRaceDir,
      [
        { kind: "file", name: "sample_summary.json", data: Buffer.from("{}") },
        { kind: "staged-dir", name: "sample.ome.zarr", stagedPath: stagedSub },
      ],
      {
        overwrite: true,
        writeFileFn: async (p, data, opts) => {
          await writeFile(p, data, opts);
          // Concurrent process creates empty directory right before publication
          await mkdir(join(emptyRaceDir, "sample.ome.zarr"));
        },
      },
    ),
    /Cannot overwrite existing path/,
  );
  assert.deepEqual(await readdir(join(emptyRaceDir, "sample.ome.zarr")), []);
  assert.deepEqual(await readdir(emptyRaceDir), ["sample.ome.zarr"]);

  // 5 & 5b. POSIX SIGTERM subprocess cleanup checks (Windows terminates child.kill('SIGTERM') without JS signal handlers)
  if (process.platform !== "win32") {
    // 5. Subprocess SIGTERM mid-overwrite restores original file from .backup and removes .neurodesk-cli.lock
    const midDir = join(work, "mid-overwrite");
    await mkdir(midDir);
    await writeFile(join(midDir, "a.bin"), "original-a");
    await writeFile(join(midDir, "b.bin"), "original-b");
    const nodeUrl = new URL("../src/node.js", import.meta.url).href;
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { rename } from "node:fs/promises";
         import { claimOutputDir, commitOutputs } from ${JSON.stringify(nodeUrl)};
         setInterval(() => {}, 1000);
         const claim = await claimOutputDir(${JSON.stringify(midDir)}, { overwrite: true });
         let calls = 0;
         await commitOutputs(${JSON.stringify(midDir)}, [
           { kind: "file", name: "a.bin", data: Buffer.from("new-a") },
           { kind: "file", name: "b.bin", data: Buffer.from("new-b") },
         ], {
           overwrite: true,
           claim,
           renameFn: async (src, dst) => {
             calls += 1;
             await rename(src, dst);
             if (calls === 2) {
               process.stdout.write("MID_BACKUP\\n");
               await new Promise(() => {});
             }
           },
         });`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    await new Promise((resolveReady, rejectReady) => {
      let out = "";
      child.stdout.on("data", (chunk) => {
        out += chunk.toString();
        if (out.includes("MID_BACKUP")) resolveReady();
      });
      child.on("error", rejectReady);
      child.on("exit", (code) => rejectReady(new Error(`child exited early: ${code}`)));
    });
    const exitPromise = new Promise((res) => child.on("exit", (code, signal) => res({ code, signal })));
    child.kill("SIGTERM");
    const exited = await exitPromise;
    assert.equal(exited.signal, "SIGTERM");
    assert.equal(await readFile(join(midDir, "a.bin"), "utf8"), "original-a");
    assert.equal(await readFile(join(midDir, "b.bin"), "utf8"), "original-b");
    assert.deepEqual((await readdir(midDir)).sort(), ["a.bin", "b.bin"]);

    // 5b. Subprocess SIGTERM during async lock acquisition defers until open settles and leaves NO stale lock
    const lockSigDir = join(work, "sig-during-open");
    const child2 = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { open } from "node:fs/promises";
         import { claimOutputDir } from ${JSON.stringify(nodeUrl)};
         await claimOutputDir(${JSON.stringify(lockSigDir)}, {
           openFn: async (p, flags, mode) => {
             const h = await open(p, flags, mode);
             process.stdout.write("CREATED_LOCK\\n");
             await new Promise((r) => setTimeout(r, 150));
             return h;
           },
         });`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    await new Promise((resolveReady, rejectReady) => {
      let out = "";
      child2.stdout.on("data", (chunk) => {
        out += chunk.toString();
        if (out.includes("CREATED_LOCK")) resolveReady();
      });
      child2.on("error", rejectReady);
      child2.on("exit", (code) => rejectReady(new Error(`child2 exited early: ${code}`)));
    });
    const exit2 = new Promise((res) => child2.on("exit", (code, signal) => res({ code, signal })));
    child2.kill("SIGTERM");
    const exited2 = await exit2;
    assert.equal(exited2.signal, "SIGTERM");
    await assert.rejects(() => lstat(lockSigDir), { code: "ENOENT" });
  }

  // 6. Strict NIfTI-1/2 validation & NiBabel 5.3.3 quaternion parity
  const badMagic2 = new ArrayBuffer(544);
  new DataView(badMagic2).setInt32(0, 540, true);
  new Uint8Array(badMagic2, 4, 8).set([0x6e, 0x2b, 0x32, 0x00, 0x00, 0x0a, 0x1a, 0x0a]);
  assert.throws(() => niftiAffine(badMagic2), /NIfTI/);

  const badOff1 = new ArrayBuffer(352);
  const dv1 = new DataView(badOff1);
  dv1.setInt32(0, 348, true);
  new Uint8Array(badOff1, 344, 4).set([0x6e, 0x2b, 0x31, 0x00]);
  dv1.setFloat32(108, 348, true);
  assert.throws(() => niftiAffine(badOff1), /vox_offset/);
  dv1.setFloat32(108, 0, true);
  assert.throws(() => niftiAffine(badOff1), /vox_offset/);

  const badOff2 = new ArrayBuffer(544);
  const dv2 = new DataView(badOff2);
  dv2.setInt32(0, 540, true);
  new Uint8Array(badOff2, 4, 8).set([0x6e, 0x2b, 0x32, 0x00, 0x0d, 0x0a, 0x1a, 0x0a]);
  dv2.setBigInt64(168, 540n, true);
  assert.throws(() => niftiAffine(badOff2), /vox_offset/);
  dv2.setBigInt64(168, 0n, true);
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

  // NiBabel 5.3.3 NIfTI-2 near-180° quaternion
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

  // 7. Sol r3: non-enumerable & symbol option keys, failed unlink rollback, missing backup lock retention,
  //    !overwrite never using renameFn, and raced symlink during --overwrite
  const nonEnum = {};
  Object.defineProperty(nonEnum, "hidden", { value: undefined, enumerable: false });
  assert.throws(() => parseCliOptions(nonEnum), /Unknown option/);
  assert.throws(() => parseCliOptions({ [Symbol("s")]: undefined }), /Unknown option/);

  const unlinkDir = join(work, "sol-r3-unlink");
  const claimU = await claimOutputDir(unlinkDir, { overwrite: false });
  await assert.rejects(
    () => commitOutputs(
      unlinkDir,
      [{ kind: "file", name: "a.bin", data: Buffer.from("x") }],
      {
        overwrite: false,
        claim: claimU,
        unlinkFn: () => {
          const err = new Error("unlink denied");
          err.code = "EACCES";
          throw err;
        },
      },
    ),
    /unlink denied/,
  );
  assert.equal(existsSync(join(unlinkDir, "a.bin")), false);
  await claimU.release({ removeCreated: true });

  const missingBkDir = join(work, "sol-r3-missing-bk");
  const claimBk = await claimOutputDir(missingBkDir, { overwrite: true });
  await writeFile(join(missingBkDir, "a.bin"), "orig");
  let bkPath = null;
  await assert.rejects(
    () => commitOutputs(
      missingBkDir,
      [
        { kind: "file", name: "a.bin", data: Buffer.from("new-a") },
        { kind: "file", name: "b.bin", data: Buffer.from("new-b") },
      ],
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
  assert.equal(existsSync(join(missingBkDir, LOCK_NAME)), true);

  const noOvDir = join(work, "sol-r3-no-ov");
  const claimNoOv = await claimOutputDir(noOvDir, { overwrite: false });
  let renameCalled = false;
  await assert.rejects(
    () => commitOutputs(
      noOvDir,
      [{ kind: "file", name: "a.bin", data: Buffer.from("new") }],
      {
        overwrite: false,
        claim: claimNoOv,
        writeFileFn: async (p, data) => {
          await writeFile(p, data);
          await writeFile(join(noOvDir, "a.bin"), "raced");
        },
        renameFn: async (src, dst) => {
          renameCalled = true;
          await rename(src, dst);
        },
      },
    ),
    /already exists/,
  );
  assert.equal(renameCalled, false);
  assert.equal(await readFile(join(noOvDir, "a.bin"), "utf8"), "raced");
  await claimNoOv.release();

  const racedSymDir = join(work, "sol-r3-sym");
  const claimSym = await claimOutputDir(racedSymDir, { overwrite: true });
  const precious = join(work, "precious.txt");
  await writeFile(precious, "keep");
  await writeFile(join(racedSymDir, "a.bin"), "old");
  await assert.rejects(
    () => commitOutputs(
      racedSymDir,
      [{ kind: "file", name: "a.bin", data: Buffer.from("new") }],
      {
        overwrite: true,
        claim: claimSym,
        renameFn: async (src, dst) => {
          if (dst.endsWith(".backup")) {
            await unlink(src);
            await symlink(precious, src);
          }
          await rename(src, dst);
        },
      },
    ),
    /symbolic link/,
  );
  assert.equal((await lstat(join(racedSymDir, "a.bin"))).isSymbolicLink(), true);
  assert.equal(await readFile(precious, "utf8"), "keep");
  await claimSym.release();
});
