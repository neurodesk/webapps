// Offline CLI tests for @neurodesk/derm-compare.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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

function rotateRgba270Cw(rgba, width, height) {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = y;
      const dy = width - 1 - x;
      const src = (y * width + x) * 4;
      const dst = (dy * height + dx) * 4;
      out[dst] = rgba[src];
      out[dst + 1] = rgba[src + 1];
      out[dst + 2] = rgba[src + 2];
      out[dst + 3] = rgba[src + 3];
    }
  }
  return out;
}

function injectExifOrientation6(jpegBytes) {
  const header = Buffer.from("Exif\0\0", "ascii");
  const tiff = Buffer.alloc(26, 0);
  tiff.write("MM", 0, "ascii");
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(1, 8);
  tiff.writeUInt16BE(0x0112, 10);
  tiff.writeUInt16BE(3, 12);
  tiff.writeUInt32BE(1, 14);
  tiff.writeUInt16BE(6, 18);
  const payload = Buffer.concat([header, tiff]);
  const seg = Buffer.alloc(4 + payload.length);
  seg[0] = 0xff;
  seg[1] = 0xe1;
  seg.writeUInt16BE(payload.length + 2, 2);
  payload.copy(seg, 4);
  return Buffer.concat([Buffer.from(jpegBytes.subarray(0, 2)), seg, Buffer.from(jpegBytes.subarray(2))]);
}

test("checkInstallation passes offline and reports executable and node version", async () => {
  const report = await checkInstallation();
  assert.equal(report.ok, true);
  assert.equal(report.executable, process.execPath);
  assert.equal(report.node, process.version);
});

test("CLI aligns synthetic shifted pair and EXIF-rotated JPEG cleanly and enforces directory locks", async () => {
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

    // Follow-up stored rotated 270° CW with EXIF Orientation 6 (90° CW) must align with ~0° rotation
    const storedRot = rotateRgba270Cw(baseRgba, 80, 80);
    const rotJpg = injectExifOrientation6(jpeg.encode({ width: 80, height: 80, data: Buffer.from(storedRot) }, 98).data);
    const rotPath = join(work, "t1-exif6.jpg");
    await writeFile(rotPath, rotJpg);
    const rotRes = await compareFiles({
      baseline: basePath,
      followup: rotPath,
      outputDir: join(work, "out-exif"),
      maxAngle: 5,
    });
    assert.equal(rotRes.result.registered, true);
    assert.ok(rotRes.result.registration.alignedNcc > 0.95);
    assert.ok(Math.abs(rotRes.result.registration.angleDeg) < 2);

    const cliOut = join(work, "out-cli");
    const cli = spawnSync(process.execPath, [BIN, basePath, follPath, cliOut, "--max-angle", "10"], { encoding: "utf8" });
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout.trim(), /t0_vs_t1_metrics\.csv$/);

    // Existing shared lock file rejected without deleting it
    const lockedDir = join(work, "locked");
    await mkdir(lockedDir);
    const lockPath = join(lockedDir, ".neurodesk-cli.lock");
    await writeFile(lockPath, '{"pid":99999,"tool":"dermoscope"}\n');
    await assert.rejects(
      () => compareFiles({ baseline: basePath, followup: follPath, outputDir: lockedDir, overwrite: true }),
      /\.neurodesk-cli\.lock/,
    );
    await stat(lockPath);

    // Newly created output directory removed on failure
    const badOut = join(work, "failed-out");
    await assert.rejects(() =>
      compareFiles({ baseline: join(work, "missing.png"), followup: follPath, outputDir: badOut }),
    );
    await assert.rejects(() => stat(badOut), { code: "ENOENT" });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("CLI --help, self-check, per-subcommand checks, and empty option rejection", () => {
  const help = spawnSync(process.execPath, [BIN, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: derm-compare BASELINE FOLLOWUP OUTPUT_DIR/);

  const selfCheck = spawnSync(process.execPath, [BIN, "self-check"], { encoding: "utf8" });
  assert.equal(selfCheck.status, 0, selfCheck.stderr);
  assert.equal(JSON.parse(selfCheck.stdout).ok, true);

  const badSelf = spawnSync(process.execPath, [BIN, "self-check", "--max-angle=10"], { encoding: "utf8" });
  assert.notEqual(badSelf.status, 0);
  assert.match(badSelf.stderr, /--max-angle is not valid with self-check/);

  const emptyAngle = spawnSync(process.execPath, [BIN, "a.png", "b.png", "out", "--max-angle="], { encoding: "utf8" });
  assert.notEqual(emptyAngle.status, 0);
  assert.match(emptyAngle.stderr, /--max-angle requires a non-empty value/);
});
