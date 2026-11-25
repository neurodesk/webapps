// Offline CLI tests for @neurodesk/skin-chromophore.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { decode as decodePng, encode as encodePng } from "fast-png";
import jpeg from "jpeg-js";
import { analyzeFile, checkInstallation } from "../src/node.js";

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

test("CLI writes hemoglobin, melanin, ITA PNGs, colorimetry CSV, and provenance JSON", async () => {
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
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("CLI --help and self-check exit 0", () => {
  const help = spawnSync(process.execPath, [BIN, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: skin-chromophore INPUT OUTPUT_DIR/);

  const selfCheck = spawnSync(process.execPath, [BIN, "self-check"], { encoding: "utf8" });
  assert.equal(selfCheck.status, 0, selfCheck.stderr);
  assert.equal(JSON.parse(selfCheck.stdout).ok, true);
});
