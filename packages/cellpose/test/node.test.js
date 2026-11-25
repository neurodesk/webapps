import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { writeTiffStack } from "@neurodesk/webapp-components/file-io/tiff";
import { MODEL_ASSETS, MODEL_IDS } from "../src/models.js";
import {
  checkInstallation,
  claimOutputDir,
  commitOutputs,
  downloadModels,
  parseCliOptions,
  resolveThreads,
  segmentFile,
} from "../src/node.js";

const BIN = fileURLToPath(new URL("../bin/cellpose.js", import.meta.url));

function runBin(args, env = process.env) {
  return spawnSync(process.execPath, [BIN, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    env,
  });
}

test("package model.manifest.json stays identical to models/cellpose.manifest.json", async () => {
  const pkgManifest = await readFile(new URL("../model.manifest.json", import.meta.url), "utf8");
  const rootManifest = await readFile(new URL("../../../models/cellpose.manifest.json", import.meta.url), "utf8");
  assert.equal(pkgManifest, rootManifest);
  assert.deepEqual([...MODEL_IDS], ["cyto3", "nuclei"]);
  assert.equal(MODEL_ASSETS.length, 2);
});

test("parseCliOptions validates models, ranges, threads and rejects empty flags", () => {
  const d = parseCliOptions({});
  assert.equal(d.model.name, "cyto3");
  assert.equal(d.settings.diameter, 30);

  const nuc = parseCliOptions({ model: "nuclei", "nuclear-channel": "2" });
  assert.equal(nuc.settings.diameter, 17);
  assert.equal(nuc.settings.nuclearChannel, 0);

  assert.throws(() => parseCliOptions({ model: "" }), /non-empty/);
  assert.throws(() => parseCliOptions({ model: "cyto2" }), /Unknown Cellpose model/);
  assert.throws(() => parseCliOptions({ channel: "0" }), /between 1 and 256/);
  assert.throws(() => parseCliOptions({ diameter: "2" }), /between 5 and 500/);
  assert.throws(() => parseCliOptions({ "flow-thresh": "5" }), /between 0 and 3/);
  assert.throws(() => parseCliOptions({ "cellprob-thresh": "7" }), /between -6 and 6/);
  assert.throws(() => parseCliOptions({ "min-size": "0" }), /between 1 and 100000/);
  assert.throws(() => parseCliOptions({ anisotropy: "0.01" }), /between 0\.1 and 20/);
  assert.throws(() => parseCliOptions({ threads: "-1" }), /positive integer/);
  assert.throws(() => parseCliOptions({ "cache-dir": "" }), /non-empty/);
  assert.equal(resolveThreads("2"), 2);
});

test("CLI rejects disallowed flags on subcommands and self-check verifies ORT CPU", async () => {
  assert.equal(runBin(["--help"]).status, 0);
  const sc = runBin(["self-check"], { ...process.env, NEURODESK_CELLPOSE_MODEL_DIR: "" });
  assert.equal(sc.status, 0, sc.stderr);
  const info = JSON.parse(sc.stdout);
  assert.equal(info.ok, true);
  assert.equal(info.executable, process.execPath);
  assert.equal(info.node, process.version);
  assert.equal(info.executionProvider, "cpu");
  assert.ok(info.onnxRuntime);

  assert.notEqual(runBin(["self-check", "--cache-dir="]).status, 0);
  assert.notEqual(runBin(["self-check", "--model", "nuclei"]).status, 0);
  assert.notEqual(runBin(["self-check", "extra"]).status, 0);
  assert.notEqual(runBin(["download-models", "--diameter", "30"]).status, 0);
  assert.notEqual(runBin(["download-models", "--cache-dir="]).status, 0);
  assert.notEqual(runBin(["a.tif", "out", "--diameter="]).status, 0);

  const check = await checkInstallation();
  assert.equal(check.ok, true);
});

test("offline downloadModels and self-check --cache-dir fail cleanly when models are missing", async (t) => {
  const emptyDir = await mkdtemp(join(tmpdir(), "cellpose-models-"));
  t.after(() => rm(emptyDir, { recursive: true, force: true }));
  await assert.rejects(() => downloadModels({ cacheDir: emptyDir, offline: true }), /missing from the offline model directory/);
  await assert.rejects(() => checkInstallation({ cacheDir: emptyDir }), /missing from the offline model directory/);
});

test("claimOutputDir locks exclusively and cleans up on error; commitOutputs rolls back on failure", async (t) => {
  const work = await mkdtemp(join(tmpdir(), "cellpose-lock-"));
  t.after(() => rm(work, { recursive: true, force: true }));

  const outDir = join(work, "nested", "out");
  const claim = await claimOutputDir(outDir);
  await assert.rejects(() => claimOutputDir(outDir), /locked by another/);
  await claim.release({ removeCreated: true });
  await assert.rejects(() => lstat(join(work, "nested")), { code: "ENOENT" });

  const failDir = join(work, "rfail", "child");
  await assert.rejects(
    () => claimOutputDir(failDir, { readdirFn: async () => { throw new Error("boom"); } }),
    /boom/,
  );
  await assert.rejects(() => lstat(join(work, "rfail")), { code: "ENOENT" });

  const commitDir = join(work, "commit");
  await mkdir(commitDir);
  await writeFile(join(commitDir, "a.tif"), "keep");
  let n = 0;
  await assert.rejects(
    () => commitOutputs(
      commitDir,
      [
        { name: "a.tif", data: Buffer.from("new-a") },
        { name: "b.csv", data: Buffer.from("new-b") },
      ],
      {
        overwrite: true,
        renameFn: async (src, dst) => {
          n += 1;
          if (n === 3) throw new Error("fail-rename");
          return rename(src, dst);
        },
      },
    ),
    /fail-rename/,
  );
  assert.equal(await readFile(join(commitDir, "a.tif"), "utf8"), "keep");
  assert.deepEqual(await readdir(commitDir), ["a.tif"]);
});

test("segmentFile runs full 2D pipeline offline with mocked batch runner and writes TIFF + CSV + JSON", async (t) => {
  const work = await mkdtemp(join(tmpdir(), "cellpose-mock-"));
  t.after(() => rm(work, { recursive: true, force: true }));

  const w = 64;
  const h = 64;
  const pixels = new Uint16Array(w * h);
  for (let y = 16; y < 48; y++) for (let x = 16; x < 48; x++) pixels[y * w + x] = 400;
  const inPath = join(work, "synth.tif");
  await writeFile(inPath, new Uint8Array(writeTiffStack({ width: w, height: h, data: pixels })));

  const outDir = join(work, "out");
  const res = await segmentFile({
    input: inPath,
    outputDir: outDir,
    options: { model: "cyto3", diameter: "30", "flow-thresh": "0", "min-size": "15" },
    runBatch: async (_inputData, batchSize, th, tw) => {
      // Synthesize radial flows converging toward tile center with positive cellprob inside a disk.
      const plane = th * tw;
      const out = new Float32Array(batchSize * 3 * plane);
      const cy = th / 2;
      const cx = tw / 2;
      for (let b = 0; b < batchSize; b++) {
        const base = b * 3 * plane;
        for (let y = 0; y < th; y++) {
          for (let x = 0; x < tw; x++) {
            const dy = cy - y;
            const dx = cx - x;
            const r = Math.hypot(dy, dx);
            const idx = y * tw + x;
            if (r <= 14) {
              out[base + idx] = r > 0 ? dy / r : 0;
              out[base + plane + idx] = r > 0 ? dx / r : 0;
              out[base + 2 * plane + idx] = 4.0;
            } else {
              out[base + 2 * plane + idx] = -4.0;
            }
          }
        }
      }
      return out;
    },
  });
  assert.equal(res.count, 1);
  assert.equal(res.outputs.length, 3);
  const csv = await readFile(join(outDir, "synth_cellpose_cells.csv"), "utf8");
  assert.match(csv, /^id,centroid_x,centroid_y,area_px,mean_intensity\n1,/);
});

test("unconditional ORT_DISABLE_TELEMETRY=1 keeps isolated HOME empty even when ORT_DISABLE_TELEMETRY=0 is inherited", async (t) => {
  const work = await mkdtemp(join(tmpdir(), "cellpose-telemetry-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  const fakeHome = join(work, "home");
  await mkdir(fakeHome);

  const run = spawnSync(process.execPath, [BIN, "self-check"], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: fakeHome,
      XDG_CONFIG_HOME: join(fakeHome, ".config"),
      XDG_CACHE_HOME: join(fakeHome, ".cache"),
      XDG_DATA_HOME: join(fakeHome, ".local", "share"),
      ORT_DISABLE_TELEMETRY: "0",
      NEURODESK_CELLPOSE_MODEL_DIR: "",
    },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).ok, true);
  assert.deepEqual(await readdir(fakeHome), [], "isolated HOME must stay completely empty (no onnxruntime telemetry)");
});

test("strict Node API validation and failed-write .partial cleanup", async (t) => {
  const work = await mkdtemp(join(tmpdir(), "cellpose-strict-"));
  t.after(() => rm(work, { recursive: true, force: true }));

  assert.throws(() => parseCliOptions({ bogus: "1" }), /Unknown option/);
  assert.throws(() => parseCliOptions({ overwrite: "false" }), /must be a boolean/);
  assert.throws(() => parseCliOptions({ offline: "true" }), /must be a boolean/);
  assert.throws(() => parseCliOptions({ do3D: "true" }), /must be a boolean/);
  await assert.rejects(() => checkInstallation({ cacheDir: "" }), /non-empty/);
  await assert.rejects(() => checkInstallation({ extra: true }), /Unknown option/);
  await assert.rejects(() => downloadModels({ cacheDir: "   " }), /non-empty/);
  await assert.rejects(() => downloadModels({ unknownKey: 1 }), /Unknown option/);

  const prevOffline = process.env.NEURODESK_OFFLINE;
  try {
    process.env.NEURODESK_OFFLINE = "1";
    assert.throws(() => parseCliOptions({ offline: false }), /NEURODESK_OFFLINE=1/);
    await assert.rejects(() => downloadModels({ offline: false }), /NEURODESK_OFFLINE=1/);
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

  // Sol r2: non-plain options, unknown undefined keys, inherited props, null aliases ("do-3d": null), symlink refusal, TOCTOU non-overwrite
  assert.throws(() => parseCliOptions(new Date()), /plain object/);
  assert.throws(() => parseCliOptions(Object.create({ overwrite: true })), /plain object/);
  assert.throws(() => parseCliOptions({ unknownKey: undefined }), /Unknown option/);
  assert.throws(() => parseCliOptions({ "do-3d": null }), /must be a boolean/);
  assert.throws(() => parseCliOptions({ "cache-dir": null }), /non-empty/);
  await assert.rejects(() => checkInstallation(new Date()), /plain object/);
  await assert.rejects(() => checkInstallation({ extra: undefined }), /Unknown option/);
  await assert.rejects(() => downloadModels({ unknownKey: undefined }), /Unknown option/);

  const { symlink } = await import("node:fs/promises");
  await writeFile(join(work, "target.tif"), "precious");
  await symlink(join(work, "target.tif"), join(dir, "sym.tif"));
  await assert.rejects(
    () => commitOutputs(dir, [{ name: "sym.tif", data: Buffer.from("x") }], { overwrite: true }),
    /symbolic link/,
  );
  assert.equal(await readFile(join(work, "target.tif"), "utf8"), "precious");

  const raceDir = join(work, "race");
  await mkdir(raceDir);
  await assert.rejects(
    () => commitOutputs(raceDir, [{ name: "out.tif", data: Buffer.from("new") }], {
      overwrite: false,
      writeFileFn: async (p, data, opts) => {
        await writeFile(p, data, opts);
        await writeFile(join(raceDir, "out.tif"), "winner");
      },
    }),
    /already exists/,
  );
  assert.equal(await readFile(join(raceDir, "out.tif"), "utf8"), "winner");
});
