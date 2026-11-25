// Offline CLI tests for @neurodesk/wound-planimetry.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { decode as decodePng, encode as encodePng } from "fast-png";
import jpeg from "jpeg-js";
import { checkInstallation, measureFile, resolveCalibration } from "../src/node.js";

const BIN = fileURLToPath(new URL("../bin/wound-planimetry.js", import.meta.url));

function syntheticWoundRgba(width = 80, height = 80) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = x - width / 2;
      const dy = y - height / 2;
      const inWound = dx * dx + dy * dy <= 18 * 18;
      const o = (y * width + x) * 4;
      if (inWound) {
        if (x < width / 2) {
          // Red granulation
          rgba[o] = 190;
          rgba[o + 1] = 48;
          rgba[o + 2] = 44;
        } else {
          // Yellow slough
          rgba[o] = 212;
          rgba[o + 1] = 186;
          rgba[o + 2] = 62;
        }
      } else {
        // Pale surrounding skin
        rgba[o] = 224;
        rgba[o + 1] = 192;
        rgba[o + 2] = 170;
      }
      rgba[o + 3] = 255;
    }
  }
  return rgba;
}

test("checkInstallation passes offline and reports executable metadata", async () => {
  const report = await checkInstallation();
  assert.equal(report.ok, true);
  assert.equal(report.executable, process.execPath);
  assert.equal(report.node, process.version);
});

test("resolveCalibration handles --pixels-per-mm, --mm-per-pixel, --scale-mm/--scale-px/--ruler, conflicts, and empty values", () => {
  assert.deepEqual(resolveCalibration(), { pixelsPerMm: 0, ruler: null });
  assert.equal(resolveCalibration({ pixelsPerMm: "12.5" }).pixelsPerMm, 12.5);
  assert.equal(resolveCalibration({ mmPerPixel: "0.2" }).pixelsPerMm, 5);
  const byPx = resolveCalibration({ scaleMm: "10", scalePx: "100" });
  assert.equal(byPx.pixelsPerMm, 10);
  assert.equal(byPx.ruler.referenceMm, 10);
  const byRuler = resolveCalibration({ scaleMm: "20", ruler: "10,10,110,10" });
  assert.equal(byRuler.pixelsPerMm, 5);
  assert.deepEqual(byRuler.ruler.p1, [10, 10]);
  assert.deepEqual(byRuler.ruler.p2, [110, 10]);

  assert.throws(() => resolveCalibration({ pixelsPerMm: "10", mmPerPixel: "0.1" }), /only one calibration method/);
  assert.throws(() => resolveCalibration({ scaleMm: "10" }), /requires either --scale-px .* or --ruler/);
  assert.throws(() => resolveCalibration({ scalePx: "100" }), /require --scale-mm/);

  // Strict empty/malformed rejections (never coerce "" to 0)
  assert.throws(() => resolveCalibration({ pixelsPerMm: "" }), /finite number/);
  assert.throws(() => resolveCalibration({ mmPerPixel: "" }), /finite number/);
  assert.throws(() => resolveCalibration({ scaleMm: "", scalePx: "100" }), /finite number/);
  assert.throws(() => resolveCalibration({ scaleMm: "10", scalePx: "" }), /finite number/);
  assert.throws(() => resolveCalibration({ scaleMm: "10", ruler: ",0,100,0" }), /X1,Y1,X2,Y2/);
  assert.throws(() => resolveCalibration({ scaleMm: "10", ruler: "0,0,100," }), /X1,Y1,X2,Y2/);
});

test("CLI runs end-to-end on PNG and JPEG inputs with ruler, mm-per-pixel calibration, and locking", async () => {
  const work = await mkdtemp(join(tmpdir(), "wound-planimetry-cli-"));
  try {
    const rgba = syntheticWoundRgba(80, 80);
    const pngPath = join(work, "ulcer.png");
    const jpgPath = join(work, "ulcer.jpg");
    await writeFile(pngPath, encodePng({ width: 80, height: 80, channels: 4, depth: 8, data: rgba }));
    await writeFile(jpgPath, jpeg.encode({ width: 80, height: 80, data: Buffer.from(rgba) }, 95).data);

    const outCal = join(work, "out-cal");
    const res = await measureFile({
      input: pngPath,
      outputDir: outCal,
      scaleMm: "10",
      ruler: "0,0,100,0",
      seed: "40,40",
    });
    assert.ok(res.planimetry.calibrated);
    assert.equal(res.planimetry.pixelsPerMm, 10);
    assert.ok(res.planimetry.areaMm2 > 5);
    assert.ok(res.ryb.classes.red.percent > 20);
    assert.ok(res.ryb.classes.yellow.percent > 20);

    const overlay = decodePng(await readFile(join(outCal, "ulcer_wound-ryb-overlay.png")));
    const mask = decodePng(await readFile(join(outCal, "ulcer_wound-mask.png")));
    assert.equal(overlay.width, 80);
    assert.equal(mask.height, 80);
    const prov = JSON.parse(await readFile(join(outCal, "ulcer_wound-provenance.json"), "utf8"));
    assert.equal(prov.parameters.ruler.referenceMm, 10);
    assert.deepEqual(prov.parameters.seed, [40, 40]);

    const outCli = join(work, "out-cli");
    const cli = spawnSync(process.execPath, [BIN, jpgPath, outCli, "--mm-per-pixel", "0.1"], { encoding: "utf8" });
    assert.equal(cli.status, 0, cli.stderr);
    const csv = await readFile(join(outCli, "ulcer_wound-planimetry.csv"), "utf8");
    assert.match(csv, /calibrated,true/);
    assert.match(csv, /scale_pixels_per_mm,10\.0000/);

    // Reject malformed seed components (never coerce "" to 0)
    await assert.rejects(() => measureFile({ input: pngPath, outputDir: join(work, "bad-seed"), seed: ",10" }), /X,Y/);
    await assert.rejects(() => measureFile({ input: pngPath, outputDir: join(work, "bad-seed2"), seed: "" }), /X,Y/);

    // Existing shared lock file rejected without deleting it
    const lockedDir = join(work, "locked");
    await mkdir(lockedDir);
    const lockPath = join(lockedDir, ".neurodesk-cli.lock");
    await writeFile(lockPath, '{"pid":99999,"tool":"dermoscope"}\n');
    await assert.rejects(
      () => measureFile({ input: pngPath, outputDir: lockedDir, overwrite: true }),
      /\.neurodesk-cli\.lock/,
    );
    await stat(lockPath);

    // Newly created output directory removed on failure
    const badOut = join(work, "failed-out");
    await assert.rejects(() => measureFile({ input: join(work, "missing.png"), outputDir: badOut }));
    await assert.rejects(() => stat(badOut), { code: "ENOENT" });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("CLI --help, self-check, per-subcommand checks, and empty/malformed flag rejection", () => {
  const help = spawnSync(process.execPath, [BIN, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: wound-planimetry INPUT OUTPUT_DIR/);

  const selfCheck = spawnSync(process.execPath, [BIN, "self-check"], { encoding: "utf8" });
  assert.equal(selfCheck.status, 0, selfCheck.stderr);
  assert.equal(JSON.parse(selfCheck.stdout).ok, true);

  const badSelf = spawnSync(process.execPath, [BIN, "self-check", "--sensitivity=0.1"], { encoding: "utf8" });
  assert.notEqual(badSelf.status, 0);
  assert.match(badSelf.stderr, /--sensitivity is not valid with self-check/);

  const badRuler = spawnSync(process.execPath, [BIN, "a.png", "out", "--scale-mm=10", "--ruler=,0,100,0"], {
    encoding: "utf8",
  });
  assert.notEqual(badRuler.status, 0);
  assert.match(badRuler.stderr, /X1,Y1,X2,Y2/);

  const badSeed = spawnSync(process.execPath, [BIN, "a.png", "out", "--seed=,10"], { encoding: "utf8" });
  assert.notEqual(badSeed.status, 0);
  assert.match(badSeed.stderr, /X,Y/);

  const emptyPpm = spawnSync(process.execPath, [BIN, "a.png", "out", "--pixels-per-mm="], { encoding: "utf8" });
  assert.notEqual(emptyPpm.status, 0);
  assert.match(emptyPpm.stderr, /--pixels-per-mm requires a non-empty value/);
});
