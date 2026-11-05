// Reading inputs: OME-TIFF layout and calibration, the voxel limit checked from headers before
// any voxels are decoded, and non-finite samples refused at load.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readImages } from "../src/io.js";
import { tiffLayout, writeTiff } from "../src/tiff.js";
import { MAX_VOXELS } from "../src/config.js";
import { buildTiff, omeXml } from "./tiff-fixtures.mjs";

const pages = (count, width = 16, height = 16) => Array.from({ length: count }, (_, z) => new Uint8Array(width * height).fill(z + 1));
const tiffFile = (buffer, name = "image.ome.tif") => new File([buffer], name, { type: "image/tiff" });

test("an OME-TIFF with two channels and three slices is refused, not read as six slices", async () => {
  const buffer = buildTiff({ width: 16, height: 16, pages: pages(6), description: omeXml({ prefix: "ome", channels: 2, SizeX: 16, SizeY: 16, SizeZ: 3, SizeC: 2, SizeT: 1 }) });
  await assert.rejects(readImages([tiffFile(buffer)]), /2 channels.*Duplicate with one channel/);
});

test("an OME-TIFF with several time points is refused", async () => {
  const buffer = buildTiff({ width: 16, height: 16, pages: pages(4), description: omeXml({ SizeX: 16, SizeY: 16, SizeZ: 2, SizeC: 1, SizeT: 2 }) });
  await assert.rejects(readImages([tiffFile(buffer)]), /2 time points/);
});

test("a calibrated single-channel OME stack keeps its micrometre voxel size", async () => {
  const description = omeXml({ prefix: "ome", SizeX: 16, SizeY: 16, SizeZ: 3, SizeC: 1, SizeT: 1, PhysicalSizeX: 0.2, PhysicalSizeXUnit: "µm", PhysicalSizeY: 0.2, PhysicalSizeYUnit: "µm", PhysicalSizeZ: 2000, PhysicalSizeZUnit: "nm" });
  const { image } = await readImages([tiffFile(buildTiff({ width: 16, height: 16, pages: pages(3), description }))]);
  assert.deepEqual(image.dims, [16, 16, 3]);
  assert.deepEqual(image.spacing.map((s) => Number(s.toPrecision(12))), [0.2, 0.2, 2]);
  assert.equal(image.unit, "µm");
  assert.equal(image.data[16 * 16 * 2], 3);
});

test("an OME-TIFF whose planes are in other files is refused", async () => {
  const buffer = buildTiff({ width: 16, height: 16, pages: pages(1), description: omeXml({ SizeX: 16, SizeY: 16, SizeZ: 4, SizeC: 1, SizeT: 1 }) });
  await assert.rejects(tiffLayout(buffer), /declares 4 planes but holds 1/);
});

test("a small compressed TIFF over the voxel limit is refused from its header, before decoding", async () => {
  const side = 4096;
  const buffer = buildTiff({ width: side, height: side, pages: [new Uint8Array(side * side)], deflate: true });
  assert.ok(buffer.byteLength < 100_000, `${buffer.byteLength} bytes`);
  assert.ok(side * side > MAX_VOXELS);
  await assert.rejects(readImages([tiffFile(buffer, "big.tif")]), /16,777,216 voxels; crop or bin/);
});

test("slices are counted together against the voxel limit before any is decoded", async () => {
  const side = 2048;
  const slice = buildTiff({ width: side, height: side, pages: [new Uint8Array(side * side)], deflate: true });
  const files = [0, 1, 2].map((k) => tiffFile(slice, `slice${k}.tif`));
  await assert.rejects(readImages(files), /12,582,912 voxels/);
});

test("NaN or infinite samples are refused when the image is loaded", async () => {
  const data = new Float32Array(16 * 16).fill(1);
  data[16 * 3 + 5] = Number.NaN;
  const nan = tiffFile(writeTiff({ data, dims: [16, 16, 1] }), "nan.tif");
  await assert.rejects(readImages([nan]), /nan\.tif: it has a NaN value at x 5, y 3\. Replace NaN/);
  data[16 * 3 + 5] = Number.POSITIVE_INFINITY;
  await assert.rejects(readImages([tiffFile(writeTiff({ data, dims: [16, 16, 1] }), "inf.tif")]), /infinite value at x 5, y 3/);
});
