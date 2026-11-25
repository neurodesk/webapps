// Offline CLI tests for @neurodesk/derm-compare.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { decode as decodePng, encode as encodePng } from "fast-png";
import jpeg from "jpeg-js";
import { checkInstallation, compareFiles } from "../src/node.js";

const BIN = fileURLToPath(new URL("../bin/derm-compare.js", import.meta.url));

function syntheticDermoscopy(width = 80, height = 80, { dx = 0, dy = 0, darkDelta = 0 } = {}) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const lx = x - (width / 2 + dx);
      const ly = y - (height / 2 + dy);
      const r2 = (lx * lx) / 225 + (ly * ly) / 144;
      const tex = Math.round(10 * Math.sin((x - dx) * 0.35) * Math.cos((y - dy) * 0.35));
      const inLesion = r2 <= 1;
      const o = (y * width + x) * 4;
      rgba[o] = Math.max(0, Math.min(255, (inLesion ? 96 - darkDelta : 212) + tex));
      rgba[o + 1] = Math.max(0, Math.min(255, (inLesion ? 64 - darkDelta : 174) + tex));
      rgba[o + 2] = Math.max(0, Math.min(255, (inLesion ? 48 - darkDelta : 150) + tex));
      rgba[o + 3] = 255;
    }
  }
  return rgba;
}

test("checkInstallation passes offline and reports executable and node version", async () => {
  const report = await checkInstallation();
  assert.equal(report.ok, true);
  assert.equal(report.executable, process.execPath);
  assert.equal(report.node, process.version);
});

test("CLI aligns synthetic shifted pair in PNG and JPEG and writes all 4 outputs", async () => {
  const work = await mkdtemp(join(tmpdir(), "derm-compare-cli-"));
  try {
    const baseRgba = syntheticDermoscopy(80, 80, { dx: 0, dy: 0 });
    const follRgba = syntheticDermoscopy(80, 80, { dx: 4, dy: -3, darkDelta: 12 });
    const basePath = join(work, "t0.png");
    const follPath = join(work, "t1.jpg");
    await writeFile(basePath, encodePng({ width: 80, height: 80, channels: 4, depth: 8, data: baseRgba }));
    await writeFile(follPath, jpeg.encode({ width: 80, height: 80, data: Buffer.from(follRgba) }, 95).data);

    const outDir = join(work, "out");
    const res = await compareFiles({ baseline: basePath, followup: follPath, outputDir: outDir, maxAngle: 15 });
    assert.equal(res.result.registered, true);
    assert.ok(res.result.registration.alignedNcc > res.result.registration.initialNcc);
    assert.ok(Math.abs(res.result.registration.dx - 4) < 1.5);
    assert.ok(Math.abs(res.result.registration.dy - -3) < 1.5);

    const aligned = decodePng(await readFile(join(outDir, "t0_vs_t1_aligned.png")));
    const diffPng = decodePng(await readFile(join(outDir, "t0_vs_t1_deltaE2000.png")));
    assert.equal(aligned.width, 80);
    assert.equal(diffPng.height, 80);
    const csv = await readFile(join(outDir, "t0_vs_t1_metrics.csv"), "utf8");
    assert.match(csv, /aligned_ncc,/);
    const prov = JSON.parse(await readFile(join(outDir, "t0_vs_t1_provenance.json"), "utf8"));
    assert.equal(prov.registration.registered, true);

    const cliOut = join(work, "out-cli");
    const cli = spawnSync(process.execPath, [BIN, basePath, follPath, cliOut, "--max-angle", "10"], { encoding: "utf8" });
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout.trim(), /t0_vs_t1_metrics\.csv$/);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("CLI --help and self-check exit 0", () => {
  const help = spawnSync(process.execPath, [BIN, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: derm-compare BASELINE FOLLOWUP OUTPUT_DIR/);

  const selfCheck = spawnSync(process.execPath, [BIN, "self-check"], { encoding: "utf8" });
  assert.equal(selfCheck.status, 0, selfCheck.stderr);
  assert.equal(JSON.parse(selfCheck.stdout).ok, true);
});
