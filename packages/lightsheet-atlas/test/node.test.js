import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { writeTiffStack } from "@neurodesk/webapp-components/file-io/tiff";
import {
  checkInstallation,
  claimOutputDirectory,
  downloadModels,
  parseCliOptions,
  runLightsheetAtlas,
  writeStagedOutputs,
} from "../src/node.js";

const binPath = fileURLToPath(new URL("../bin/lightsheet-atlas.js", import.meta.url));

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [binPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

test("package model.manifest.json stays identical to models/lightsheet-atlas.manifest.json", async () => {
  const pkgManifest = await readFile(new URL("../model.manifest.json", import.meta.url), "utf8");
  const repoManifest = await readFile(new URL("../../../models/lightsheet-atlas.manifest.json", import.meta.url), "utf8");
  assert.equal(pkgManifest, repoManifest);
});

test("CLI rejects empty string flags and disallowed subcommand options", () => {
  for (const args of [
    ["--orientation=", "in.tif", "out"],
    ["--voxel-z=", "in.tif", "out"],
    ["--cache-dir=", "self-check"],
    ["self-check", "--detect"],
    ["self-check", "--offline"],
    ["self-check", "extra"],
    ["download-models", "--orientation", "psl"],
    ["download-models", "extra"],
    ["in.tif", "out", "--no-register"],
    ["in.tif", "out", "--orientation", "xyz"],
    ["in.tif", "out", "--voxel-z", "-5"],
    ["in.tif", "out", "--ball-overlap-fraction", "1.5"],
  ]) {
    const res = runCli(args);
    assert.notEqual(res.status, 0, `expected failure for ${args.join(" ")}`);
  }
  const help = runCli(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: lightsheet-atlas/);
});

test("parseCliOptions validates numeric ranges and flags before I/O", () => {
  assert.throws(() => parseCliOptions({ "no-register": true }), /Choose atlas registration/);
  assert.throws(() => parseCliOptions({ orientation: "bad" }), /orientation|axis/i);
  assert.throws(() => parseCliOptions({ "voxel-x": "0" }), /positive finite/);
  assert.throws(() => parseCliOptions({ "ball-overlap-fraction": "1.2" }), /at most 1/);
  const ok = parseCliOptions({ orientation: "PSL", detect: true, "no-register": true, "voxel-z": "5", "voxel-y": "2", "voxel-x": "2" });
  assert.equal(ok.orientation, "psl");
  assert.equal(ok.register, false);
  assert.equal(ok.detect, true);
  assert.deepEqual(ok.voxelSizeOverride, [5, 2, 2]);
});

test("self-check honors --cache-dir and exercises Greedy WASM offline", async () => {
  const work = await mkdtemp(join(tmpdir(), "lightsheet-self-check-"));
  try {
    const report = await checkInstallation({ cacheDir: work });
    assert.equal(report.ok, true);
    assert.equal(report.greedy, "wasm-single");
    assert.equal(report.executable, process.execPath);
    assert.equal(report.node, process.version);
    assert.equal(report.atlas.directory, work);
    assert.equal(report.atlas.ready, false);

    const cli = runCli(["self-check", "--cache-dir", work]);
    assert.equal(cli.status, 0, cli.stderr);
    const parsed = JSON.parse(cli.stdout.trim());
    assert.equal(parsed.atlas.directory, work);
    assert.equal(parsed.ok, true);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("downloadModels refuses missing assets in offline mode", async () => {
  const work = await mkdtemp(join(tmpdir(), "lightsheet-offline-"));
  try {
    await assert.rejects(
      downloadModels({ cacheDir: work, offline: true }),
      /Offline mode: required Allen atlas asset/,
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("claimOutputDirectory enforces O_EXCL exclusivity and cleans up on error", async () => {
  const work = await mkdtemp(join(tmpdir(), "lightsheet-lock-"));
  try {
    const nonEmpty = join(work, "existing");
    await writeFile(join(work, "not-a-dir"), "x");
    await assert.rejects(claimOutputDirectory(join(work, "not-a-dir")), /not a directory/);

    const fresh = join(work, "fresh");
    const claim = await claimOutputDirectory(fresh);
    await assert.rejects(claimOutputDirectory(fresh), /already in use/);
    await claim.release({ removeDirIfEmpty: true });
    await assert.rejects(stat(fresh), { code: "ENOENT" });

    // Non-empty directory fails cleanly without deleting existing files
    await claimOutputDirectory(nonEmpty).then((c) => c.release());
    await writeFile(join(nonEmpty, "keep.txt"), "keep");
    await assert.rejects(claimOutputDirectory(nonEmpty), /not empty/);
    assert.deepEqual(await readdir(nonEmpty), ["keep.txt"]);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("writeStagedOutputs rolls back already-renamed files if a later rename fails", async () => {
  const work = await mkdtemp(join(tmpdir(), "lightsheet-stage-"));
  try {
    let calls = 0;
    const flakyRename = async (src, dst) => {
      calls += 1;
      if (calls === 2) throw new Error("injected rename failure");
      return rename(src, dst);
    };
    await assert.rejects(
      writeStagedOutputs(
        work,
        [
          { name: "first.txt", bytes: new Uint8Array([1, 2, 3]) },
          { name: "second.txt", bytes: new Uint8Array([4, 5, 6]) },
        ],
        { renameFn: flakyRename },
      ),
      /injected rename failure/,
    );
    assert.deepEqual(await readdir(work), []);
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
    // Low textured background + two 3 um in-plane / 4 um z somata (matching detect.test.js)
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

    // Verify outputs are valid gzipped NIfTI and CSV
    const csv = await readFile(join(outDir, "synthetic_cells_candidates.csv"), "utf8");
    assert.match(csv, /^x,y,z,x_um,y_um,z_um\n/);
    const gridGz = await readFile(join(outDir, "synthetic_cells_atlas-grid.nii.gz"));
    assert.equal(gridGz[0], 0x1f);
    assert.equal(gridGz[1], 0x8b);
    assert.ok(gzipSync(new Uint8Array([1])).byteLength > 0);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
