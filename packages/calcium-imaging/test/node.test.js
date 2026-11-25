import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { imagejDescription, writeTiffStack } from "@neurodesk/webapp-components/file-io/tiff";
import { parseShiftsCsv } from "../src/outputs.js";
import {
  checkInstallation,
  claimOutputDirectory,
  parseCliOptions,
  runCalciumImaging,
  writeStagedOutputs,
} from "../src/node.js";

const binPath = fileURLToPath(new URL("../bin/calcium-imaging.js", import.meta.url));

function runCli(args) {
  return spawnSync(process.execPath, [binPath, ...args], { encoding: "utf8" });
}

test("CLI rejects empty string flags, invalid ranges, and disallowed subcommand flags", () => {
  for (const args of [
    ["--motion=", "movie.tif", "out"],
    ["--frame-rate=", "movie.tif", "out"],
    ["--cache-dir=", "self-check"],
    ["self-check", "--motion", "rigid"],
    ["self-check", "--offline"],
    ["self-check", "extra"],
    ["movie.tif", "out", "--cache-dir", "/tmp"],
    ["movie.tif", "out", "--motion", "bogus"],
    ["movie.tif", "out", "--max-shift", "1.5"],
    ["movie.tif", "out", "--motion", "piecewise", "--patch-size", "32", "--patch-overlap", "32"],
    ["movie.tif"],
  ]) {
    const res = runCli(args);
    assert.notEqual(res.status, 0, `expected failure for ${args.join(" ")}`);
  }
  const help = runCli(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: calcium-imaging/);
});

test("parseCliOptions validates enums and numeric bounds before I/O", () => {
  assert.throws(() => parseCliOptions({ motion: "invalid" }), /Unknown motion correction/);
  assert.throws(() => parseCliOptions({ normalization: "invalid" }), /Unknown normalisation/);
  assert.throws(() => parseCliOptions({ "frame-rate": "-1" }), /Frame rate must be/);
  assert.throws(() => parseCliOptions({ "max-shift": "2.5" }), /whole number/);
  const ok = parseCliOptions({ motion: "rigid", "frame-rate": "10", "no-deconvolution": true });
  assert.equal(ok.settings.frameRate, 10);
  assert.equal(ok.settings.deconvolution, false);
});

test("self-check honors --cache-dir and runs synthetic registration offline", async () => {
  const work = await mkdtemp(join(tmpdir(), "calcium-self-check-"));
  try {
    const info = await checkInstallation({ cacheDir: work });
    assert.equal(info.ok, true);
    assert.equal(info.cacheDir, work);
    assert.equal(info.executable, process.execPath);
    const cli = runCli(["self-check", "--cache-dir", work]);
    assert.equal(cli.status, 0, cli.stderr);
    const parsed = JSON.parse(cli.stdout.trim());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.cacheDir, work);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("claimOutputDirectory enforces O_EXCL lock and cleans up newly created dir on failure", async () => {
  const work = await mkdtemp(join(tmpdir(), "calcium-lock-"));
  try {
    const fresh = join(work, "fresh");
    const claim = await claimOutputDirectory(fresh);
    await assert.rejects(claimOutputDirectory(fresh), /already in use/);
    await claim.release({ removeDirIfEmpty: true });
    await assert.rejects(stat(fresh), { code: "ENOENT" });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("writeStagedOutputs rolls back renamed outputs on mid-batch rename error", async () => {
  const work = await mkdtemp(join(tmpdir(), "calcium-stage-"));
  try {
    let calls = 0;
    await assert.rejects(
      writeStagedOutputs(
        work,
        [
          { name: "a.csv", bytes: new Uint8Array([1]) },
          { name: "b.csv", bytes: new Uint8Array([2]) },
        ],
        {
          renameFn: async (src, dst) => {
            calls += 1;
            if (calls === 2) throw new Error("rename boom");
            return rename(src, dst);
          },
        },
      ),
      /rename boom/,
    );
    assert.deepEqual(await readdir(work), []);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("end-to-end offline synthetic 2P movie runs motion correction, ROI extraction, dF/F and OASIS", async () => {
  const work = await mkdtemp(join(tmpdir(), "calcium-e2e-"));
  try {
    const width = 64;
    const height = 64;
    const frames = 40;
    const plane = width * height;
    const data = new Uint16Array(frames * plane);
    // Deterministic PRNG for realistic background texture
    let seed = 1234567;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    let ca1 = 0;
    let ca2 = 0;
    for (let f = 0; f < frames; f++) {
      const dy = f >= 20 ? 2 : 0;
      const dx = f >= 20 ? -1 : 0;
      ca1 = 0.75 * ca1 + (f === 8 || f === 24 ? 1 : 0);
      ca2 = 0.75 * ca2 + (f === 14 || f === 31 ? 1 : 0);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const sx = x - dx;
          const sy = y - dy;
          const bg = 200 + 8 * rand();
          const c1 = (120 + 600 * ca1) * Math.exp(-((sx - 20) ** 2 + (sy - 22) ** 2) / 14);
          const c2 = (120 + 550 * ca2) * Math.exp(-((sx - 42) ** 2 + (sy - 38) ** 2) / 14);
          const vessel = 90 * Math.exp(-((sx - 32) ** 2 + (sy - 14) ** 2) / 10);
          data[f * plane + y * width + x] = Math.round(bg + c1 + c2 + vessel);
        }
      }
    }
    const tiff = writeTiffStack({
      width,
      height,
      data,
      description: imagejDescription({ frames, frameInterval: 0.2, unit: "micron" }),
      pixelSize: { x: 1.0, y: 1.0 },
    });
    const inPath = join(work, "synthetic_gcamp.tif");
    await writeFile(inPath, tiff);
    const outDir = join(work, "out");
    const result = await runCalciumImaging({ input: inPath, outputDir: outDir, options: { offline: true } });
    assert.ok(result.roiCount >= 1, `expected >= 1 ROI, got ${result.roiCount}`);
    for (const suffix of [
      "_registered.tif",
      "_shifts.csv",
      "_mean.tif",
      "_max.tif",
      "_correlation.tif",
      "_rois.tif",
      "_traces.csv",
      "_rois.csv",
      "_traces.svg",
      "_shifts.svg",
      "_provenance.json",
    ]) {
      assert.ok(result.files.includes(`synthetic_gcamp${suffix}`), `missing synthetic_gcamp${suffix}`);
    }
    const shifts = parseShiftsCsv(await readFile(join(outDir, "synthetic_gcamp_shifts.csv"), "utf8"));
    assert.equal(shifts.length, frames);
    const dyDiff = Math.abs((shifts[25][0] - shifts[5][0]) - (-2));
    const dxDiff = Math.abs((shifts[25][1] - shifts[5][1]) - 1);
    assert.ok(dyDiff < 0.3 && dxDiff < 0.3, `expected recovered shift (-2, +1), got diff (${dyDiff}, ${dxDiff})`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
