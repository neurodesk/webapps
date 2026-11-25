import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { link, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeTiffStack } from "@neurodesk/webapp-components/file-io/tiff";
import {
  OUTPUT_LOCK_FILE,
  checkInstallation,
  claimOutputDirectory,
  downloadModels,
  openInputStack,
  parseCliOptions,
  resolveDownloadOffline,
  runLightsheetAtlas,
  writeStagedOutputs,
} from "../src/node.js";

const BIN = fileURLToPath(new URL("../bin/lightsheet-atlas.js", import.meta.url));
const NODE_MODULE_URL = new URL("../src/node.js", import.meta.url).href;
const ROOT_MANIFEST = fileURLToPath(new URL("../../../models/lightsheet-atlas.manifest.json", import.meta.url));
const PKG_MANIFEST = fileURLToPath(new URL("../model.manifest.json", import.meta.url));

function runCli(args, env = process.env) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env });
}

test("package model.manifest.json stays identical to models/lightsheet-atlas.manifest.json", async () => {
  assert.equal(await readFile(PKG_MANIFEST, "utf8"), await readFile(ROOT_MANIFEST, "utf8"));
});

test("CLI rejects empty string flags and disallowed subcommand options", () => {
  const help = runCli(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: lightsheet-atlas/);

  const emptyOri = runCli(["in.tif", "out", "--orientation="]);
  assert.notEqual(emptyOri.status, 0);
  assert.match(emptyOri.stderr, /non-empty/);

  const emptyVoxel = runCli(["in.tif", "out", "--voxel-z="]);
  assert.notEqual(emptyVoxel.status, 0);
  assert.match(emptyVoxel.stderr, /non-empty/);

  const badSelfCheck = runCli(["self-check", "--detect"]);
  assert.notEqual(badSelfCheck.status, 0);
  assert.match(badSelfCheck.stderr, /not valid for self-check/);

  const badDownload = runCli(["download-models", "--orientation", "asr"]);
  assert.notEqual(badDownload.status, 0);
  assert.match(badDownload.stderr, /not valid for download-models/);

  const posSelfCheck = runCli(["self-check", "extra"]);
  assert.notEqual(posSelfCheck.status, 0);
  assert.match(posSelfCheck.stderr, /positional/);
});

test("parseCliOptions validates unknown keys, types, numeric ranges and flags before I/O", () => {
  assert.throws(() => parseCliOptions({ unknownKey: "1" }), /Unknown option/);
  assert.throws(() => parseCliOptions(Object.create({ orientation: "psl" })), /plain object/);
  assert.throws(() => parseCliOptions({ orientation: null }), /orientation/);
  assert.throws(() => parseCliOptions({ detect: "yes" }), /boolean/);
  assert.throws(() => parseCliOptions({ "voxel-z": true }), /positive finite number/);
  assert.throws(() => parseCliOptions({ "no-register": true }), /Choose atlas registration/);
  assert.throws(() => parseCliOptions({ orientation: "xyz" }), /orientation|axis/i);
  assert.throws(() => parseCliOptions({ "voxel-z": "0" }), /positive finite number/);
  assert.throws(() => parseCliOptions({ "ball-overlap-fraction": "1.5" }), /at most 1/);
  assert.throws(() => parseCliOptions({ "cache-dir": "   " }), /non-empty/);

  const parsed = parseCliOptions({
    orientation: "psl",
    "voxel-z": "5",
    "voxel-y": "2",
    "voxel-x": "2",
    detect: true,
    "no-register": true,
    offline: true,
  });
  assert.equal(parsed.register, false);
  assert.equal(parsed.detect, true);
  assert.equal(parsed.orientation, "psl");
  assert.deepEqual(parsed.voxelSizeOverride, [5, 2, 2]);
  assert.equal(parsed.offline, true);
});

test("self-check honors --cache-dir and exercises Greedy WASM offline", async () => {
  const work = await mkdtemp(join(tmpdir(), "lightsheet-self-check-"));
  try {
    const info = await checkInstallation({ cacheDir: work });
    assert.equal(info.ok, true);
    assert.equal(info.greedy, "wasm-single");
    assert.equal(info.atlas.directory, work);
    assert.equal(info.atlas.ready, false);
    assert.equal(info.atlas.count, 3);

    const cli = runCli(["self-check", "--cache-dir", work]);
    assert.equal(cli.status, 0, cli.stderr);
    const parsed = JSON.parse(cli.stdout.trim());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.atlas.directory, work);
    assert.equal(parsed.atlas.count, 3);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("downloadModels enforces offline mode for NEURODESK_OFFLINE=1 without bundled dir and when --cache-dir equals bundled dir", async () => {
  const work = await mkdtemp(join(tmpdir(), "lightsheet-offline-"));
  const otherDir = join(work, "other-writable");
  try {
    let fetchCalls = 0;
    const stubFetch = async () => {
      fetchCalls += 1;
      throw new Error("fetch must not be called in offline mode");
    };

    // Case 1: NEURODESK_OFFLINE=1 WITHOUT bundled model dir -> stays offline even with --cache-dir
    const envOfflineNoBundle = { NEURODESK_OFFLINE: "1" };
    const off1 = resolveDownloadOffline({ explicitCacheDir: otherDir, env: envOfflineNoBundle });
    assert.equal(off1, true);
    await assert.rejects(
      downloadModels({ cacheDir: otherDir, offline: off1, fetchImpl: stubFetch }),
      /Offline mode: required Allen atlas asset/,
    );
    assert.equal(fetchCalls, 0);

    // Case 2: NEURODESK_OFFLINE=1 WITH bundled dir, --cache-dir pointing to bundled dir itself -> stays offline
    const envBundled = { NEURODESK_OFFLINE: "1", NEURODESK_LIGHTSHEET_ATLAS_MODEL_DIR: work };
    const off2 = resolveDownloadOffline({ explicitCacheDir: join(work, "."), env: envBundled });
    assert.equal(off2, true);
    await assert.rejects(
      downloadModels({ cacheDir: join(work, "."), offline: off2, fetchImpl: stubFetch }),
      /Offline mode:/,
    );
    assert.equal(fetchCalls, 0);

    // Case 3: NEURODESK_OFFLINE=1 WITH bundled dir, --cache-dir pointing to a DIFFERENT dir -> allows online recovery
    assert.equal(resolveDownloadOffline({ explicitCacheDir: otherDir, env: envBundled }), false);
    assert.equal(resolveDownloadOffline({ explicitCacheDir: otherDir, offlineFlag: true, env: envBundled }), true);

    // CLI subprocess with NEURODESK_OFFLINE=1 + bundled dir and no --cache-dir prints recovery instructions
    const bundledRun = runCli(["download-models"], {
      ...process.env,
      NEURODESK_OFFLINE: "1",
      NEURODESK_LIGHTSHEET_ATLAS_MODEL_DIR: work,
    });
    assert.notEqual(bundledRun.status, 0);
    assert.match(bundledRun.stderr, /Reinstall the portable archive/);
    assert.match(bundledRun.stderr, /--cache-dir/);

    // CLI subprocess with NEURODESK_OFFLINE=1 and NO bundled dir + --cache-dir stays offline
    const envNoBundle = { ...process.env, NEURODESK_OFFLINE: "1" };
    delete envNoBundle.NEURODESK_LIGHTSHEET_ATLAS_MODEL_DIR;
    const offlineNoBundleRun = runCli(["download-models", "--cache-dir", otherDir], envNoBundle);
    assert.notEqual(offlineNoBundleRun.status, 0);
    assert.match(offlineNoBundleRun.stderr, /Offline mode:/);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("openInputStack reads OME-Zarr lazily and never reads chunks from unselected resolution levels", async () => {
  const work = await mkdtemp(join(tmpdir(), "lightsheet-lazy-zarr-"));
  try {
    const zarrRoot = join(work, "brain.ome.zarr");
    await mkdir(join(zarrRoot, "0"), { recursive: true });
    await mkdir(join(zarrRoot, "1"), { recursive: true });

    await writeFile(join(zarrRoot, ".zgroup"), JSON.stringify({ zarr_format: 2 }));
    await writeFile(
      join(zarrRoot, ".zattrs"),
      JSON.stringify({
        multiscales: [
          {
            version: "0.4",
            axes: [
              { name: "z", type: "space", unit: "micrometer" },
              { name: "y", type: "space", unit: "micrometer" },
              { name: "x", type: "space", unit: "micrometer" },
            ],
            datasets: [
              { path: "0", coordinateTransformations: [{ type: "scale", scale: [5, 2, 2] }] },
              { path: "1", coordinateTransformations: [{ type: "scale", scale: [10, 4, 4] }] },
            ],
          },
        ],
      }),
    );

    const zarray0 = {
      zarr_format: 2,
      shape: [2, 4, 4],
      chunks: [1, 4, 4],
      dtype: "<u2",
      compressor: null,
      fill_value: 0,
      order: "C",
      filters: null,
    };
    const zarray1 = {
      zarr_format: 2,
      shape: [2, 2, 2],
      chunks: [1, 2, 2],
      dtype: "<u2",
      compressor: null,
      fill_value: 0,
      order: "C",
      filters: null,
    };
    await writeFile(join(zarrRoot, "0", ".zarray"), JSON.stringify(zarray0));
    await writeFile(join(zarrRoot, "1", ".zarray"), JSON.stringify(zarray1));

    // Write level 0 chunks (high-res) and level 1 chunks (coarse-res)
    const lvl0Chunk = new Uint16Array(16).fill(111);
    const lvl1Chunk = new Uint16Array(4).fill(222);
    await writeFile(join(zarrRoot, "0", "0.0.0"), Buffer.from(lvl0Chunk.buffer));
    await writeFile(join(zarrRoot, "0", "1.0.0"), Buffer.from(lvl0Chunk.buffer));
    await writeFile(join(zarrRoot, "1", "0.0.0"), Buffer.from(lvl1Chunk.buffer));
    await writeFile(join(zarrRoot, "1", "1.0.0"), Buffer.from(lvl1Chunk.buffer));

    const readKeys = [];
    const { stack } = await openInputStack(zarrRoot, { onReadKey: (key) => readKeys.push(key) });
    assert.equal(stack.kind, "ome-zarr");
    assert.equal(stack.levels.length, 2);
    // Opening metadata must NOT read any data chunks from either level
    assert.equal(readKeys.some((k) => k.endsWith(".0.0")), false, `expected no chunks read on open, got ${JSON.stringify(readKeys)}`);

    // Reading plane 0 of level 1 must ONLY read level 1 chunk 0.0.0, NEVER level 0 chunks!
    const plane = await stack.readPlane(0, 1);
    assert.deepEqual([...plane], [222, 222, 222, 222]);
    assert.ok(readKeys.includes("1/0.0.0"), `expected level 1 chunk read, got ${JSON.stringify(readKeys)}`);
    assert.equal(readKeys.some((k) => k.startsWith("0/") && k.endsWith(".0.0")), false, `unselected level 0 chunks must never be read: ${JSON.stringify(readKeys)}`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("claimOutputDirectory uses shared .neurodesk-cli.lock, rejects symlinks, and cleans up on SIGTERM", async () => {
  const work = await mkdtemp(join(tmpdir(), "lightsheet-lock-"));
  try {
    assert.equal(OUTPUT_LOCK_FILE, ".neurodesk-cli.lock");
    const fresh = join(work, "fresh-out");
    const claim = await claimOutputDirectory(fresh);
    await assert.rejects(claimOutputDirectory(fresh), /already in use/);
    await claim.release({ removeDirIfEmpty: true });
    await assert.rejects(stat(fresh), { code: "ENOENT" });

    // Reject directory symlink
    const linkPath = join(work, "link-out");
    await symlink(join(work, "real"), linkPath);
    await assert.rejects(claimOutputDirectory(linkPath), /symbolic link/);

    // SIGTERM synchronously cleans up lock + newly created dir
    const sigDir = join(work, "sigterm-out");
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
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("writeStagedOutputs enforces atomic non-overwrite, cleans failed .partial, and rolls back on mid-publication SIGTERM", async () => {
  const work = await mkdtemp(join(tmpdir(), "lightsheet-stage-"));
  try {
    await assert.rejects(
      writeStagedOutputs(
        work,
        [{ name: "a.csv", bytes: new Uint8Array([1, 2, 3]) }],
        {
          writeFileFn: async (p, bytes, opts) => {
            await writeFile(p, bytes.subarray(0, 1), opts);
            throw Object.assign(new Error("EFBIG"), { code: "EFBIG" });
          },
        },
      ),
      /EFBIG/,
    );
    assert.deepEqual(await readdir(work), []);

    // Atomic non-overwrite: pre-existing file created right before publish causes EEXIST without being touched
    const racingDest = join(work, "race.csv");
    await assert.rejects(
      writeStagedOutputs(
        work,
        [
          { name: "race.csv", bytes: new Uint8Array([9]) },
          { name: "b.csv", bytes: new Uint8Array([66]) },
        ],
        {
          linkFn: async (src, dst) => {
            await writeFile(racingDest, "keep-me");
            return link(src, dst);
          },
        },
      ),
      /Refusing to overwrite/,
    );
    assert.equal(await readFile(racingDest, "utf8"), "keep-me");
    await rm(racingDest);

    let calls = 0;
    await assert.rejects(
      writeStagedOutputs(
        work,
        [
          { name: "a.csv", bytes: new Uint8Array([65]) },
          { name: "b.csv", bytes: new Uint8Array([66]) },
        ],
        {
          linkFn: async (src, dst) => {
            calls += 1;
            if (calls === 1) {
              await link(src, dst);
              await rm(dst);
              await writeFile(dst, "unrelated");
              return;
            }
            throw new Error("simulated link failure");
          },
        },
      ),
      /simulated link failure/,
    );
    assert.equal(await readFile(join(work, "a.csv"), "utf8"), "unrelated");
    assert.deepEqual(await readdir(work), ["a.csv"]);

    // Mid-publication SIGTERM rolls back first published file, .partial, lock, and newly created dir
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
             { name: "first.csv", bytes: new Uint8Array([65]) },
             { name: "second.csv", bytes: new Uint8Array([66]) },
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
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("detect-only pipeline runs offline on a synthetic bead TIFF stack and writes expected outputs", async () => {
  const work = await mkdtemp(join(tmpdir(), "lightsheet-detect-"));
  try {
    const nz = 24;
    const ny = 64;
    const nx = 64;
    const data = new Uint16Array(nz * ny * nx);
    let seed = 7;
    const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 20;
    const centres = [[20, 20, 12], [44, 40, 11]];
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          let v = 100 + noise();
          for (const [cx, cy, cz] of centres) {
            v += 3000 * Math.exp(-(((x - cx) * 2) ** 2 + ((y - cy) * 2) ** 2) / 18 - ((z - cz) * 5) ** 2 / 32);
          }
          data[(z * ny + y) * nx + x] = Math.round(v);
        }
      }
    }
    const tiff = writeTiffStack({ width: nx, height: ny, data, description: "ImageJ=1.11a\nimages=24\nslices=24\nunit=micron\nspacing=5\n", pixelSize: { x: 2, y: 2 } });
    const inPath = join(work, "synthetic_cells.tif");
    await writeFile(inPath, tiff);

    const outDir = join(work, "out");
    const result = await runLightsheetAtlas({
      input: inPath,
      outputDir: outDir,
      options: {
        "no-register": true,
        detect: true,
        orientation: "asr",
        "voxel-z": "5",
        "voxel-y": "2",
        "voxel-x": "2",
        offline: true,
      },
    });
    assert.ok(result.files.includes("synthetic_cells_atlas-grid.nii.gz"));
    assert.ok(result.files.includes("synthetic_cells_candidates.csv"));
    assert.ok(result.files.includes("synthetic_cells_candidates.nii.gz"));
    assert.ok(result.files.includes("synthetic_cells_provenance.json"));
    assert.ok(result.provenance.candidateCount >= 1, `expected detected candidates, got ${result.provenance.candidateCount}`);

    const csv = await readFile(join(outDir, "synthetic_cells_candidates.csv"), "utf8");
    assert.match(csv, /^x,y,z,x_um,y_um,z_um\n/);
    const gridGz = await readFile(join(outDir, "synthetic_cells_atlas-grid.nii.gz"));
    assert.equal(gridGz[0], 0x1f);
    assert.equal(gridGz[1], 0x8b);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
