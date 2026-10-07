import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { loadLcmodel } from "../src/wasm.js";

function niftiMrs({ singleton = false, version = 1, water = false } = {}) {
  const metadata = Buffer.from(JSON.stringify({
    SpectrometerFrequency: [123.25], ResonantNucleus: ["1H"],
    EchoTime: water ? 0.02 : 0.03, RepetitionTime: water ? 3 : 2,
    SequenceName: "PRESS",
    ...(singleton ? { dim_5: "DIM_COIL", dim_6: "DIM_DYN" } : { dim_5: "DIM_DYN" }),
  }));
  const extensionSize = Math.ceil((metadata.length + 8) / 16) * 16;
  const extensionOffset = version === 2 ? 544 : 352;
  const offset = extensionOffset + extensionSize;
  const points = 1024;
  const averages = 4;
  const bytes = Buffer.alloc(offset + points * averages * 8);
  const dimensions = [singleton ? 6 : 5, 1, 1, 1, points, ...(singleton ? [1, averages] : [averages, 1]), 1];
  if (version === 2) {
    bytes.writeInt32LE(540, 0);
    bytes.write("n+2\0\r\n\x1a\n", 4, "binary");
    bytes.writeInt16LE(32, 12);
    bytes.writeInt16LE(64, 14);
    dimensions.forEach((d, k) => bytes.writeBigInt64LE(BigInt(d), 16 + k * 8));
    bytes.writeDoubleLE(0.0005, 136);
    bytes.writeBigInt64LE(BigInt(offset), 168);
  } else {
    bytes.writeInt32LE(348, 0);
    bytes.write("n+1\0", 344, "binary");
    dimensions.forEach((d, k) => bytes.writeInt16LE(d, 40 + k * 2));
    bytes.writeInt16LE(32, 70);
    bytes.writeInt16LE(64, 72);
    bytes.writeFloatLE(0.0005, 92);
    bytes.writeFloatLE(offset, 108);
  }
  bytes[extensionOffset - 4] = 1;
  bytes.writeInt32LE(extensionSize, extensionOffset);
  bytes.writeInt32LE(44, extensionOffset + 4);
  metadata.copy(bytes, extensionOffset + 8);
  for (let k = 0; k < points * averages; k++) {
    const time = (k % points) * 0.0005;
    const phase = 2 * Math.PI * (water ? 0 : 325) * time;
    const amplitude = Math.exp(-10 * time);
    bytes.writeFloatLE(amplitude * Math.cos(phase), offset + k * 8);
    bytes.writeFloatLE(amplitude * Math.sin(phase), offset + k * 8 + 4);
  }
  return bytes;
}

async function module() {
  return loadLcmodel(await readFile(new URL("../src/lcmodel.wasm", import.meta.url)));
}

for (const version of [1, 2]) {
  test(`NIfTI-${version} MRS singleton coil processes like coil-combined dynamics`, async () => {
    const lcm = await module();
    const processed = [];
    for (const singleton of [false, true]) {
      lcm.reset();
      const bytes = niftiMrs({ singleton, version });
      lcm.addFile("spectra.nii.gz", gzipSync(bytes));
      const loaded = lcm.load();
      assert.deepEqual(loaded.errors, []);
      assert.equal(loaded.datasets.length, 1);
      assert.equal(loaded.datasets[0].header.coils, 1);
      assert.equal(loaded.datasets[0].header.averages, 4);
      const result = lcm.process(0);
      assert.equal(result.error, undefined);
      assert.ok(result.lcmodel.raw);
      processed.push(result.lcmodel.raw);
    }
    assert.equal(processed[0], processed[1]);
  });
}

test("NIfTI-MRS acquisition times stay in milliseconds through preprocessing and RAW export", async () => {
  const lcm = await module();
  lcm.addFile("spectra.nii", niftiMrs());
  lcm.addFile("spectra_ref.nii", niftiMrs({ water: true }));
  const loaded = lcm.load();
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.datasets.length, 1);
  const header = loaded.datasets[0].header;
  assert.equal(header.teMs, 30);
  assert.equal(header.trMs, 2000);
  assert.equal(header.waterTeMs, 20);
  assert.equal(header.waterTrMs, 3000);
  const result = lcm.process(0);
  assert.equal(result.error, undefined);
  assert.equal(result.header.teMs, 30);
  assert.equal(result.header.trMs, 2000);
  assert.match(result.lcmodel.raw, /echot= 30\.00/);
  assert.match(result.lcmodel.h2o, /echot= 20\.00/);
});
