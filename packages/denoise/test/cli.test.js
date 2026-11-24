import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkInstallation, denoiseFile, parseCliOptions } from "../src/node.js";
import { createNormalRng, createRng } from "../src/core/rng.js";
import { stackNifti, stackTiff } from "../src/format.js";
import { readVolume } from "../src/input.js";

const BIN = fileURLToPath(new URL("../bin/denoise.js", import.meta.url));

function syntheticTiff(dims, sigma = 8, seed = 11) {
  const [nz, ny, nx] = dims;
  const data = new Float32Array(nz * ny * nx);
  const randn = createNormalRng(createRng(seed));
  for (let z = 0; z < nz; z += 1) {
    for (let y = 0; y < ny; y += 1) {
      for (let x = 0; x < nx; x += 1) {
        data[(z * ny + y) * nx + x] = 60 + 35 * Math.sin(x / 4) * Math.cos(y / 4) + randn() * sigma;
      }
    }
  }
  return new Uint8Array(stackTiff(data, dims, { x: 0.3, y: 0.3, z: 0 }));
}

test("parseCliOptions validates flags and defaults", () => {
  const parsed = parseCliOptions({ method: "fgr-gbdt", trees: "40", depth: "3", "max-scale": "4", residual: true });
  assert.equal(parsed.settings.method, "fgr-gbdt");
  assert.equal(parsed.settings.nTrees, 40);
  assert.equal(parsed.settings.maxDepth, 3);
  assert.equal(parsed.settings.maxScale, 4);
  assert.equal(parsed.residual, true);
  assert.equal(parsed.format, "auto");

  assert.throws(() => parseCliOptions({ format: "png" }), /--format/);
  assert.throws(() => parseCliOptions({ method: "zs-n2n", iterations: "12.5" }), /integer/);
});

test("checkInstallation passes offline self-check", async () => {
  const info = await checkInstallation();
  assert.equal(info.ok, true);
  assert.equal(info.package, "@neurodesk/denoise");
  assert.deepEqual(info.methods, ["fgr-gbdt", "fgr-ridge", "zs-n2n", "vst-nlm"]);
});

test("denoiseFile writes calibrated TIFF/NIfTI, residual, and provenance, and guards non-empty dirs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "denoise-node-test-"));
  try {
    const inputPath = join(dir, "sample.tif");
    await writeFile(inputPath, syntheticTiff([1, 32, 32]));
    const outDir = join(dir, "out");

    const res = await denoiseFile({
      input: inputPath,
      outputDir: outDir,
      options: { method: "fgr-ridge", "max-scale": "4", format: "both", residual: true },
    });

    assert.equal(res.outputs.length, 5);
    assert.ok(res.diagnostics.noiseFloorDropDb > 0);

    const outTiff = await readVolume(new File([await readFile(join(outDir, "sample_denoised.tif"))], "sample_denoised.tif"));
    assert.deepEqual(outTiff.dims, [1, 32, 32]);
    assert.ok(Math.abs(outTiff.spacingUm.x - 0.3) < 1e-4);

    // Refuses non-empty output directory without --overwrite.
    await assert.rejects(
      () => denoiseFile({ input: inputPath, outputDir: outDir, options: { method: "fgr-ridge" } }),
      /not empty/i,
    );

    // Succeeds with --overwrite.
    const rerun = await denoiseFile({
      input: inputPath,
      outputDir: outDir,
      options: { method: "fgr-ridge", overwrite: true },
    });
    assert.ok(rerun.outputs.length >= 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI executable supports --help, self-check, download-models, and denoising", async () => {
  const help = spawnSync(process.execPath, [BIN, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: denoise/);

  const self = spawnSync(process.execPath, [BIN, "self-check"], { encoding: "utf8" });
  assert.equal(self.status, 0);
  assert.equal(JSON.parse(self.stdout).ok, true);

  const dl = spawnSync(process.execPath, [BIN, "download-models"], { encoding: "utf8" });
  assert.equal(dl.status, 0);
  assert.match(dl.stdout, /0 model files/);

  const dir = await mkdtemp(join(tmpdir(), "denoise-bin-test-"));
  try {
    const inputPath = join(dir, "cells.tif");
    await writeFile(inputPath, syntheticTiff([1, 24, 24]));
    const outDir = join(dir, "results");
    const run = spawnSync(process.execPath, [BIN, inputPath, outDir, "--method", "vst-nlm", "--noise-model", "gaussian"], {
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout.trim(), /cells_denoised\.tif$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent CLI runs to the same empty output directory cannot overwrite each other", async () => {
  const dir = await mkdtemp(join(tmpdir(), "denoise-race-test-"));
  try {
    const inputPath = join(dir, "sample.tif");
    await writeFile(inputPath, syntheticTiff([1, 48, 48]));
    const outDir = join(dir, "shared-out");
    await mkdir(outDir);

    const runAsync = (args) =>
      new Promise((resolvePromise) => {
        const child = spawn(process.execPath, [BIN, ...args], { stdio: ["ignore", "pipe", "pipe"] });
        let stderr = "";
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.on("close", (code) => resolvePromise({ code, stderr }));
      });

    const [a, b] = await Promise.all([
      runAsync([inputPath, outDir, "--method", "fgr-gbdt", "--trees", "30", "--max-scale", "4"]),
      runAsync([inputPath, outDir, "--method", "vst-nlm", "--noise-model", "gaussian"]),
    ]);

    const successes = [a, b].filter((r) => r.code === 0);
    const failures = [a, b].filter((r) => r.code !== 0);
    assert.equal(successes.length, 1, `expected exactly 1 winner, got a=${a.code} b=${b.code}`);
    assert.equal(failures.length, 1);
    assert.match(failures[0].stderr, /locked|not empty/i);

    const entries = await readdir(outDir);
    assert.deepEqual(entries.sort(), ["sample_denoised.tif", "sample_provenance.json"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a blocked target path leaves no partial image or staged files behind", async () => {
  const dir = await mkdtemp(join(tmpdir(), "denoise-atomic-test-"));
  try {
    const inputPath = join(dir, "sample.tif");
    await writeFile(inputPath, syntheticTiff([1, 24, 24]));
    const outDir = join(dir, "out");
    await mkdir(outDir);
    await mkdir(join(outDir, "sample_provenance.json"));

    await assert.rejects(
      () => denoiseFile({
        input: inputPath,
        outputDir: outDir,
        options: { method: "fgr-ridge", "max-scale": "4", overwrite: true },
      }),
      /is a directory/i,
    );

    const entries = await readdir(outDir);
    assert.deepEqual(entries, ["sample_provenance.json"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("single-axis XY calibration in a 2D+T OME-TIFF is preserved without fabricating the unspecified axis", async () => {
  const dir = await mkdtemp(join(tmpdir(), "denoise-single-axis-test-"));
  try {
    const dims = [3, 24, 24];
    const data = new Float32Array(3 * 24 * 24);
    const randn = createNormalRng(createRng(19));
    for (let i = 0; i < data.length; i += 1) data[i] = 50 + 20 * Math.sin(i / 7) + randn() * 4;
    const tiffBytes = stackTiff(data, dims, { x: 0.25, y: null, z: null }, { axisKind: "t", frameInterval: 0.5 });

    const inVol = await readVolume(new File([tiffBytes], "movie.ome.tif"));
    assert.equal(inVol.axisKind, "t");
    assert.ok(Math.abs(inVol.spacingUm.x - 0.25) < 1e-6);
    assert.equal(inVol.spacingUm.y, null);
    assert.ok(Math.abs(inVol.frameInterval - 0.5) < 1e-6);

    const inputPath = join(dir, "movie.ome.tif");
    await writeFile(inputPath, new Uint8Array(tiffBytes));
    const outDir = join(dir, "out");
    await denoiseFile({
      input: inputPath,
      outputDir: outDir,
      options: { method: "vst-nlm", "noise-model": "gaussian", format: "auto" },
    });

    const outBytes = await readFile(join(outDir, "movie_denoised.tif"));
    const xmlText = Buffer.from(outBytes).toString("latin1");
    assert.match(xmlText, /<Channel ID="Channel:0" SamplesPerPixel="1"\/>/);
    assert.match(xmlText, /<TiffData FirstC="0" FirstT="0" FirstZ="0" IFD="0" PlaneCount="3"\/>/);

    const outVol = await readVolume(new File([outBytes], "movie_denoised.tif"));
    assert.equal(outVol.axisKind, "t");
    assert.deepEqual(outVol.dims, [3, 24, 24]);
    assert.ok(Math.abs(outVol.spacingUm.x - 0.25) < 1e-6);
    assert.equal(outVol.spacingUm.y, null);
    assert.ok(Math.abs(outVol.frameInterval - 0.5) < 1e-6);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readVolume rejects rank-4 NIfTI with non-temporal 4th-axis units (Hz, ppm, rad/s)", async () => {
  const data = new Float32Array(3 * 16 * 16).fill(10);
  const base = stackNifti(data, [3, 16, 16], { x: 1, y: 1, z: 1 }, { axisKind: "t", frameInterval: 1 });
  for (const [code, label] of [[32, /Hz/], [40, /ppm/], [48, /rad\/s/]]) {
    const copy = base.slice(0);
    new DataView(copy).setUint8(123, 2 | code);
    await assert.rejects(
      () => readVolume(new File([copy], "spectrum.nii")),
      label,
    );
  }
});

test("denoiseFile enforces maxFileBytes before reading file bytes into memory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "denoise-limit-test-"));
  try {
    const inputPath = join(dir, "big.tif");
    await writeFile(inputPath, syntheticTiff([1, 32, 32]));
    const outDir = join(dir, "out");
    await assert.rejects(
      () => denoiseFile({ input: inputPath, outputDir: outDir, maxBytes: 1024, maxFileBytes: 1024 }),
      /too large/i,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a late rename failure rolls back newly published files and restores overwritten outputs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "denoise-rollback-test-"));
  try {
    const inputPath = join(dir, "sample.tif");
    await writeFile(inputPath, syntheticTiff([1, 24, 24]));

    // Case A: fresh directory — fail on provenance rename after denoised TIFF moved.
    const freshOut = join(dir, "fresh");
    await mkdir(freshOut);
    await assert.rejects(
      () => denoiseFile({
        input: inputPath,
        outputDir: freshOut,
        options: { method: "fgr-ridge", "max-scale": "4" },
        renameFn: async (src, dst) => {
          if (dst.endsWith("sample_provenance.json")) {
            const err = new Error("EACCES: permission denied");
            err.code = "EACCES";
            throw err;
          }
          return rename(src, dst);
        },
      }),
      /EACCES/,
    );
    assert.deepEqual(await readdir(freshOut), []);

    // Case B: --overwrite directory — restore prior TIFF and provenance verbatim on failure.
    const overwriteOut = join(dir, "existing");
    await mkdir(overwriteOut);
    const oldTiff = Buffer.from("prior-denoised-tiff-bytes");
    const oldProv = '{"methodId":"prior"}\n';
    await writeFile(join(overwriteOut, "sample_denoised.tif"), oldTiff);
    await writeFile(join(overwriteOut, "sample_provenance.json"), oldProv, "utf8");

    await assert.rejects(
      () => denoiseFile({
        input: inputPath,
        outputDir: overwriteOut,
        options: { method: "fgr-ridge", "max-scale": "4", overwrite: true },
        renameFn: async (src, dst) => {
          if (dst === join(overwriteOut, "sample_provenance.json")) {
            const err = new Error("EACCES: permission denied");
            err.code = "EACCES";
            throw err;
          }
          return rename(src, dst);
        },
      }),
      /EACCES/,
    );
    assert.deepEqual((await readdir(overwriteOut)).sort(), ["sample_denoised.tif", "sample_provenance.json"]);
    assert.deepEqual(await readFile(join(overwriteOut, "sample_denoised.tif")), oldTiff);
    assert.equal(await readFile(join(overwriteOut, "sample_provenance.json"), "utf8"), oldProv);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stale lock from a dead local PID is safely recovered while a live-PID lock is respected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "denoise-stale-lock-test-"));
  try {
    const inputPath = join(dir, "sample.tif");
    await writeFile(inputPath, syntheticTiff([1, 24, 24]));

    // Find an unused PID by spawning and awaiting a short-lived child process.
    const child = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    const deadPid = child.pid;
    const staleOut = join(dir, "stale-out");
    await mkdir(join(staleOut, ".denoise-run.lock"), { recursive: true });
    await writeFile(
      join(staleOut, ".denoise-run.lock", "owner-dead0001.json"),
      `${JSON.stringify({ pid: deadPid, host: hostname(), startedAt: Date.now() - 10_000, token: "dead0001" })}\n`,
      "utf8",
    );
    await mkdir(join(staleOut, `.denoise-stage-${deadPid}-abcd1234`));

    // Recovery succeeds without --overwrite and cleans the empty dead staging dir.
    const recovered = await denoiseFile({
      input: inputPath,
      outputDir: staleOut,
      options: { method: "fgr-ridge", "max-scale": "4" },
    });
    assert.ok(recovered.outputs.length === 2);
    assert.deepEqual((await readdir(staleOut)).sort(), ["sample_denoised.tif", "sample_provenance.json"]);

    // A lock held by a live PID (our own PID) MUST NOT be stolen even with --overwrite.
    const liveOut = join(dir, "live-out");
    await mkdir(join(liveOut, ".denoise-run.lock"), { recursive: true });
    await writeFile(
      join(liveOut, ".denoise-run.lock", "owner-11ee0001.json"),
      `${JSON.stringify({ pid: process.pid, host: hostname(), startedAt: Date.now(), token: "11ee0001" })}\n`,
      "utf8",
    );
    await assert.rejects(
      () => denoiseFile({
        input: inputPath,
        outputDir: liveOut,
        options: { method: "fgr-ridge", "max-scale": "4", overwrite: true },
      }),
      /locked/i,
    );

    // A corrupt/foreign-host lock MUST NOT be stolen either.
    const foreignOut = join(dir, "foreign-out");
    await mkdir(join(foreignOut, ".denoise-run.lock"), { recursive: true });
    await writeFile(
      join(foreignOut, ".denoise-run.lock", "owner-f00e0001.json"),
      `${JSON.stringify({ pid: deadPid, host: "other-host.invalid", startedAt: Date.now(), token: "f00e0001" })}\n`,
      "utf8",
    );
    await assert.rejects(
      () => denoiseFile({
        input: inputPath,
        outputDir: foreignOut,
        options: { method: "fgr-ridge", "max-scale": "4", overwrite: true },
      }),
      /locked/i,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("failed rollback preserves unrestored backups, reports their path, and blocks silent deletion", async () => {
  const dir = await mkdtemp(join(tmpdir(), "denoise-rollback-preserve-test-"));
  try {
    const inputPath = join(dir, "sample.tif");
    await writeFile(inputPath, syntheticTiff([1, 24, 24]));

    const outDir = join(dir, "existing");
    await mkdir(outDir);
    const oldTiff = Buffer.from("original-tiff-payload");
    const oldProv = '{"methodId":"original-run"}\n';
    await writeFile(join(outDir, "sample_denoised.tif"), oldTiff);
    await writeFile(join(outDir, "sample_provenance.json"), oldProv, "utf8");

    let caught;
    try {
      await denoiseFile({
        input: inputPath,
        outputDir: outDir,
        options: { method: "fgr-ridge", "max-scale": "4", overwrite: true },
        renameFn: async (src, dst) => {
          if (dst === join(outDir, "sample_provenance.json")) {
            // Place a blocking directory at the provenance target so both publish and rollback fail.
            await mkdir(dst);
            const err = new Error("EACCES: permission denied");
            err.code = "EACCES";
            throw err;
          }
          return rename(src, dst);
        },
      });
    } catch (error) {
      caught = error;
    }

    assert.ok(caught, "expected publish + rollback failure");
    assert.match(caught.message, /EACCES/);
    assert.match(caught.message, /rollback failed to restore sample_provenance\.json/);
    assert.match(caught.message, /_backup/);
    assert.ok(caught.preservedBackupDir, "expected preservedBackupDir metadata");

    // The unblocked original TIFF was restored verbatim.
    assert.deepEqual(await readFile(join(outDir, "sample_denoised.tif")), oldTiff);
    // The blocked original provenance was preserved verbatim inside _backup.
    assert.equal(await readFile(join(caught.preservedBackupDir, "sample_provenance.json"), "utf8"), oldProv);

    // A subsequent run (even with --overwrite) must not delete the preserved backup.
    await assert.rejects(
      () => denoiseFile({
        input: inputPath,
        outputDir: outDir,
        options: { method: "fgr-ridge", "max-scale": "4", overwrite: true },
      }),
      /preserved backup/i,
    );
    assert.equal(await readFile(join(caught.preservedBackupDir, "sample_provenance.json"), "utf8"), oldProv);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent stale-lock recovery cannot steal a newly acquired live owner's lock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "denoise-concurrent-reclaim-test-"));
  try {
    const inputPath = join(dir, "sample.tif");
    await writeFile(inputPath, syntheticTiff([1, 24, 24]));
    const child = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    const deadPid = child.pid;

    const outDir = join(dir, "out");
    await mkdir(join(outDir, ".denoise-run.lock"), { recursive: true });
    await writeFile(
      join(outDir, ".denoise-run.lock", "owner-deadbeef.json"),
      `${JSON.stringify({ pid: deadPid, host: hostname(), startedAt: Date.now() - 10_000, token: "deadbeef" })}\n`,
      "utf8",
    );

    let contender1Paused;
    const contender1AtPause = new Promise((r) => { contender1Paused = r; });
    let releaseContender1;
    const contender1Gate = new Promise((r) => { releaseContender1 = r; });

    let contender2Publishing;
    const contender2AtPublish = new Promise((r) => { contender2Publishing = r; });
    let releaseContender2;
    const contender2Gate = new Promise((r) => { releaseContender2 = r; });

    // Contender 1 reads the dead PID lock and pauses before removing it.
    const run1 = denoiseFile({
      input: inputPath,
      outputDir: outDir,
      options: { method: "fgr-ridge", "max-scale": "4" },
      onLockInspect: async () => {
        contender1Paused();
        await contender1Gate;
      },
    });

    await contender1AtPause;

    // While Contender 1 is paused, Contender 2 reclaims the dead lock, acquires a fresh live lock,
    // and pauses mid-publish.
    const run2 = denoiseFile({
      input: inputPath,
      outputDir: outDir,
      options: { method: "vst-nlm", "noise-model": "gaussian" },
      renameFn: async (src, dst) => {
        if (dst.endsWith("sample_provenance.json")) {
          contender2Publishing();
          await contender2Gate;
        }
        return rename(src, dst);
      },
    });

    await contender2AtPublish;

    // Record Contender 2's live lock file before Contender 1 resumes.
    const liveLockEntriesBefore = await readdir(join(outDir, ".denoise-run.lock"));
    assert.equal(liveLockEntriesBefore.length, 1);
    assert.notEqual(liveLockEntriesBefore[0], "owner-deadbeef.json");

    // Resume Contender 1 — it MUST fail with locked and leave Contender 2's live lock untouched.
    releaseContender1();
    await assert.rejects(() => run1, /locked/i);

    const liveLockEntriesAfter = await readdir(join(outDir, ".denoise-run.lock"));
    assert.deepEqual(liveLockEntriesAfter, liveLockEntriesBefore);

    // Let Contender 2 finish cleanly.
    releaseContender2();
    const res2 = await run2;
    assert.equal(res2.provenance.methodId, "vst-nlm");
    assert.deepEqual((await readdir(outDir)).sort(), ["sample_denoised.tif", "sample_provenance.json"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recovering from a killed overwrite run restores both originals instead of deleting _backup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "denoise-killed-overwrite-test-"));
  try {
    const inputPath = join(dir, "sample.tif");
    await writeFile(inputPath, syntheticTiff([1, 24, 24]));
    const child = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    const deadPid = child.pid;

    const oldTiff = Buffer.from("original-tiff-before-kill");
    const oldProv = '{"methodId":"original-before-kill"}\n';

    // Simulate a run killed mid-publish: both originals are in _backup, new TIFF is already in
    // outDir, new provenance is still in stageDir, and no _committed marker exists.
    const outDir = join(dir, "out");
    const stageDir = join(outDir, `.denoise-stage-${deadPid}-1234abcd`);
    await mkdir(join(outDir, ".denoise-run.lock"), { recursive: true });
    await writeFile(
      join(outDir, ".denoise-run.lock", "owner-dead1234.json"),
      `${JSON.stringify({ pid: deadPid, host: hostname(), startedAt: Date.now() - 10_000, token: "dead1234" })}\n`,
      "utf8",
    );
    await mkdir(join(stageDir, "_backup"), { recursive: true });
    await writeFile(join(stageDir, "_meta.json"), `${JSON.stringify({ pid: deadPid, host: hostname() })}\n`, "utf8");
    await writeFile(
      join(stageDir, "_manifest.json"),
      `${JSON.stringify({ pid: deadPid, host: hostname(), stagedFiles: ["sample_denoised.tif", "sample_provenance.json"], overwrite: true })}\n`,
      "utf8",
    );
    await writeFile(join(stageDir, "_backup", "sample_denoised.tif"), oldTiff);
    await writeFile(join(stageDir, "_backup", "sample_provenance.json"), oldProv, "utf8");
    await writeFile(join(outDir, "sample_denoised.tif"), Buffer.from("partial-new-tiff-from-killed-run"));
    await writeFile(join(stageDir, "sample_provenance.json"), '{"methodId":"partial-new"}\n', "utf8");

    // Retrying without --overwrite must restore BOTH original files and refuse to overwrite them.
    await assert.rejects(
      () => denoiseFile({
        input: inputPath,
        outputDir: outDir,
        options: { method: "fgr-ridge", "max-scale": "4" },
      }),
      /not empty/i,
    );

    assert.deepEqual((await readdir(outDir)).sort(), ["sample_denoised.tif", "sample_provenance.json"]);
    assert.deepEqual(await readFile(join(outDir, "sample_denoised.tif")), oldTiff);
    assert.equal(await readFile(join(outDir, "sample_provenance.json"), "utf8"), oldProv);

    // Also test a killed fresh-directory run (no _backup, partial new TIFF in outDir):
    // retrying without --overwrite cleans the partial TIFF and succeeds cleanly.
    const freshDir = join(dir, "fresh-killed");
    const freshStage = join(freshDir, `.denoise-stage-${deadPid}-5678ef90`);
    await mkdir(join(freshDir, ".denoise-run.lock"), { recursive: true });
    await writeFile(
      join(freshDir, ".denoise-run.lock", "owner-dead5678.json"),
      `${JSON.stringify({ pid: deadPid, host: hostname(), startedAt: Date.now() - 10_000, token: "dead5678" })}\n`,
      "utf8",
    );
    await mkdir(freshStage, { recursive: true });
    await writeFile(join(freshStage, "_meta.json"), `${JSON.stringify({ pid: deadPid, host: hostname() })}\n`, "utf8");
    await writeFile(
      join(freshStage, "_manifest.json"),
      `${JSON.stringify({ pid: deadPid, host: hostname(), stagedFiles: ["sample_denoised.tif", "sample_provenance.json"], overwrite: false })}\n`,
      "utf8",
    );
    await writeFile(join(freshDir, "sample_denoised.tif"), Buffer.from("partial-fresh-tiff"));
    await writeFile(join(freshStage, "sample_provenance.json"), '{"methodId":"partial"}\n', "utf8");

    const res = await denoiseFile({
      input: inputPath,
      outputDir: freshDir,
      options: { method: "fgr-ridge", "max-scale": "4" },
    });
    assert.equal(res.outputs.length, 2);
    assert.deepEqual((await readdir(freshDir)).sort(), ["sample_denoised.tif", "sample_provenance.json"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("named pipe (FIFO) input is rejected immediately without hanging on open", { skip: process.platform === "win32" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "denoise-fifo-test-"));
  try {
    const fifoPath = join(dir, "pipe.tif");
    const mk = spawnSync("mkfifo", [fifoPath]);
    assert.equal(mk.status, 0, mk.stderr?.toString());
    const outDir = join(dir, "out");
    const started = performance.now();
    await assert.rejects(
      () => denoiseFile({ input: fifoPath, outputDir: outDir, options: { method: "fgr-ridge" } }),
      /not a regular file/i,
    );
    assert.ok(performance.now() - started < 2000, "FIFO rejection must not block");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
