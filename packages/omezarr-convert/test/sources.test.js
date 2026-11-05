import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { encode as encodePng } from "fast-png";
import jpeg from "jpeg-js";
import { fileKind, openSource, withMetadata } from "../src/sources/index.js";
import { decodeRaster, naturalOrder, unpackBits } from "../src/sources/raster.js";
import { rgbaColour } from "../src/sources/source.js";
import { writeOmeZarr } from "../src/writer.js";
import { readBackLevels, rootAttributes, schemaErrors } from "../validation/checks.mjs";

const here = (path) => new URL(path, import.meta.url);
const file = async (url, name = url.pathname.split("/").at(-1)) => new File([await readFile(url)], name);
const omeValue = (t, c, z, y, x) => (t * 1000 + c * 100 + z * 10 + y * 3 + x) % 251;

async function planes(source) {
  const out = [];
  for (let t = 0; t < source.shape.t; t += 1) for (let c = 0; c < source.shape.c; c += 1) for (let z = 0; z < source.shape.z; z += 1) out.push({ t, c, z, plane: await source.readPlane(t, c, z) });
  return out;
}

test("an OME-TIFF keeps T, C, Z, per-axis units, channel names and colours", async () => {
  const source = await openSource([await file(here("./fixtures/tczyx-named.ome.tif"))]);
  assert.equal(source.format, "OME-TIFF");
  assert.equal(source.name, "named channels");
  assert.deepEqual(source.shape, { t: 2, c: 3, z: 2, y: 5, x: 6 });
  assert.equal(source.dtype, "uint16");
  assert.deepEqual(source.scale, { t: null, z: 0.3, y: 65, x: 65 });
  assert.deepEqual(source.units, { t: null, z: "micrometer", y: "nanometer", x: "nanometer" });
  assert.deepEqual(source.channels, [{ label: "DAPI", color: "0000FF" }, { label: "GFP", color: "00FF00" }, { label: "mCherry", color: "FF0000" }]);
  for (const { t, c, z, plane } of await planes(source)) {
    assert.ok(plane instanceof Uint16Array);
    assert.deepEqual(Array.from(plane), Array.from({ length: 30 }, (_, i) => omeValue(t, c, z, Math.floor(i / 6), i % 6)), `plane t${t} c${c} z${z}`);
  }
  const map = new Map();
  await writeOmeZarr(source, { set: (key, bytes) => map.set(key, bytes) }, { version: "0.5" });
  const { ome } = rootAttributes(map, "0.5");
  assert.deepEqual(ome.multiscales[0].axes.map(({ unit }) => unit ?? null), [null, null, "micrometer", "nanometer", "nanometer"]);
  assert.deepEqual(ome.multiscales[0].datasets[0].coordinateTransformations[0].scale, [1, 1, 0.3, 65, 65]);
  assert.deepEqual(ome.omero.channels.map(({ label }) => label), ["DAPI", "GFP", "mCherry"]);
  assert.deepEqual(schemaErrors({ ome }, "0.5"), []);
});

test("an OME-TIFF without physical sizes leaves scale and unit unset", async () => {
  const source = await openSource([await file(here("./fixtures/zyx-float.ome.tif"))]);
  assert.deepEqual(source.shape, { t: 1, c: 1, z: 3, y: 4, x: 7 });
  assert.equal(source.dtype, "float32");
  assert.deepEqual(source.scale, { t: null, z: null, y: null, x: null });
  assert.deepEqual(source.units, { t: null, z: null, y: null, x: null });
  const [, second] = await planes(source);
  assert.deepEqual(Array.from(second.plane), Array.from({ length: 28 }, (_, i) => Math.fround(omeValue(0, 0, 1, Math.floor(i / 7), i % 7) / 3)));
});

test("OME-XML with a namespace prefix is read through fiff", async () => {
  const source = await openSource([await file(here("../../components/test/fixtures/tiff/prefixed-ome.tif"))]);
  assert.equal(source.format, "OME-TIFF");
  assert.equal(source.name, "prefixed");
  assert.deepEqual(source.shape, { t: 1, c: 1, z: 2, y: 2, x: 3 });
  assert.deepEqual(source.channels, [{ label: "DAPI", color: null }]);
  assert.deepEqual([source.scale.x, source.units.x], [0.5, "nanometer"]);
});

test("single-quoted OME-XML with entities is read through fiff", async () => {
  const source = await openSource([await file(here("../../components/test/fixtures/tiff/prefixed-ome-single-quoted.tif"))]);
  assert.equal(source.format, "OME-TIFF");
  assert.equal(source.name, "cells & nuclei");
  assert.deepEqual(source.shape, { t: 1, c: 1, z: 2, y: 2, x: 3 });
  assert.deepEqual(source.channels, [{ label: "DAPI", color: null }]);
  assert.deepEqual([source.scale.x, source.units.x], [0.5, "nanometer"]);
});

test("a plain multi-page TIFF is a Z stack calibrated from its centimetre resolution", async () => {
  const source = await openSource([await file(here("../../components/test/fixtures/tiff/stack-u16.tif"))]);
  assert.equal(source.format, "TIFF");
  assert.deepEqual(source.shape, { t: 1, c: 1, z: 3, y: 5, x: 7 });
  // 4 pixels per cm in x is 2500 µm; 2 per cm in y is 5000 µm.
  assert.deepEqual(source.scale, { t: null, z: null, y: 5000, x: 2500 });
  assert.deepEqual(source.units, { t: null, z: null, y: "micrometer", x: "micrometer" });
});

test("an ImageJ hyperstack maps channel-fastest pages to C and Z, with its spacing", async () => {
  const source = await openSource([await file(here("../../components/test/fixtures/tiff/imagej-hyperstack.tif"))]);
  assert.equal(source.format, "ImageJ TIFF");
  assert.deepEqual(source.shape, { t: 1, c: 2, z: 2, y: 4, x: 6 });
  assert.deepEqual(source.scale, { t: null, z: 2.5, y: 0.5, x: 0.5 });
  assert.deepEqual(source.units, { t: null, z: "micrometer", y: "micrometer", x: "micrometer" });
  // make_fixtures.py: page p holds (p * 37 + y * 7 + x * 3) % 251; page = z * channels + c.
  for (const { c, z, plane } of await planes(source)) {
    const page = z * 2 + c;
    assert.deepEqual(Array.from(plane), Array.from({ length: 24 }, (_, i) => (page * 37 + Math.floor(i / 6) * 7 + (i % 6) * 3) % 251));
  }
});

test("an RGBA TIFF becomes red, green and blue channels without alpha", async () => {
  const source = await openSource([await file(here("../../components/test/fixtures/tiff/rgba.tif"))]);
  assert.deepEqual(source.shape.c, 3);
  assert.deepEqual(source.channels.map(({ label, color }) => `${label} ${color}`), ["Red FF0000", "Green 00FF00", "Blue 0000FF"]);
  assert.match(source.notes.join(" "), /alpha/);
  const blue = await source.readPlane(0, 2, 0);
  assert.deepEqual(Array.from(blue), Array.from({ length: 12 }, (_, i) => (2 * 101 + Math.floor(i / 4) * 7 + (i % 4) * 3) % 251));
});

function nifti({ dims, datatype, bitpix, pixdim, units, values, littleEndian = true, slope = 1 }) {
  const header = new DataView(new ArrayBuffer(352));
  header.setInt32(0, 348, littleEndian);
  header.setInt16(40, dims.length, littleEndian);
  dims.forEach((size, i) => header.setInt16(42 + 2 * i, size, littleEndian));
  header.setInt16(70, datatype, littleEndian);
  header.setInt16(72, bitpix, littleEndian);
  [1, ...pixdim].forEach((value, i) => header.setFloat32(76 + 4 * i, value, littleEndian));
  header.setFloat32(108, 352, littleEndian);
  header.setFloat32(112, slope, littleEndian);
  header.setUint8(123, units);
  header.setUint8(344, 0x6e);
  header.setUint8(345, 0x2b);
  header.setUint8(346, 0x31);
  const data = new DataView(new ArrayBuffer(values.length * (bitpix / 8)));
  values.forEach((value, i) => data.setInt16(i * 2, value, littleEndian));
  return new File([header.buffer, data.buffer], "volume.nii");
}

test("a NIfTI image keeps its stored values, x fastest, with µm spacing and seconds", async () => {
  // 3 x 2 x 2 voxels, 2 frames, int16, xyzt_units 3 (µm) + 8 (s).
  const values = Array.from({ length: 24 }, (_, i) => i * 100 - 1000);
  for (const littleEndian of [true, false]) {
    const source = await openSource([nifti({ dims: [3, 2, 2, 2], datatype: 4, bitpix: 16, pixdim: [0.4, 0.5, 2, 1.5], units: 11, values, littleEndian, slope: 2 })]);
    assert.deepEqual(source.shape, { t: 2, c: 1, z: 2, y: 2, x: 3 });
    assert.deepEqual(source.scale, { t: 1.5, z: 2, y: 0.5, x: 0.4 });
    assert.deepEqual(source.units, { t: "second", z: "micrometer", y: "micrometer", x: "micrometer" });
    assert.match(source.notes.join(" "), /scl_slope 2/);
    assert.deepEqual(Array.from(await source.readPlane(1, 0, 1)), values.slice(18, 24));
    assert.ok((await source.readPlane(0, 0, 0)) instanceof Int16Array);
  }
});

test("an RGB NIfTI is refused", async () => {
  await assert.rejects(openSource([nifti({ dims: [2, 2, 1], datatype: 128, bitpix: 24, pixdim: [1, 1, 1], units: 2, values: [] })]), /datatype 128 is not supported/);
});

test("1, 2 and 4-bit PNG rows are unpacked", () => {
  // 5 pixels of 2 bits: 0b00_01_10_11, 0b01_000000 (padding).
  assert.deepEqual(Array.from(unpackBits(new Uint8Array([0b00011011, 0b01000000]), 5, 1, 2)), [0, 1, 2, 3, 1]);
  assert.deepEqual(Array.from(unpackBits(new Uint8Array([0b10100000, 0b01000000]), 3, 2, 1)), [1, 0, 1, 0, 1, 0]);
  assert.deepEqual(Array.from(unpackBits(new Uint8Array([0xab, 0xc0]), 3, 1, 4)), [0xa, 0xb, 0xc]);
});

const png = (name, image) => new File([encodePng(image)], name);

test("a 16-bit PNG sequence is a Z stack in natural name order, with its pHYs pixel size", async () => {
  const frame = (z) => png(`slice_${z}.png`, { width: 4, height: 3, depth: 16, channels: 1, data: Uint16Array.from({ length: 12 }, (_, i) => z * 1000 + i * 4000) });
  const source = await openSource([frame(10), frame(2), frame(1)]);
  assert.equal(source.format, "PNG sequence");
  assert.equal(source.name, "slice");
  assert.deepEqual(source.files, ["slice_1.png", "slice_2.png", "slice_10.png"]);
  assert.deepEqual(source.shape, { t: 1, c: 1, z: 3, y: 3, x: 4 });
  assert.equal(source.dtype, "uint16");
  assert.deepEqual(Array.from(await source.readPlane(0, 0, 2)), Array.from({ length: 12 }, (_, i) => 10000 + i * 4000));
  assert.equal(source.scale.x, null);
  // Pillow wrote pHYs 2,000,000 pixels per metre in x and 1,000,000 in y.
  const calibrated = await openSource([await file(here("./fixtures/phys-16bit.png"))]);
  assert.deepEqual([calibrated.scale.x, calibrated.scale.y, calibrated.units.x], [0.5, 1, "micrometer"]);
  assert.deepEqual(Array.from(await calibrated.readPlane(0, 0, 0)), Array.from({ length: 12 }, (_, i) => i * 4000));
});

test("PNG: grey RGB collapses to one channel, alpha is dropped, colour keeps three", async () => {
  const grey = png("a.png", { width: 2, height: 1, depth: 8, channels: 4, data: new Uint8Array([7, 7, 7, 255, 9, 9, 9, 0]) });
  const source = await openSource([grey]);
  assert.equal(source.shape.c, 1);
  assert.deepEqual(Array.from(await source.readPlane(0, 0, 0)), [7, 9]);
  assert.match(source.notes.join(" "), /alpha/);
  const colour = png("b.png", { width: 2, height: 1, depth: 8, channels: 3, data: new Uint8Array([1, 2, 3, 4, 5, 6]) });
  const rgb = await openSource([colour]);
  assert.equal(rgb.shape.c, 3);
  assert.deepEqual(Array.from(await rgb.readPlane(0, 1, 0)), [2, 5]);
});

test("palette PNGs and mismatched sequences are refused", async () => {
  const palette = png("p.png", { width: 2, height: 1, depth: 8, channels: 1, data: new Uint8Array([0, 1]), palette: [[0, 0, 0], [255, 255, 255]] });
  assert.throws(() => decodeRaster("p.png", encodePng({ width: 2, height: 1, depth: 8, channels: 1, data: new Uint8Array([0, 1]), palette: [[0, 0, 0], [255, 255, 255]] })), /palette PNG/);
  await assert.rejects(openSource([palette]), /palette PNG/);
  const small = png("z2.png", { width: 1, height: 1, depth: 8, channels: 1, data: new Uint8Array([1]) });
  const big = png("z1.png", { width: 2, height: 1, depth: 8, channels: 1, data: new Uint8Array([1, 2]) });
  const source = await openSource([small, big]);
  await assert.rejects(source.readPlane(0, 0, 1), /z2.png is 1 × 1 uint8; the sequence is 2 × 1 uint8/);
});

test("a JPEG sequence decodes greyscale JPEG to one channel and notes that JPEG is lossy", async () => {
  const data = new Uint8Array(8 * 8 * 4).fill(255);
  for (let i = 0; i < 64; i += 1) data.fill(i < 32 ? 40 : 200, i * 4, i * 4 + 3);
  const encoded = jpeg.encode({ width: 8, height: 8, data }, 100).data;
  const source = await openSource([new File([encoded], "frame1.jpg"), new File([encoded], "frame2.jpg")]);
  assert.equal(source.format, "JPEG sequence");
  assert.deepEqual(source.shape, { t: 1, c: 1, z: 2, y: 8, x: 8 });
  assert.match(source.notes.join(" "), /lossy/);
  const plane = await source.readPlane(0, 0, 1);
  assert.ok(Math.abs(plane[0] - 40) <= 2 && Math.abs(plane[63] - 200) <= 2);
});

test("files are routed by kind and mixed or unknown files are refused", async () => {
  assert.deepEqual(["a.ome.tif", "b.TIFF", "c.nii.gz", "d.png", "e.jpeg", "f.czi"].map(fileKind), ["tiff", "tiff", "nifti", "png", "jpeg", null]);
  await assert.rejects(openSource([new File(["x"], "cells.czi")]), /cells.czi is not a TIFF, PNG, JPEG or NIfTI file/);
  await assert.rejects(openSource([new File(["x"], "a.png"), new File(["x"], "b.nii")]), /files of one kind/);
  assert.deepEqual(["img10.png", "img9.png", "img1.png"].map((name) => ({ name })).sort(naturalOrder).map(({ name }) => name), ["img1.png", "img9.png", "img10.png"]);
});

test("a TIFF sequence is one single-page file per Z plane", async () => {
  const [one] = await Promise.all([file(here("../../components/test/fixtures/tiff/rgba.tif"))]);
  const source = await openSource([new File([one], "cells_02.tif"), new File([one], "cells_01.tif")]);
  assert.equal(source.format, "TIFF sequence");
  assert.equal(source.name, "cells");
  assert.deepEqual(source.shape, { t: 1, c: 3, z: 2, y: 3, x: 4 });
  const map = new Map();
  await writeOmeZarr(source, { set: (key, bytes) => map.set(key, bytes) }, { version: "0.4" });
  const { levels } = await readBackLevels(map);
  assert.deepEqual(levels[0].shape, [1, 3, 2, 3, 4]);
  await assert.rejects(openSource([await file(here("../../components/test/fixtures/tiff/stack-u16.tif")), await file(here("../../components/test/fixtures/tiff/stack-u16.tif"), "b.tif")]), /has 3 pages/);
});

test("user metadata replaces the file's, and invalid sizes are refused", async () => {
  const source = await openSource([await file(here("./fixtures/tczyx-named.ome.tif"))]);
  const edited = withMetadata(source, { scale: { x: 0.1, y: 0.1, z: 1 }, unit: "micrometer", labels: ["Nuclei", " ", "Actin"], name: "edited" });
  assert.deepEqual(edited.scale, { t: null, z: 1, y: 0.1, x: 0.1 });
  assert.deepEqual(edited.units, { t: null, z: "micrometer", y: "micrometer", x: "micrometer" });
  assert.deepEqual(edited.channels.map(({ label }) => label), ["Nuclei", "GFP", "Actin"]);
  assert.equal(edited.name, "edited");
  assert.equal(source.channels[0].label, "DAPI", "the source is not changed");
  assert.throws(() => withMetadata(source, { scale: { x: 0, y: 1, z: 1 }, unit: "micrometer" }), /X pixel size must be a positive number/);
  assert.throws(() => withMetadata(source, { scale: { x: 1, y: 1, z: 1 }, unit: "parsec-ish" }), /not a length unit/);
  assert.throws(() => withMetadata(source, { labels: ["one"] }), /Give 3 channel names/);
});

test("OME colours are signed RGBA integers", () => {
  assert.equal(rgbaColour(-16776961), "FF0000");
  assert.equal(rgbaColour(16711935), "00FF00");
  assert.equal(rgbaColour(65535), "0000FF");
  assert.equal(rgbaColour(-1), "FFFFFF");
  assert.equal(rgbaColour(undefined), null);
});
