import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync, unzipSync, unzlibSync } from "fflate";
import { archiveBudget, conversionPlan, writeOmeZarr } from "../src/writer.js";
import { readOzxVersion } from "@fideus-labs/ngff-zarr";
import { ARRAY_TYPES } from "../src/pyramid.js";
import { archiveName, ZIP_MAX_ENTRIES, zipStore } from "../src/zip.js";
import { readBackLevels, rootAttributes, schemaErrors, sha256 } from "../validation/checks.mjs";

// The numpy pyramids of these images (validation/synthetic_reference.py).
const REFERENCE = JSON.parse(readFileSync(new URL("./synthetic-reference.json", import.meta.url), "utf8"));
const AXES = ["t", "c", "z", "y", "x"];

/** value(t, c, z, y, x) exactly as synthetic_reference.py computes it. */
function syntheticValue(dtype, [t, c, z, y, x]) {
  const raw = (t * 7919 + c * 104729 + z * 1299709 + y * 31 + x * 17 + ((y * x) % 13)) % 1000003;
  if (dtype.startsWith("float")) return raw / 7 - 50000;
  const bits = ARRAY_TYPES[dtype].BYTES_PER_ELEMENT * 8;
  const span = 2 ** bits;
  const min = dtype.startsWith("u") ? 0 : -(2 ** (bits - 1));
  return ((raw * 2654435761) % span) + min;
}

function syntheticSource({ dtype, shape }, extra = {}) {
  const [T, C, Z, Y, X] = shape;
  return {
    name: "synthetic",
    format: "synthetic",
    dtype,
    shape: { t: T, c: C, z: Z, y: Y, x: X },
    scale: { t: 2.5, z: 0.5, y: 0.1, x: 0.2 },
    units: { t: "second", z: "micrometer", y: "micrometer", x: "micrometer" },
    channels: Array.from({ length: C }, (_, index) => ({ label: index ? null : "DAPI", color: index ? null : "0000FF" })),
    notes: [],
    async readPlane(t, c, z) {
      const plane = new ARRAY_TYPES[dtype](Y * X);
      for (let y = 0; y < Y; y += 1) for (let x = 0; x < X; x += 1) plane[y * X + x] = syntheticValue(dtype, [t, c, z, y, x]);
      return plane;
    },
    ...extra,
  };
}

async function convert(source, options) {
  const map = new Map();
  const result = await writeOmeZarr(source, { set: (key, bytes) => map.set(key, bytes) }, options);
  return { map, result };
}

for (const reference of REFERENCE) {
  for (const version of ["0.4", "0.5"]) {
    for (const method of ["nearest", "mean"]) {
      test(`${reference.id} ${reference.shape.join("×")} NGFF ${version} ${method}: every level read back equals numpy`, async () => {
        const { map } = await convert(syntheticSource(reference), { version, method, chunk: 16, target: reference.target });
        const { levels } = await readBackLevels(map);
        assert.equal(levels[0].sha256, reference.source, "level 0 is the source, bit for bit");
        assert.deepEqual(levels.map(({ shape, sha256: hash }) => ({ shape, sha256: hash })), reference[method]);
        assert.ok(levels.every((level) => level.data instanceof ARRAY_TYPES[reference.dtype]));
        assert.deepEqual(schemaErrors(rootAttributes(map, version), version), []);
      });
    }
  }
}

test("NGFF 0.4 writes Zarr v2 with zlib and '/'-nested chunk keys", async () => {
  const source = syntheticSource(REFERENCE.find(({ id }) => id === "uint16"));
  const { map } = await convert(source, { version: "0.4", chunk: 16, target: 16 });
  assert.deepEqual(JSON.parse(new TextDecoder().decode(map.get(".zgroup"))), { zarr_format: 2 });
  const array = JSON.parse(new TextDecoder().decode(map.get("0/.zarray")));
  assert.deepEqual(array, { chunks: [1, 1, 1, 16, 16], compressor: { id: "zlib", level: 6 }, dimension_separator: "/", dtype: "<u2", fill_value: 0, filters: null, order: "C", shape: [2, 3, 3, 37, 53], zarr_format: 2 });
  assert.ok(map.has("0/1/2/2/2/3"), "the last chunk of level 0 is 0/t/c/z/y/x");
  assert.ok(!map.has("0/1/2/2/3/0"));
  assert.ok(!map.has("zarr.json"));
});

test("NGFF 0.5 writes Zarr v3 with gzip, dimension names and the default chunk key encoding", async () => {
  const source = syntheticSource(REFERENCE.find(({ id }) => id === "uint16"));
  const { map } = await convert(source, { version: "0.5", chunk: 16, target: 16 });
  const group = JSON.parse(new TextDecoder().decode(map.get("zarr.json")));
  assert.equal(group.node_type, "group");
  assert.equal(group.attributes.ome.version, "0.5");
  const array = JSON.parse(new TextDecoder().decode(map.get("1/zarr.json")));
  assert.deepEqual(array.shape, [2, 3, 3, 18, 26]);
  assert.deepEqual(array.chunk_grid, { name: "regular", configuration: { chunk_shape: [1, 1, 1, 16, 16] } });
  assert.deepEqual(array.codecs, [{ name: "bytes", configuration: { endian: "little" } }, { name: "gzip", configuration: { level: 6 } }]);
  assert.deepEqual(array.dimension_names, AXES);
  assert.ok(map.has("2/c/1/2/2/0/0"));
  // The smallest level fits in one chunk smaller than the chunk size.
  assert.deepEqual(JSON.parse(new TextDecoder().decode(map.get("2/zarr.json"))).chunk_grid.configuration.chunk_shape, [1, 1, 1, 9, 13]);
});

test("edge chunks are padded with the fill value", async () => {
  const source = syntheticSource({ dtype: "uint8", shape: [1, 1, 1, 19, 23] });
  for (const [version, key, decode] of [["0.4", "0/0/0/0/1/1", unzlibSync], ["0.5", "0/c/0/0/0/1/1", gunzipSync]]) {
    const { map } = await convert(source, { version, chunk: 16, target: 16 });
    const tile = decode(map.get(key));
    assert.equal(tile.length, 16 * 16);
    for (let row = 0; row < 16; row += 1) {
      for (let column = 0; column < 16; column += 1) {
        const inside = 16 + row < 19 && 16 + column < 23;
        const expected = inside ? syntheticValue("uint8", [0, 0, 0, 16 + row, 16 + column]) : 0;
        assert.equal(tile[row * 16 + column], expected, `${version} tile (${row}, ${column})`);
      }
    }
  }
});

test("metadata carries scales per level, units, channel names, colours and windows", async () => {
  const source = syntheticSource(REFERENCE.find(({ id }) => id === "int16"));
  const { map, result } = await convert(source, { version: "0.5", chunk: 16, target: 16, method: "nearest" });
  const { multiscales, omero } = rootAttributes(map, "0.5").ome;
  const [image] = multiscales;
  assert.deepEqual(image.axes, [
    { name: "t", type: "time", unit: "second" },
    { name: "c", type: "channel" },
    { name: "z", type: "space", unit: "micrometer" },
    { name: "y", type: "space", unit: "micrometer" },
    { name: "x", type: "space", unit: "micrometer" },
  ]);
  assert.deepEqual(image.datasets.map(({ coordinateTransformations: [{ scale }] }) => scale), [
    [2.5, 1, 0.5, 0.1, 0.2],
    [2.5, 1, 0.5, 0.2, 0.4],
    [2.5, 1, 0.5, 0.4, 0.8],
  ]);
  assert.equal(image.type, "nearest");
  assert.deepEqual(omero.channels.map(({ label, color }) => [label, color]), [["DAPI", "0000FF"], ["Channel 1", "00FF00"]]);
  // Windows are the level-0 range of each channel.
  const { levels } = await readBackLevels(map);
  const plane = 37 * 53;
  for (let c = 0; c < 2; c += 1) {
    const values = levels[0].data.subarray(c * plane, (c + 1) * plane);
    const min = Math.min(...values);
    const max = Math.max(...values);
    assert.deepEqual(omero.channels[c].window, { min, max, start: min, end: max });
    assert.deepEqual(result.ranges[c], [min, max]);
  }
  assert.deepEqual(omero.rdefs, { defaultT: 0, defaultZ: 0, model: "color" });
});

test("axes without a known unit or scale are written without a unit and with scale 1", async () => {
  const source = syntheticSource({ dtype: "uint8", shape: [1, 1, 3, 4, 5] }, { scale: { t: null, z: null, y: 0.3, x: 0.3 }, units: { t: null, z: null, y: "furlong", x: "nanometer" } });
  const { map } = await convert(source, { version: "0.4" });
  const [image] = rootAttributes(map, "0.4").multiscales;
  assert.deepEqual(image.axes.map((axis) => axis.unit ?? null), [null, null, null, null, "nanometer"]);
  assert.deepEqual(image.datasets[0].coordinateTransformations[0].scale, [1, 1, 1, 0.3, 0.3]);
  assert.equal(image.version, "0.4");
  assert.deepEqual(schemaErrors(rootAttributes(map, "0.4"), "0.4"), []);
});

test("the schemas reject metadata that breaks the specification", async () => {
  const source = syntheticSource({ dtype: "uint8", shape: [1, 1, 1, 4, 4] });
  for (const version of ["0.4", "0.5"]) {
    const { map } = await convert(source, { version });
    const attributes = rootAttributes(map, version);
    const multiscales = version === "0.4" ? attributes.multiscales[0] : attributes.ome.multiscales[0];
    multiscales.datasets[0].coordinateTransformations = [{ type: "translation", translation: [0, 0, 0, 0, 0] }];
    assert.ok(schemaErrors(attributes, version).length > 0, `${version}: a dataset without its scale must fail`);
    delete multiscales.axes;
    assert.ok(schemaErrors(attributes, version).some((error) => error.includes("axes")), `${version}: missing axes must fail`);
  }
});

const bytesOf = async (blob) => new Uint8Array(await blob.arrayBuffer());

test("archives: 0.5 is an RFC-9 .ozx with zarr.json first; 0.4 a stored zip with metadata first", async () => {
  const source = syntheticSource({ dtype: "uint16", shape: [1, 2, 2, 20, 20] });
  const v5 = await convert(source, { version: "0.5", chunk: 16, target: 16 });
  const blob = await zipStore(v5.map, "0.5");
  assert.ok(blob instanceof Blob);
  const ozx = await bytesOf(blob);
  assert.equal(readOzxVersion(ozx), "0.5");
  const comment = new TextDecoder().decode(ozx.subarray(ozx.length - 200)).match(/\{.*\}/s)[0];
  assert.equal(JSON.parse(comment).ome.zipFile.centralDirectory.jsonFirst, true);
  const entries = unzipSync(ozx);
  assert.equal(Object.keys(entries)[0], "zarr.json");
  assert.deepEqual(Object.keys(entries).slice(0, 3).sort(), ["0/zarr.json", "1/zarr.json", "zarr.json"]);
  assert.deepEqual(Object.keys(entries).sort(), [...v5.map.keys()].sort());
  for (const [key, bytes] of Object.entries(entries)) assert.equal(sha256(bytes), sha256(v5.map.get(key)));
  const v4 = await convert(source, { version: "0.4", chunk: 16, target: 16 });
  const zip = unzipSync(await bytesOf(await zipStore(v4.map, "0.4")));
  assert.deepEqual(Object.keys(zip).slice(0, 2), [".zattrs", ".zgroup"]);
  assert.deepEqual(Object.keys(zip).sort(), [...v4.map.keys()].sort());
  assert.equal(archiveName("cells", "0.5"), "cells.ozx");
  assert.equal(archiveName("cells", "0.4"), "cells.ome.zarr.zip");
});

test("a store with more files than a zip can hold is refused before any archive is built", async () => {
  const map = new Map(Array.from({ length: ZIP_MAX_ENTRIES + 1 }, (_, index) => [`0/${index}`, new Uint8Array(0)]));
  await assert.rejects(zipStore(map, "0.4"), /at most 65535/);
});

/** Bytes no codec can shrink (xorshift32), so the store is as large as it can get. */
function noiseSource(shape, dtype = "uint16") {
  const [, C, , Y, X] = shape;
  return syntheticSource({ dtype, shape }, {
    async readPlane(t, c, z) {
      let state = (t * 7919 + c * 104729 + z * 1299709 + 1) >>> 0;
      const bytes = new Uint8Array(Y * X * ARRAY_TYPES[dtype].BYTES_PER_ELEMENT);
      for (let i = 0; i < bytes.length; i += 1) {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        bytes[i] = state >>> 24;
      }
      return new ARRAY_TYPES[dtype](bytes.buffer);
    },
    channels: Array.from({ length: C }, () => ({ label: null, color: null })),
  });
}

test("the archive budget bounds the store and its zip, even for incompressible pixels", async () => {
  for (const [version, shape, chunk] of [["0.5", [1, 2, 3, 70, 90], 32], ["0.4", [2, 1, 2, 33, 129], 16]]) {
    const options = { version, chunk, target: chunk, compressionLevel: 9 };
    const { map } = await convert(noiseSource(shape), options);
    const budget = archiveBudget({ t: shape[0], c: shape[1], z: shape[2], y: shape[3], x: shape[4] }, "uint16", options);
    const archive = await zipStore(map, version);
    assert.equal(budget.entries, map.size, `${version}: every store file is counted`);
    assert.ok(archive.size <= budget.bytes, `${version}: archive ${archive.size} within budget ${budget.bytes}`);
  }
});

test("a store that passes maxBytes stops the conversion", async () => {
  const map = new Map();
  const source = noiseSource([1, 1, 4, 64, 64]);
  await assert.rejects(writeOmeZarr(source, { set: (key, bytes) => map.set(key, bytes) }, { chunk: 32, target: 32 }, { maxBytes: 20000 }), /passed its limit of 20000 bytes/);
  assert.ok([...map.values()].reduce((sum, bytes) => sum + bytes.byteLength, 0) <= 20000);
  assert.ok(!map.has("zarr.json"));
});

test("windows ignore NaN and ±Infinity; an all-NaN channel gets a finite window", async () => {
  const values = [NaN, Infinity, -Infinity, 2.5, -1.25, 7];
  const source = syntheticSource({ dtype: "float32", shape: [1, 2, 2, 2, 3] }, {
    async readPlane(_t, c, z) {
      return Float32Array.from(c === 1 ? values.map(() => NaN) : values.map((value) => (Number.isFinite(value) ? value * (z + 1) : value)));
    },
  });
  for (const version of ["0.4", "0.5"]) {
    const { map, result } = await convert(source, { version });
    const attributes = rootAttributes(map, version);
    const omero = version === "0.4" ? attributes.omero : attributes.ome.omero;
    assert.deepEqual(omero.channels[0].window, { min: -2.5, max: 14, start: -2.5, end: 14 });
    assert.deepEqual(omero.channels[1].window, { min: 0, max: 0, start: 0, end: 0 });
    assert.deepEqual(result.ranges, [[-2.5, 14], [0, 0]]);
    assert.deepEqual(schemaErrors(attributes, version), [], `${version} strict schema`);
  }
});

test("the conversion hands the thread back: a timer and an abort run while it writes", async () => {
  const source = noiseSource([1, 1, 24, 512, 512]);
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 1);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 40);
  const map = new Map();
  try {
    await assert.rejects(writeOmeZarr(source, { set: (key, bytes) => map.set(key, bytes) }, { compressionLevel: 9 }, { signal: controller.signal }), { name: "AbortError" });
  } finally {
    clearInterval(timer);
  }
  assert.ok(ticks > 0, "timers ran during the conversion");
  assert.ok(!map.has("zarr.json"), "it stopped before the metadata");
});

test("min-is-white channels are marked inverted in omero", async () => {
  const source = syntheticSource({ dtype: "uint8", shape: [1, 1, 1, 4, 4] }, { channels: [{ label: null, color: null, inverted: true }] });
  const { map } = await convert(source, { version: "0.5" });
  const { omero } = rootAttributes(map, "0.5").ome;
  assert.equal(omero.channels[0].inverted, true);
  assert.deepEqual(schemaErrors(rootAttributes(map, "0.5"), "0.5"), []);
});

test("the plan follows the target: levels halve while the larger side exceeds it", () => {
  const plan = conversionPlan({ t: 1, c: 2, z: 32, y: 515, x: 771 }, {});
  assert.deepEqual(plan.map(({ shape }) => shape), [[1, 2, 32, 515, 771], [1, 2, 32, 257, 385], [1, 2, 32, 128, 192]]);
  assert.deepEqual(plan.map(({ chunks }) => chunks), [[1, 1, 1, 256, 256], [1, 1, 1, 256, 256], [1, 1, 1, 128, 192]]);
  assert.equal(conversionPlan({ t: 1, c: 1, z: 1, y: 256, x: 100 }, {}).length, 1);
});

test("a cancelled conversion stops before the next plane and writes no group metadata", async () => {
  const controller = new AbortController();
  const source = syntheticSource({ dtype: "uint8", shape: [1, 1, 4, 8, 8] });
  const map = new Map();
  await assert.rejects(writeOmeZarr(source, { set: (key, bytes) => map.set(key, bytes) }, {}, {
    signal: controller.signal,
    onProgress: (fraction) => { if (fraction >= 0.5) controller.abort(); },
  }), { name: "AbortError" });
  assert.ok(!map.has("zarr.json"));
  assert.equal([...map.keys()].length, 2, "two planes of one chunk each");
});

test("a plane of the wrong type or size is refused", async () => {
  const source = syntheticSource({ dtype: "uint16", shape: [1, 1, 1, 4, 4] }, { readPlane: async () => new Uint8Array(16) });
  await assert.rejects(convert(source, {}), /is not 4 × 4 uint16/);
  await assert.rejects(convert(syntheticSource({ dtype: "uint8", shape: [1, 1, 1, 4, 4] }), { version: "0.6" }), /0\.6 is not supported/);
});
