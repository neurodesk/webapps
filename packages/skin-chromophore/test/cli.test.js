// Offline CLI tests for @neurodesk/skin-chromophore.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { decode as decodePng, encode as encodePng } from "fast-png";
import jpeg from "jpeg-js";
import { analyzeFile, checkInstallation, downsampleRgbaBilinear } from "../src/node.js";

const BIN = fileURLToPath(new URL("../bin/skin-chromophore.js", import.meta.url));

function syntheticSkinPatch(width = 64, height = 64) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = x - width / 2;
      const dy = y - height / 2;
      const inTarget = dx * dx + dy * dy <= 14 * 14;
      const o = (y * width + x) * 4;
      rgba[o] = inTarget ? 158 : 216;
      rgba[o + 1] = inTarget ? 74 : 178;
      rgba[o + 2] = inTarget ? 68 : 148;
      rgba[o + 3] = 255;
    }
  }
  return rgba;
}

test("checkInstallation passes offline and reports private runtime metadata", async () => {
  const report = await checkInstallation();
  assert.equal(report.ok, true);
  assert.equal(report.executable, process.execPath);
  assert.equal(report.node, process.version);
});

test("downsampleRgbaBilinear uses exact premultiplied-alpha fractional area weights", async () => {
  // 1. Opaque 3x1 gradient [0, 120, 240] downsampled to 2x1:
  // x=0 covers [0, 1.5] => (1.0*0 + 0.5*120) / 1.5 = 40
  // x=1 covers [1.5, 3.0] => (0.5*120 + 1.0*240) / 1.5 = 200
  const src = new Uint8ClampedArray([0, 0, 0, 255, 120, 120, 120, 255, 240, 240, 240, 255]);
  const dst = downsampleRgbaBilinear(src, 3, 1, 2, 1);
  assert.equal(dst[0], 40);
  assert.equal(dst[4], 200);

  // 2. Visually identical transparent PNGs differing only in RGB where alpha===0 must produce identical
  //    downsampled RGB, L*, and ITA° (transparent background RGB must never bleed into opaque edges).
  const makeTransparentScene = (bgRgb) => {
    const w = 96;
    const h = 96;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const o = (y * w + x) * 4;
        const dx = x - 48;
        const dy = y - 48;
        const r2 = dx * dx + dy * dy;
        if (r2 <= 16 * 16) {
          // Dark opaque lesion target
          rgba[o] = 72;
          rgba[o + 1] = 44;
          rgba[o + 2] = 36;
          rgba[o + 3] = 255;
        } else if (r2 <= 34 * 34) {
          // Opaque surrounding skin reference
          rgba[o] = 216;
          rgba[o + 1] = 178;
          rgba[o + 2] = 148;
          rgba[o + 3] = 255;
        } else {
          // Fully transparent border with arbitrary hidden RGB
          rgba[o] = bgRgb[0];
          rgba[o + 1] = bgRgb[1];
          rgba[o + 2] = bgRgb[2];
          rgba[o + 3] = 0;
        }
      }
    }
    return rgba;
  };
  const blackHidden = makeTransparentScene([0, 0, 0]);
  const whiteHidden = makeTransparentScene([255, 255, 255]);
  const dsBlack = downsampleRgbaBilinear(blackHidden, 96, 96, 48, 48);
  const dsWhite = downsampleRgbaBilinear(whiteHidden, 96, 96, 48, 48);
  assert.deepEqual(Array.from(dsBlack), Array.from(dsWhite));

  const work = await mkdtemp(join(tmpdir(), "skin-chromophore-alpha-"));
  try {
    const p1 = join(work, "hidden-black.png");
    const p2 = join(work, "hidden-white.png");
    await writeFile(p1, encodePng({ width: 96, height: 96, channels: 4, depth: 8, data: blackHidden }));
    await writeFile(p2, encodePng({ width: 96, height: 96, channels: 4, depth: 8, data: whiteHidden }));
    const r1 = await analyzeFile({ input: p1, outputDir: join(work, "out1"), maxSide: 48 });
    const r2 = await analyzeFile({ input: p2, outputDir: join(work, "out2"), maxSide: 48 });
    assert.equal(r1.analysis.roi.target.meanL, r2.analysis.roi.target.meanL);
    assert.equal(r1.analysis.roi.target.meanIta, r2.analysis.roi.target.meanIta);
    assert.equal(r1.analysis.roi.reference.meanL, r2.analysis.roi.reference.meanL);
    assert.equal(r1.analysis.roi.comparison.deltaE2000, r2.analysis.roi.comparison.deltaE2000);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("CLI writes hemoglobin, melanin, ITA PNGs, colorimetry CSV, and honest Node provenance JSON", async () => {
  const work = await mkdtemp(join(tmpdir(), "skin-chromophore-cli-"));
  try {
    const rgba = syntheticSkinPatch(64, 64);
    const pngPath = join(work, "erythema.png");
    const jpgPath = join(work, "erythema.jpg");
    await writeFile(pngPath, encodePng({ width: 64, height: 64, channels: 4, depth: 8, data: rgba }));
    await writeFile(jpgPath, jpeg.encode({ width: 64, height: 64, data: Buffer.from(rgba) }, 95).data);

    const outPng = join(work, "out-png");
    const res = await analyzeFile({ input: pngPath, outputDir: outPng, whiteBalance: true, roiMode: "auto" });
    assert.ok(res.analysis.roi.comparison.deltaE2000 > 5);
    assert.ok(res.analysis.roi.comparison.deltaHemoglobin > 0);
    assert.match(res.provenance.input.colorSpace, /Node PNG decode/);

    const hb = decodePng(await readFile(join(outPng, "erythema_hemoglobin.png")));
    const mel = decodePng(await readFile(join(outPng, "erythema_melanin.png")));
    const ita = decodePng(await readFile(join(outPng, "erythema_ita.png")));
    assert.equal(hb.width, 64);
    assert.equal(mel.height, 64);
    assert.equal(ita.width, 64);

    const outJpg = join(work, "out-jpg");
    const cli = spawnSync(process.execPath, [BIN, jpgPath, outJpg, "--roi-mode", "central"], { encoding: "utf8" });
    assert.equal(cli.status, 0, cli.stderr);
    const csv = await readFile(join(outJpg, "erythema_colorimetry.csv"), "utf8");
    assert.match(csv, /target_minus_reference/);
    const prov = JSON.parse(await readFile(join(outJpg, "erythema_provenance.json"), "utf8"));
    assert.equal(prov.settings.roiMode, "central");
    assert.match(prov.input.colorSpace, /Node JPEG decode/);

    // Existing shared lock file rejected without deleting it
    const lockedDir = join(work, "locked");
    await mkdir(lockedDir);
    const lockPath = join(lockedDir, ".neurodesk-cli.lock");
    await writeFile(lockPath, '{"pid":99999,"tool":"dermoscope"}\n');
    await assert.rejects(
      () => analyzeFile({ input: pngPath, outputDir: lockedDir, overwrite: true }),
      /\.neurodesk-cli\.lock/,
    );
    await stat(lockPath);

    // Newly created output directory removed if processing fails
    const badOut = join(work, "failed-out");
    await assert.rejects(() => analyzeFile({ input: join(work, "missing.png"), outputDir: badOut }));
    await assert.rejects(() => stat(badOut), { code: "ENOENT" });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("CLI --help, self-check, per-subcommand checks, and empty option rejection", () => {
  const help = spawnSync(process.execPath, [BIN, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: skin-chromophore INPUT OUTPUT_DIR/);

  const selfCheck = spawnSync(process.execPath, [BIN, "self-check"], { encoding: "utf8" });
  assert.equal(selfCheck.status, 0, selfCheck.stderr);
  assert.equal(JSON.parse(selfCheck.stdout).ok, true);

  const badSelf = spawnSync(process.execPath, [BIN, "self-check", "--white-balance"], { encoding: "utf8" });
  assert.notEqual(badSelf.status, 0);
  assert.match(badSelf.stderr, /--white-balance is not valid with self-check/);

  const emptyRoi = spawnSync(process.execPath, [BIN, "a.png", "out", "--roi-mode="], { encoding: "utf8" });
  assert.notEqual(emptyRoi.status, 0);
  assert.match(emptyRoi.stderr, /--roi-mode requires a non-empty value/);

  const emptyMax = spawnSync(process.execPath, [BIN, "a.png", "out", "--max-side="], { encoding: "utf8" });
  assert.notEqual(emptyMax.status, 0);
  assert.match(emptyMax.stderr, /--max-side requires a non-empty value/);

  const floatMax = spawnSync(process.execPath, [BIN, "a.png", "out", "--max-side=128.5"], { encoding: "utf8" });
  assert.notEqual(floatMax.status, 0);
  assert.match(floatMax.stderr, /--max-side must be an integer/);
});
