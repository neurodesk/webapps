import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { writeTiffStack } from "@neurodesk/webapp-components/file-io/tiff";
import { parseTileConfiguration } from "../src/core/tile-layout.js";
import {
  OUTPUT_LOCK_FILE,
  checkInstallation,
  claimOutputDirectory,
  parseCliOptions,
  runStitching,
  writeStagedOutputs,
} from "../src/node.js";

const binPath = fileURLToPath(new URL("../bin/stitching.js", import.meta.url));
const NODE_MODULE_URL = new URL("../src/node.js", import.meta.url).href;

function runCli(args) {
  return spawnSync(process.execPath, [binPath, ...args], { encoding: "utf8" });
}

test("CLI rejects empty string flags, invalid ranges, and disallowed subcommand options", () => {
  for (const args of [
    ["--layout=", "tiles/", "out"],
    ["--overlap=", "tiles/", "out"],
    ["--cache-dir=", "self-check"],
    ["self-check", "--layout", "grid"],
    ["self-check", "--offline"],
    ["self-check", "extra"],
    ["tiles/", "out", "--cache-dir", "/tmp"],
    ["tiles/", "out", "--layout", "bogus"],
    ["tiles/", "out", "--layout", "grid", "--layout-file", "TileConfiguration.txt"],
    ["tiles/", "out", "--overlap", "99"],
    ["tiles/", "out", "--threshold", "1.5"],
    ["tiles/"],
  ]) {
    const res = runCli(args);
    assert.notEqual(res.status, 0, `expected failure for ${args.join(" ")}`);
  }
  const help = runCli(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: stitching/);
});

test("parseCliOptions validates unknown keys, types, enums and numeric bounds before I/O", () => {
  assert.throws(() => parseCliOptions({ colums: "4" }), /Unknown option/);
  assert.throws(() => parseCliOptions({ layout: "constructor" }), /Option --layout must be one of/);
  assert.throws(() => parseCliOptions({ layout: "invalid" }), /Option --layout must be one of/);
  assert.throws(() => parseCliOptions({ "grid-type": "toString" }), /Option --grid-type/);
  assert.throws(() => parseCliOptions({ "grid-type": "spiral" }), /Option --grid-type/);
  assert.throws(() => parseCliOptions({ "grid-start": "valueOf" }), /Option --grid-start/);
  assert.throws(() => parseCliOptions({ "grid-start": "middle" }), /Option --grid-start/);
  assert.throws(() => parseCliOptions({ columns: true }), /finite number/);
  assert.throws(() => parseCliOptions({ peaks: "0" }), /Peaks to check/);
  assert.throws(() => parseCliOptions({ columns: "2.5" }), /whole number/);
  const ok = parseCliOptions({ layout: "grid", columns: "4", rows: "4", overlap: "18" });
  assert.equal(ok.explicitLayout, "grid");
  assert.equal(ok.explicitColumns, 4);
  assert.equal(ok.explicitRows, 4);
  assert.equal(ok.overlapPercent, 18);
});

test("self-check honors --cache-dir and runs synthetic tile check offline", async () => {
  const work = await mkdtemp(join(tmpdir(), "stitching-self-check-"));
  try {
    const info = await checkInstallation({ cacheDir: work });
    assert.equal(info.ok, true);
    assert.equal(info.cacheDir, work);
    assert.ok(info.phantom.errorPx < 0.25);

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
  const work = await mkdtemp(join(tmpdir(), "stitching-lock-"));
  try {
    assert.equal(OUTPUT_LOCK_FILE, ".neurodesk-cli.lock");
    const fresh = join(work, "fresh");
    const claim = await claimOutputDirectory(fresh);
    await assert.rejects(claimOutputDirectory(fresh), /already in use/);
    await claim.release({ removeDirIfEmpty: true });
    await assert.rejects(stat(fresh), { code: "ENOENT" });

    const linkPath = join(work, "link-dir");
    await symlink(join(work, "real"), linkPath);
    await assert.rejects(claimOutputDirectory(linkPath), /symbolic link/);

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
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("writeStagedOutputs cleans up failed writeFile .partial and preserves unrelated replacements during rollback", async () => {
  const work = await mkdtemp(join(tmpdir(), "stitching-stage-"));
  try {
    await assert.rejects(
      writeStagedOutputs(
        work,
        [{ name: "one.tif", bytes: new Uint8Array([1, 2, 3]) }],
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

    let calls = 0;
    await assert.rejects(
      writeStagedOutputs(
        work,
        [
          { name: "one.tif", bytes: new Uint8Array([1]) },
          { name: "two.txt", bytes: new Uint8Array([2]) },
        ],
        {
          renameFn: async (src, dst) => {
            calls += 1;
            if (calls === 1) {
              await rename(src, dst);
              await rm(dst);
              await writeFile(dst, "external");
              return;
            }
            throw new Error("rename failure");
          },
        },
      ),
      /rename failure/,
    );
    assert.equal(await readFile(join(work, "one.tif"), "utf8"), "external");
    assert.deepEqual(await readdir(work), ["one.tif"]);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("runStitching stitches a synthetic 2x2 tile grid offline and recovers exact offsets", async () => {
  const work = await mkdtemp(join(tmpdir(), "stitching-e2e-"));
  try {
    const tileDir = join(work, "tiles");
    const outDir = join(work, "out");
    await stat(work);
    const fullW = 140;
    const fullH = 120;
    const tw = 80;
    const th = 70;
    const scene = new Uint16Array(fullW * fullH);
    for (let y = 0; y < fullH; y++) {
      for (let x = 0; x < fullW; x++) {
        const v = 500 +
          250 * Math.sin(x / 4.7) * Math.cos(y / 5.1) +
          200 * Math.cos((x + y) / 6.3) +
          300 * Math.exp(-((x - 70) ** 2 + (y - 60) ** 2) / 90);
        scene[y * fullW + x] = Math.round(v);
      }
    }
    const truePos = [
      ["tile_r01_c01.tif", 0, 0],
      ["tile_r01_c02.tif", 58, 2],
      ["tile_r02_c01.tif", -1, 48],
      ["tile_r02_c02.tif", 57, 50],
    ];
    const { mkdir } = await import("node:fs/promises");
    await mkdir(tileDir);
    for (const [name, ox, oy] of truePos) {
      const data = new Uint16Array(tw * th);
      for (let y = 0; y < th; y++) {
        for (let x = 0; x < tw; x++) {
          const sx = Math.max(0, Math.min(fullW - 1, x + ox));
          const sy = Math.max(0, Math.min(fullH - 1, y + oy));
          data[y * tw + x] = scene[sy * fullW + sx];
        }
      }
      await writeFile(join(tileDir, name), writeTiffStack({ width: tw, height: th, data }));
    }

    const result = await runStitching({
      inputs: [tileDir],
      outputDir: outDir,
      options: { layout: "grid", columns: "2", rows: "2", overlap: "25" },
    });
    assert.ok(result.files.includes("tile_stitched.tif"));
    assert.ok(result.files.includes("TileConfiguration.registered.txt"));
    assert.ok(result.files.includes("tile_stitched_pairs.csv"));
    assert.ok(result.files.includes("tile_stitched_provenance.json"));
    assert.equal(result.summary.used, result.summary.links);
    const cfg = parseTileConfiguration(await readFile(join(outDir, "TileConfiguration.registered.txt"), "utf8"));
    assert.equal(cfg.entries.length, 4);
    const p0 = cfg.entries[0].position;
    const p1 = cfg.entries[1].position;
    assert.ok(Math.abs((p1[0] - p0[0]) - 58) < 0.5 && Math.abs((p1[1] - p0[1]) - 2) < 0.5);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
