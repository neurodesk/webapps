// Reading inputs: OME-TIFF layout and calibration, the voxel limit checked from headers before
// any voxels are decoded, and non-finite samples refused at load.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rasterSize, readImages, tiffLayout, withoutExif, writeTiff } from "../src/io.js";
import { MAX_VOXELS } from "../src/config.js";
import { buildTiff, omeXml } from "./tiff-fixtures.mjs";

const pages = (count, width = 16, height = 16) => Array.from({ length: count }, (_, z) => new Uint8Array(width * height).fill(z + 1));
const tiffFile = (buffer, name = "image.ome.tif") => new File([buffer], name, { type: "image/tiff" });

// A file that counts the bytes read through `slice` and refuses to be read whole.
class HeaderOnlyFile extends File {
  bytesRead = 0;
  slice(start = 0, end = this.size, type) {
    this.bytesRead += Math.max(0, Math.min(end, this.size) - start);
    return super.slice(start, end, type);
  }
  arrayBuffer() {
    throw new Error("the whole file was read");
  }
}

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
  assert.ok(side * side > MAX_VOXELS);
  const file = new HeaderOnlyFile([buffer], "big.tif", { type: "image/tiff" });
  await assert.rejects(readImages([file]), /16,777,216 voxels; crop or bin/);
  // The header and its one IFD fit in the first kilobyte; the 16 KB strip is never read.
  assert.ok(file.bytesRead <= 2048 && file.bytesRead < buffer.byteLength / 4, `${file.bytesRead} of ${buffer.byteLength} bytes read`);
});

test("slices are counted together against the voxel limit before any is decoded", async () => {
  const side = 2048;
  const slice = buildTiff({ width: side, height: side, pages: [new Uint8Array(side * side)], deflate: true });
  const files = [0, 1, 2].map((k) => new HeaderOnlyFile([slice], `slice${k}.tif`, { type: "image/tiff" }));
  await assert.rejects(readImages(files), /12,582,912 voxels/);
  for (const file of files) assert.ok(file.bytesRead <= 2048 && file.bytesRead < slice.byteLength / 2, `${file.name}: ${file.bytesRead} of ${slice.byteLength} bytes read`);
});

test("NaN or infinite samples are refused when the image is loaded", async () => {
  const data = new Float32Array(16 * 16).fill(1);
  data[16 * 3 + 5] = Number.NaN;
  const nan = tiffFile(writeTiff({ data, dims: [16, 16, 1] }), "nan.tif");
  await assert.rejects(readImages([nan]), /nan\.tif: it has a NaN value at x 5, y 3\. Replace NaN/);
  data[16 * 3 + 5] = Number.POSITIVE_INFINITY;
  await assert.rejects(readImages([tiffFile(writeTiff({ data, dims: [16, 16, 1] }), "inf.tif")]), /infinite value at x 5, y 3/);
});

test("single-quoted OME-XML attributes keep the calibration, with entity-encoded units", async () => {
  const description = omeXml({ quote: "'", SizeX: 16, SizeY: 16, SizeZ: 3, SizeC: 1, SizeT: 1, PhysicalSizeX: 0.5, PhysicalSizeXUnit: "&#181;m", PhysicalSizeY: 0.5, PhysicalSizeYUnit: "&#xB5;m", PhysicalSizeZ: 2, PhysicalSizeZUnit: "&#181;m" });
  const { image } = await readImages([tiffFile(buildTiff({ width: 16, height: 16, pages: pages(3), description }))]);
  assert.deepEqual(image.dims, [16, 16, 3]);
  assert.deepEqual(image.spacing, [0.5, 0.5, 2]);
  assert.equal(image.unit, "\u00b5m");
});

test("a single-quoted OME-XML time series is refused", async () => {
  const description = omeXml({ quote: "'", SizeX: 16, SizeY: 16, SizeZ: 3, SizeC: 1, SizeT: 2 });
  await assert.rejects(readImages([tiffFile(buildTiff({ width: 16, height: 16, pages: pages(6), description }))]), /hyperstack with 2 time points/);
});

test("a multi-series OME-TIFF is refused as such, not counted as one image's channels", async () => {
  const description = omeXml({ images: 2, SizeX: 16, SizeY: 16, SizeZ: 1, SizeC: 1, SizeT: 1 });
  await assert.rejects(readImages([tiffFile(buildTiff({ width: 16, height: 16, pages: pages(2), description }))]), /holds 2 image series/);
});

/** A JPEG header: SOI, the given segments (marker, length of payload), a baseline SOF and EOI. */
function jpeg(width, height, segments = []) {
  const parts = [[0xff, 0xd8]];
  for (const [marker, payload] of segments) parts.push([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff], payload);
  parts.push([0xff, 0xc0, 0, 11, 8, height >> 8, height & 0xff, width >> 8, width & 0xff, 1, 1, 0x11, 0]);
  parts.push([0xff, 0xd9]);
  return new Blob(parts.map((part) => new Uint8Array(part)));
}

test("a JPEG's size is found past large APP segments", async () => {
  const icc = Array.from({ length: 3 }, () => [0xe2, new Uint8Array(50_000)]);
  assert.deepEqual(await rasterSize(jpeg(640, 480, icc)), [640, 480]);
  const twoApp2 = Array.from({ length: 2 }, () => [0xe2, new Uint8Array(40_000)]);
  assert.deepEqual(await rasterSize(jpeg(300, 200, twoApp2)), [300, 200]);
  assert.equal(await rasterSize(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])])), null);
});

// EXIF orientation 6: stored 4 × 2, shown rotated 90° clockwise as 2 × 4.
const EXIF_ROTATED = [0xe1, new Uint8Array([0x45, 0x78, 0x69, 0x66, 0, 0, 0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0])];
const stored = (x, y, z) => 10 * y + x + 100 * z;
const rotatedJpeg = (z) => new File([jpeg(4, 2, [EXIF_ROTATED, [0xfe, new Uint8Array([z])]])], `slice${z}.jpg`, { type: "image/jpeg" });

/**
 * Browser image decoding for Node. Like Chromium, the decoder applies a JPEG's EXIF orientation
 * whatever `imageOrientation` says (`rotates: "exif"`); `rotates: "always"` is a decoder that
 * rotates even without EXIF. The slice index z is the payload of the JPEG's comment segment.
 */
function mockDecoder({ rotates }) {
  globalThis.createImageBitmap = async (blob) => {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const rotate = rotates === "always" || Buffer.from(bytes).includes("Exif\0\0");
    const z = bytes[Buffer.from(bytes).indexOf(Buffer.from([0xff, 0xfe])) + 4];
    const [width, height] = rotate ? [2, 4] : [4, 2];
    // Displayed pixel (x, y) of orientation 6 is stored pixel (y, height - 1 - x).
    const value = (x, y) => (rotate ? stored(y, 1 - x, z) : stored(x, y, z));
    // A closed ImageBitmap reports 0 × 0, as in the browser.
    return {
      width,
      height,
      value,
      close() {
        this.width = 0;
        this.height = 0;
      },
    };
  };
  globalThis.OffscreenCanvas = class {
    constructor(width, height) {
      Object.assign(this, { width, height });
    }
    getContext() {
      let bitmap;
      return {
        drawImage: (image) => (bitmap = image),
        getImageData: (_x, _y, width, height) => {
          const data = new Uint8ClampedArray(4 * width * height);
          for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.fill(bitmap.value(x, y), 4 * (y * width + x), 4 * (y * width + x) + 3);
          return { data };
        },
      };
    }
  };
}

function removeDecoder() {
  delete globalThis.createImageBitmap;
  delete globalThis.OffscreenCanvas;
}

test("EXIF-rotated JPEG slices stack on their stored grid, as ImageJ reads them", async (t) => {
  t.after(removeDecoder);
  mockDecoder({ rotates: "exif" });
  const files = [0, 1].map((z) => rotatedJpeg(z));
  const { image } = await readImages(files);
  assert.deepEqual(image.dims, [4, 2, 2]);
  const expected = [];
  for (let z = 0; z < 2; z++) for (let y = 0; y < 2; y++) for (let x = 0; x < 4; x++) expected.push(stored(x, y, z));
  assert.deepEqual([...image.data], expected);
});

test("a JPEG the browser decodes rotated from its header size is refused", async (t) => {
  t.after(removeDecoder);
  mockDecoder({ rotates: "always" });
  const files = [0, 1].map((z) => rotatedJpeg(z));
  await assert.rejects(readImages(files), /slice0\.jpg could not be read: it decodes to 2 × 4, not the 4 × 2 its header gives/);
});

test("EXIF after the start of frame is stripped too, so the slice stays on its stored grid", async (t) => {
  t.after(removeDecoder);
  mockDecoder({ rotates: "exif" });
  const [marker, payload] = EXIF_ROTATED;
  const sof = [0xff, 0xc0, 0, 11, 8, 0, 2, 0, 4, 1, 1, 0x11, 0];
  const segment = (m, p) => [0xff, m, (p.length + 2) >> 8, (p.length + 2) & 0xff, ...p];
  const bytes = new Uint8Array([0xff, 0xd8, ...sof, ...segment(marker, payload), ...segment(0xfe, [0]), 0xff, 0xd9]);
  const { image } = await readImages([new File([bytes], "late.jpg", { type: "image/jpeg" })]);
  assert.deepEqual(image.dims, [4, 2, 1]);
  assert.deepEqual([...image.data], [0, 1, 2, 3, 10, 11, 12, 13]);
});

test("a PNG loses its eXIf chunk before decoding and keeps every other chunk", async () => {
  const chunk = (type, data) => {
    const out = new Uint8Array(12 + data.length);
    new DataView(out.buffer).setUint32(0, data.length);
    out.set(Buffer.from(type, "latin1"), 4);
    out.set(data, 8);
    return out;
  };
  const png = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", new Uint8Array(13)), chunk("eXIf", new Uint8Array([0x4d, 0x4d, 0, 0x2a])), chunk("IDAT", new Uint8Array([1, 2, 3])), chunk("IEND", new Uint8Array())]);
  const bytes = Buffer.from(await (await withoutExif(png)).arrayBuffer());
  assert.equal(bytes.includes("eXIf"), false);
  for (const type of ["IHDR", "IDAT", "IEND"]) assert.equal(bytes.includes(type), true, type);
  assert.equal(bytes.length, png.size - 16);
});

test("a TIFF stack decodes from one read of the file, not one slice per strip", async () => {
  const buffer = buildTiff({ width: 16, height: 16, pages: pages(64) });
  class CountingFile extends File {
    slices = 0;
    reads = 0;
    slice(...args) {
      this.slices += 1;
      return super.slice(...args);
    }
    arrayBuffer() {
      this.reads += 1;
      return super.arrayBuffer();
    }
  }
  const probeOnly = new CountingFile([buffer], "probe.tif", { type: "image/tiff" });
  await tiffLayout(probeOnly);
  const file = new CountingFile([buffer], "stack.tif", { type: "image/tiff" });
  const { image } = await readImages([file]);
  assert.deepEqual(image.dims, [16, 16, 64]);
  assert.equal(file.reads, 1);
  assert.ok(file.slices <= probeOnly.slices + 2, `${file.slices} slices against ${probeOnly.slices} for the headers alone`);
});
