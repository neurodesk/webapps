// Offline tests for @neurodesk/dermvit CLI, raster decoding, self-check, and manifest sync.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { encode as encodePng } from "fast-png";
import jpeg from "jpeg-js";
import { checkInstallation, classifyFile, downloadModels, resolveThreads } from "../src/node.js";
import { decodeRasterBytes } from "../src/raster.js";

const BIN = fileURLToPath(new URL("../bin/dermvit.js", import.meta.url));

test("package model.manifest.json stays identical to models/dermvit.manifest.json", async () => {
  const pkgManifest = await readFile(new URL("../model.manifest.json", import.meta.url), "utf8");
  const repoManifest = await readFile(new URL("../../../models/dermvit.manifest.json", import.meta.url), "utf8");
  assert.equal(pkgManifest, repoManifest);
});

test("decodeRasterBytes decodes PNG (RGBA/RGB/gray) and JPEG cleanly and rejects non-images", () => {
  const rgbaPng = encodePng({
    width: 2,
    height: 2,
    channels: 4,
    depth: 8,
    data: new Uint8Array([10, 20, 30, 255, 40, 50, 60, 128, 70, 80, 90, 255, 100, 110, 120, 255]),
  });
  const decRgba = decodeRasterBytes(rgbaPng, { name: "a.png" });
  assert.equal(decRgba.format, "png");
  assert.equal(decRgba.width, 2);
  assert.equal(decRgba.height, 2);
  assert.equal(decRgba.rgba[0], 10);
  assert.equal(decRgba.rgba[7], 128);

  const grayPng = encodePng({ width: 2, height: 1, channels: 1, depth: 8, data: new Uint8Array([50, 200]) });
  const decGray = decodeRasterBytes(grayPng, { name: "g.png" });
  assert.deepEqual(Array.from(decGray.rgba), [50, 50, 50, 255, 200, 200, 200, 255]);

  const jpg = jpeg.encode({
    width: 2,
    height: 2,
    data: Buffer.from([200, 100, 50, 255, 100, 150, 200, 255, 50, 50, 50, 255, 250, 250, 250, 255]),
  }, 95);
  const decJpg = decodeRasterBytes(jpg.data, { name: "b.jpg" });
  assert.equal(decJpg.format, "jpeg");
  assert.equal(decJpg.width, 2);
  assert.equal(decJpg.height, 2);
  assert.equal(decJpg.rgba.length, 16);

  assert.throws(() => decodeRasterBytes(new Uint8Array([1, 2, 3, 4]), { name: "bad.bin" }), /not a PNG or JPEG/);
});

test("checkInstallation executes ONNX Runtime CPU identity graph offline", async () => {
  const report = await checkInstallation();
  assert.equal(report.ok, true);
  assert.equal(report.executable, process.execPath);
  assert.equal(report.node, process.version);
  assert.equal(report.executionProvider, "cpu");
  assert.match(report.onnxRuntime, /^\d+\.\d+\.\d+/);
});

test("offline mode rejects missing or corrupted cached models without touching the network", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dermvit-offline-"));
  try {
    await assert.rejects(
      () => downloadModels({ cacheDir: dir, offline: true }),
      /missing from the offline model directory/,
    );
    await writeFile(join(dir, "model_quantized.onnx"), Buffer.from("corrupt"));
    await assert.rejects(
      () => downloadModels({ cacheDir: dir, offline: true }),
      /failed checksum verification/,
    );
    const pngPath = join(dir, "sample.png");
    await writeFile(pngPath, encodePng({ width: 4, height: 4, channels: 4, depth: 8, data: new Uint8Array(64).fill(180) }));
    await assert.rejects(
      () => classifyFile({ input: pngPath, outputDir: join(dir, "out"), cacheDir: dir, offline: true }),
      /failed checksum verification/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI --help and self-check exit 0 and resolveThreads validates inputs", () => {
  const help = spawnSync(process.execPath, [BIN, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: dermvit INPUT OUTPUT_DIR/);

  const selfCheck = spawnSync(process.execPath, [BIN, "self-check"], { encoding: "utf8" });
  assert.equal(selfCheck.status, 0, selfCheck.stderr);
  const parsed = JSON.parse(selfCheck.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.executable, process.execPath);

  assert.equal(resolveThreads("2"), 2);
  assert.throws(() => resolveThreads("0"), /positive integer/);
  assert.throws(() => resolveThreads("abc"), /positive integer/);
});
