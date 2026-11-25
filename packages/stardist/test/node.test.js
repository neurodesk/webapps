import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { writeTiffStack } from "@neurodesk/webapp-components/file-io/tiff";
import { MODEL_ASSETS, MODEL_IDS, resolveModel } from "../src/models.js";
import {
  checkInstallation,
  claimOutputDir,
  commitOutputs,
  downloadModels,
  parseCliOptions,
  resolveThreads,
  segmentFile,
} from "../src/node.js";

const BIN = fileURLToPath(new URL("../bin/stardist.js", import.meta.url));

function runBin(args, env = process.env) {
  return spawnSync(process.execPath, [BIN, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    env,
  });
}

test("package model.manifest.json stays identical to models/stardist.manifest.json", async () => {
  const pkgManifest = await readFile(new URL("../model.manifest.json", import.meta.url), "utf8");
  const rootManifest = await readFile(new URL("../../../models/stardist.manifest.json", import.meta.url), "utf8");
  assert.equal(pkgManifest, rootManifest);
  assert.equal(MODEL_IDS.length, 4);
  assert.equal(MODEL_ASSETS.length, 4);
});

test("parseCliOptions validates models, numeric bounds, threads and rejects empty flags", () => {
  const d = parseCliOptions({});
  assert.equal(d.model.name, "2D_versatile_fluo");
  assert.equal(d.settings.channel, 1);

  assert.throws(() => parseCliOptions({ model: "" }), /non-empty/);
  assert.throws(() => parseCliOptions({ model: "unknown" }), /Unknown StarDist model/);
  assert.throws(() => parseCliOptions({ channel: "0" }), /between 1 and 1024/);
  assert.throws(() => parseCliOptions({ channel: "1.5" }), /integer/);
  assert.throws(() => parseCliOptions({ "prob-thresh": "0" }), /between 0.01 and 0.99/);
  assert.throws(() => parseCliOptions({ "nms-thresh": "1.2" }), /between 0.01 and 0.99/);
  assert.throws(() => parseCliOptions({ tiles: "9" }), /between 0 and 8/);
  assert.throws(() => parseCliOptions({ threads: "0" }), /positive integer/);
  assert.throws(() => parseCliOptions({ "cache-dir": "  " }), /non-empty/);
  assert.equal(resolveThreads("4"), 4);
});

test("CLI rejects disallowed flags on subcommands and self-check verifies ORT CPU", async () => {
  assert.equal(runBin(["--help"]).status, 0);
  const sc = runBin(["self-check"], { ...process.env, NEURODESK_STARDIST_MODEL_DIR: "" });
  assert.equal(sc.status, 0, sc.stderr);
  const info = JSON.parse(sc.stdout);
  assert.equal(info.ok, true);
  assert.equal(info.executable, process.execPath);
  assert.equal(info.node, process.version);
  assert.equal(info.executionProvider, "cpu");
  assert.ok(info.onnxRuntime);

  assert.notEqual(runBin(["self-check", "--cache-dir="]).status, 0);
  assert.notEqual(runBin(["self-check", "--model", "3D_demo"]).status, 0);
  assert.notEqual(runBin(["self-check", "extra"]).status, 0);
  assert.notEqual(runBin(["download-models", "--model", "3D_demo"]).status, 0);
  assert.notEqual(runBin(["download-models", "--cache-dir="]).status, 0);
  assert.notEqual(runBin(["a.tif", "out", "--model="]).status, 0);

  const check = await checkInstallation();
  assert.equal(check.ok, true);
});

test("offline downloadModels and self-check --cache-dir fail cleanly when models are missing", async (t) => {
  const emptyDir = await mkdtemp(join(tmpdir(), "stardist-models-"));
  t.after(() => rm(emptyDir, { recursive: true, force: true }));
  await assert.rejects(() => downloadModels({ cacheDir: emptyDir, offline: true }), /missing from the offline model directory/);
  await assert.rejects(() => checkInstallation({ cacheDir: emptyDir }), /missing from the offline model directory/);
});

test("claimOutputDir locks exclusively and cleans up on error; commitOutputs rolls back on failure", async (t) => {
  const work = await mkdtemp(join(tmpdir(), "stardist-lock-"));
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

test("segmentFile runs full 2D pipeline offline with mocked model runner and writes TIFF + CSV + JSON", async (t) => {
  const work = await mkdtemp(join(tmpdir(), "stardist-mock-"));
  t.after(() => rm(work, { recursive: true, force: true }));

  const w = 32;
  const h = 32;
  const pixels = new Uint16Array(w * h);
  for (let y = 10; y < 22; y++) for (let x = 10; x < 22; x++) pixels[y * w + x] = 500;
  const inPath = join(work, "synth.tif");
  await writeFile(inPath, new Uint8Array(writeTiffStack({ width: w, height: h, data: pixels })));

  const model = resolveModel("2D_versatile_fluo");
  const outDir = join(work, "out");
  const res = await segmentFile({
    input: inPath,
    outputDir: outDir,
    options: { model: "2D_versatile_fluo", tiles: "1" },
    runModel: async (_tile, th, tw) => {
      const gh = th / model.grid[0];
      const gw = tw / model.grid[1];
      const prob = new Float32Array(gh * gw);
      const dist = new Float32Array(gh * gw * model.nRays);
      const cy = Math.floor(gh / 2);
      const cx = Math.floor(gw / 2);
      prob[cy * gw + cx] = 0.95;
      for (let r = 0; r < model.nRays; r++) dist[(cy * gw + cx) * model.nRays + r] = 5;
      return { prob, dist };
    },
  });
  assert.equal(res.count, 1);
  assert.equal(res.outputs.length, 3);
  const csv = await readFile(join(outDir, "synth_stardist_nuclei.csv"), "utf8");
  assert.match(csv, /^id,centroid_x,centroid_y,area_px,mean_intensity,probability\n1,/);
});

test("unconditional ORT_DISABLE_TELEMETRY=1 keeps isolated HOME empty even when ORT_DISABLE_TELEMETRY=0 is inherited", async (t) => {
  const work = await mkdtemp(join(tmpdir(), "stardist-telemetry-"));
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
      NEURODESK_STARDIST_MODEL_DIR: "",
    },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).ok, true);
  assert.deepEqual(await readdir(fakeHome), [], "isolated HOME must stay completely empty (no onnxruntime telemetry)");
});

test("strict Node API validation and failed-write .partial cleanup", async (t) => {
  const work = await mkdtemp(join(tmpdir(), "stardist-strict-"));
  t.after(() => rm(work, { recursive: true, force: true }));

  assert.throws(() => parseCliOptions({ bogus: "1" }), /Unknown option/);
  assert.throws(() => parseCliOptions({ overwrite: "false" }), /must be a boolean/);
  assert.throws(() => parseCliOptions({ offline: "true" }), /must be a boolean/);
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

  // Sol r2: non-plain options, unknown undefined keys, inherited props, null alias, symlink refusal, TOCTOU non-overwrite
  assert.throws(() => parseCliOptions(new Date()), /plain object/);
  assert.throws(() => parseCliOptions(Object.create({ overwrite: true })), /plain object/);
  assert.throws(() => parseCliOptions({ unknownKey: undefined }), /Unknown option/);
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

  // Sol r3: non-enumerable & symbol keys, failed unlink rollback, missing backup lock retention, raced symlink
  const { existsSync } = await import("node:fs");
  const { lstat, unlink } = await import("node:fs/promises");
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
    () => commitOutputs(missingBkDir, [{ name: "a.tif", data: Buffer.from("n1") }, { name: "b.tif", data: Buffer.from("n2") }], {
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
    }),
    /publish fail/,
  );
  await claimBk.release();
  assert.equal(existsSync(join(missingBkDir, ".neurodesk-cli.lock")), true);

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
});
