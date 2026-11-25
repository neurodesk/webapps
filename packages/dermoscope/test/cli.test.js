// Offline CLI tests for @neurodesk/dermoscope.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { decode as decodePng, encode as encodePng } from "fast-png";
import jpeg from "jpeg-js";
import { analyzeFile, checkInstallation, resolvePixelsPerMm } from "../src/node.js";

const BIN = fileURLToPath(new URL("../bin/dermoscope.js", import.meta.url));

function syntheticLesionRgba(width = 96, height = 96) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = x - width / 2;
      const dy = y - height / 2;
      const inLesion = dx * dx + dy * dy <= 22 * 22;
      const o = (y * width + x) * 4;
      rgba[o] = inLesion ? 88 : 214;
      rgba[o + 1] = inLesion ? 56 : 175;
      rgba[o + 2] = inLesion ? 42 : 150;
      rgba[o + 3] = 255;
    }
  }
  return rgba;
}

test("checkInstallation passes offline and reports private executable metadata", async () => {
  const report = await checkInstallation();
  assert.equal(report.ok, true);
  assert.equal(report.executable, process.execPath);
  assert.equal(report.node, process.version);
});

test("CLI runs end-to-end on PNG and JPEG inputs with calibration, locking, and optional D", async () => {
  const work = await mkdtemp(join(tmpdir(), "dermoscope-cli-"));
  try {
    const rgba = syntheticLesionRgba(96, 96);
    const pngPath = join(work, "lesion.png");
    const jpgPath = join(work, "lesion.jpg");
    await writeFile(pngPath, encodePng({ width: 96, height: 96, channels: 4, depth: 8, data: rgba }));
    await writeFile(jpgPath, jpeg.encode({ width: 96, height: 96, data: Buffer.from(rgba) }, 95).data);

    const outPng = join(work, "out-png");
    const res = await analyzeFile({
      input: pngPath,
      outputDir: outPng,
      pixelsPerMm: 10,
      differentialStructures: 2,
    });
    assert.equal(res.run.segmented, true);
    assert.ok(res.run.abcd.geometry.areaMm2 > 0);
    assert.equal(res.run.abcd.scores.D, 2);

    const prov = JSON.parse(await readFile(join(outPng, "lesion_provenance.json"), "utf8"));
    assert.equal(prov.segmentation.segmented, true);
    assert.equal(prov.abcd.geometry.calibrated, true);
    const maskPng = decodePng(await readFile(join(outPng, "lesion_mask.png")));
    assert.equal(maskPng.width, 96);
    assert.equal(maskPng.height, 96);

    const outJpg = join(work, "out-jpg");
    const cli = spawnSync(process.execPath, [BIN, jpgPath, outJpg, "--mm-per-pixel", "0.1"], { encoding: "utf8" });
    assert.equal(cli.status, 0, cli.stderr);
    const csv = await readFile(join(outJpg, "lesion_abcd_metrics.csv"), "utf8");
    assert.match(csv, /segmented,true/);
    assert.match(csv, /calibrated \(10 px\/mm\)/);

    // Non-empty output directory rejected without --overwrite
    const retry = spawnSync(process.execPath, [BIN, jpgPath, outJpg], { encoding: "utf8" });
    assert.notEqual(retry.status, 0);
    assert.match(retry.stderr, /not empty/);

    // Existing lock file rejected without deleting it
    const lockedDir = join(work, "locked");
    await mkdir(lockedDir);
    const lockPath = join(lockedDir, ".dermoscope.lock");
    await writeFile(lockPath, '{"pid":99999}\n');
    await assert.rejects(() => analyzeFile({ input: pngPath, outputDir: lockedDir, overwrite: true }), /locked/);
    await stat(lockPath);

    // Newly created output directory removed if processing fails
    const badOut = join(work, "failed-out");
    await assert.rejects(() => analyzeFile({ input: join(work, "missing.png"), outputDir: badOut }));
    await assert.rejects(() => stat(badOut), { code: "ENOENT" });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("CLI --help, self-check, per-subcommand option checks, and strict flag validation", () => {
  const help = spawnSync(process.execPath, [BIN, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: dermoscope INPUT OUTPUT_DIR/);

  const selfCheck = spawnSync(process.execPath, [BIN, "self-check"], { encoding: "utf8" });
  assert.equal(selfCheck.status, 0, selfCheck.stderr);
  assert.equal(JSON.parse(selfCheck.stdout).ok, true);

  const badSelf = spawnSync(process.execPath, [BIN, "self-check", "--threshold-bias=bogus"], { encoding: "utf8" });
  assert.notEqual(badSelf.status, 0);
  assert.match(badSelf.stderr, /--threshold-bias is not valid with self-check/);

  const badDl = spawnSync(process.execPath, [BIN, "download-models", "--threshold-bias=0.1"], { encoding: "utf8" });
  assert.notEqual(badDl.status, 0);
  assert.match(badDl.stderr, /--threshold-bias is not valid with download-models/);

  const emptyBias = spawnSync(process.execPath, [BIN, "a.png", "out", "--threshold-bias="], { encoding: "utf8" });
  assert.notEqual(emptyBias.status, 0);
  assert.match(emptyBias.stderr, /--threshold-bias requires a non-empty value/);

  assert.equal(resolvePixelsPerMm({ mmPerPixel: "0.2" }), 5);
  assert.throws(() => resolvePixelsPerMm({ pixelsPerMm: "10", mmPerPixel: "0.1" }), /not both/);
  assert.throws(() => resolvePixelsPerMm({ pixelsPerMm: "" }), /finite number/);
  assert.throws(() => resolvePixelsPerMm({ mmPerPixel: "" }), /finite number/);
});
