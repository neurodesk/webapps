import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { link, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { writeTiffStack } from "@neurodesk/webapp-components/file-io/tiff";
import {
  OUTPUT_LOCK_FILE,
  checkInstallation,
  claimOutputDirectory,
  parseCliOptions,
  runMicroscopeQc,
  writeStagedOutputs,
} from "../src/node.js";

const binPath = fileURLToPath(new URL("../bin/microscope-qc.js", import.meta.url));
const NODE_MODULE_URL = new URL("../src/node.js", import.meta.url).href;

function runCli(args) {
  return spawnSync(process.execPath, [binPath, ...args], { encoding: "utf8" });
}

test("CLI rejects empty string flags, cross-mode options, and disallowed subcommand flags", () => {
  for (const args of [
    ["--analysis=", "img.tif", "out"],
    ["--na=", "img.tif", "out"],
    ["--cache-dir=", "self-check"],
    ["self-check", "--analysis", "psf"],
    ["self-check", "--offline"],
    ["self-check", "extra"],
    ["img.tif", "out", "--cache-dir", "/tmp"],
    ["img.tif", "out", "--analysis", "bogus"],
    ["img.tif", "out", "--analysis", "psf", "--step", "10"],
    ["img.tif", "out", "--analysis", "field", "--na", "0.95"],
    ["img.tif", "out", "--na", "1.5", "--refractive-index", "1.0"],
    ["img.tif", "out", "--step", "51"],
    ["img.tif"],
  ]) {
    const res = runCli(args);
    assert.notEqual(res.status, 0, `expected failure for ${args.join(" ")}`);
  }
  const help = runCli(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: microscope-qc/);
});

test("parseCliOptions validates unknown keys, types, prototype-safe enums, and optics ranges before I/O", () => {
  assert.throws(() => parseCliOptions({ bogusOpt: "1" }), /Unknown option/);
  assert.throws(() => parseCliOptions(Object.create({ analysis: "psf" })), /plain object/);
  assert.throws(() => parseCliOptions({ analysis: null }), /Option --analysis/);
  assert.throws(() => parseCliOptions({ microscope: null }), /Option --microscope/);
  assert.throws(() => parseCliOptions({ analysis: "constructor" }), /Option --analysis/);
  assert.throws(() => parseCliOptions({ analysis: "bad" }), /Option --analysis/);
  assert.throws(() => parseCliOptions({ microscope: "toString" }), /Option --microscope/);
  assert.throws(() => parseCliOptions({ microscope: "electron" }), /Option --microscope/);
  assert.throws(() => parseCliOptions({ na: true }), /finite number/);
  assert.throws(() => parseCliOptions({ "no-blur": "yes" }), /boolean/);
  assert.throws(() => parseCliOptions({ na: "1.4", "refractive-index": "1.33" }), /must be below/);
  assert.throws(() => parseCliOptions({ step: "0" }), /Option --step/);
  const ok = parseCliOptions({ analysis: "psf", microscope: "widefield", na: "0.95", "refractive-index": "1.0", emission: "515" });
  assert.equal(ok.na, 0.95);
  assert.equal(ok.emission, 515);
  const protoCli = runCli(["img.tif", "out", "--analysis=constructor"]);
  assert.notEqual(protoCli.status, 0);
  assert.match(protoCli.stderr, /Option --analysis/);
});

test("self-check honors --cache-dir and checks synthetic bead FWHM offline", async () => {
  const work = await mkdtemp(join(tmpdir(), "microscope-qc-self-check-"));
  try {
    const info = await checkInstallation({ cacheDir: work });
    assert.equal(info.ok, true);
    assert.equal(info.cacheDir, work);
    assert.equal(info.phantom.beadsUsed, 1);

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
  const work = await mkdtemp(join(tmpdir(), "microscope-qc-lock-"));
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

    if (process.platform !== "win32") {
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
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("writeStagedOutputs enforces atomic non-overwrite, cleans failed .partial, and rolls back on mid-publication SIGTERM", async () => {
  const work = await mkdtemp(join(tmpdir(), "microscope-qc-stage-"));
  try {
    await assert.rejects(
      writeStagedOutputs(
        work,
        [{ name: "first.csv", bytes: new Uint8Array([1, 2, 3]) }],
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

    const racingDest = join(work, "race.csv");
    await assert.rejects(
      writeStagedOutputs(
        work,
        [
          { name: "race.csv", bytes: new Uint8Array([9]) },
          { name: "second.csv", bytes: new Uint8Array([2]) },
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
          { name: "first.csv", bytes: new Uint8Array([1]) },
          { name: "second.csv", bytes: new Uint8Array([2]) },
        ],
        {
          linkFn: async (src, dst) => {
            calls += 1;
            if (calls === 1) {
              await link(src, dst);
              await rm(dst);
              await writeFile(dst, "external");
              return;
            }
            throw new Error("link failure");
          },
        },
      ),
      /link failure/,
    );
    assert.equal(await readFile(join(work, "first.csv"), "utf8"), "external");
    assert.deepEqual(await readdir(work), ["first.csv"]);

    if (process.platform !== "win32") {
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
               { name: "first.csv", bytes: new Uint8Array([1]) },
               { name: "second.csv", bytes: new Uint8Array([2]) },
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
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("runMicroscopeQc runs both PSF bead and field illumination analyses offline", async () => {
  const work = await mkdtemp(join(tmpdir(), "microscope-qc-e2e-"));
  try {
    // 1. Synthetic bead stack
    const nx = 40;
    const ny = 40;
    const nz = 21;
    const beadData = new Uint16Array(nx * ny * nz);
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          const dx = (x - 20) * 0.1;
          const dy = (y - 20) * 0.1;
          const dz = (z - 10) * 0.2;
          const bg = 20 + ((x * 3 + y * 5 + z * 7) % 5);
          beadData[(z * ny + y) * nx + x] = Math.round(bg + 2000 * Math.exp(-(dx * dx + dy * dy) / (2 * 0.04) - (dz * dz) / (2 * 0.25)));
        }
      }
    }
    const beadPath = join(work, "beads.tif");
    await writeFile(beadPath, writeTiffStack({ width: nx, height: ny, data: beadData }));
    const outPsf = join(work, "out-psf");
    const psfRes = await runMicroscopeQc({
      input: beadPath,
      outputDir: outPsf,
      options: {
        analysis: "psf",
        microscope: "widefield",
        na: "0.95",
        "refractive-index": "1.0",
        emission: "515",
        "pixel-x": "0.1",
        "pixel-y": "0.1",
        "z-step": "0.2",
        prominence: "200",
      },
    });
    assert.equal(psfRes.analysis, "psf");
    assert.equal(psfRes.summary.used, 1);
    for (const file of ["beads_beads.tif", "beads_psf_summary.csv", "beads_beads.csv", "beads_profiles.csv", "beads_psf_report.json"]) {
      assert.ok(psfRes.files.includes(file), `missing ${file}`);
    }

    // 2. Synthetic field image
    const fw = 64;
    const fh = 48;
    const fieldData = new Uint16Array(fw * fh);
    for (let y = 0; y < fh; y++) {
      for (let x = 0; x < fw; x++) {
        const d2 = ((x - 36) / 40) ** 2 + ((y - 20) / 35) ** 2;
        fieldData[y * fw + x] = Math.round(1000 * Math.exp(-0.5 * d2));
      }
    }
    const fieldPath = join(work, "slide.tif");
    await writeFile(fieldPath, writeTiffStack({ width: fw, height: fh, data: fieldData }));
    const outField = join(work, "out-field");
    const fieldRes = await runMicroscopeQc({ input: fieldPath, outputDir: outField, options: { analysis: "field" } });
    assert.equal(fieldRes.analysis, "field");
    assert.ok(fieldRes.summary.uniformity > 20 && fieldRes.summary.uniformity < 100);
    const metricsCsv = await readFile(join(outField, "slide_field_metrics.csv"), "utf8");
    assert.match(metricsCsv, /uniformity_percent,/);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
