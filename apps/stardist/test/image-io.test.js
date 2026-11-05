import { test } from "node:test";
import assert from "node:assert/strict";
import { encode as encodePng } from "fast-png";
import { fromArrayBuffer } from "geotiff";
import { MAX_DECODED_BYTES, nucleiCsv, readImage, writeLabelTiff } from "../src/image-io.js";

const toBuffer = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

/**
 * A little-endian TIFF with one IFD per page, every sample a strip of its own (planar
 * configuration 2). Each page is { width, height, bits, samples: [TypedArray], tags: { tag: values } }.
 */
function tiff(pages) {
  const chunks = [];
  let length = 8;
  const add = (bytes) => {
    const at = length;
    chunks.push(bytes);
    length += bytes.byteLength + (bytes.byteLength & 1);
    if (bytes.byteLength & 1) chunks.push(new Uint8Array(1));
    return at;
  };
  const shorts = (values) => new Uint8Array(Uint16Array.from(values).buffer);
  const longs = (values) => new Uint8Array(Uint32Array.from(values).buffer);
  const ifds = pages.map(({ width, height, bits, samples = [], tags = {} }) => {
    const offsets = samples.map((data) => add(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)));
    const entries = {
      256: [4, [width]],
      257: [4, [height]],
      258: [3, samples.length ? samples.map(() => bits) : [bits]],
      259: [3, [1]],
      262: [3, [1]],
      273: [4, offsets.length ? offsets : [0]],
      277: [3, [Math.max(1, samples.length)]],
      278: [4, [height]],
      279: [4, samples.length ? samples.map((data) => data.byteLength) : [(width * height * bits) / 8]],
      284: [3, [2]],
    };
    for (const [tag, values] of Object.entries(tags)) entries[tag] = [3, values];
    return Object.entries(entries).map(([tag, [type, values]]) => {
      const bytes = type === 3 ? shorts(values) : longs(values);
      return { tag: Number(tag), type, count: values.length, bytes, offset: bytes.byteLength > 4 ? add(bytes) : null };
    });
  });
  const ifdOffsets = ifds.map((entries) => add(new Uint8Array(2 + entries.length * 12 + 4)));
  const out = new Uint8Array(length);
  const view = new DataView(out.buffer);
  let at = 8;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  view.setUint16(0, 0x4949, true);
  view.setUint16(2, 42, true);
  view.setUint32(4, ifdOffsets[0], true);
  ifds.forEach((entries, page) => {
    const start = ifdOffsets[page];
    view.setUint16(start, entries.length, true);
    entries.sort((a, b) => a.tag - b.tag).forEach(({ tag, type, count, bytes, offset }, index) => {
      const entry = start + 2 + index * 12;
      view.setUint16(entry, tag, true);
      view.setUint16(entry + 2, type, true);
      view.setUint32(entry + 4, count, true);
      if (offset === null) out.set(bytes, entry + 8);
      else view.setUint32(entry + 8, offset, true);
    });
    view.setUint32(start + 2 + entries.length * 12, ifdOffsets[page + 1] ?? 0, true);
  });
  return toBuffer(out);
}

const ramp = (Type, length, offset) => Type.from({ length }, (_, i) => (i * 37 + offset) % 60000);

test("the label TIFF reads back with geotiff as the same labels", async () => {
  const width = 37;
  const height = 21;
  const labels = Int32Array.from({ length: width * height }, (_, i) => (i * 13) % 300);
  const tiff = writeLabelTiff(labels, width, height);
  const image = await (await fromArrayBuffer(toBuffer(tiff))).getImage();
  assert.equal(image.getWidth(), width);
  assert.equal(image.getHeight(), height);
  assert.equal(image.getBitsPerSample(), 16);
  const [values] = await image.readRasters();
  assert.deepEqual(Array.from(values), Array.from(labels));
});

test("more than 65535 nuclei are written as 32-bit labels", async () => {
  const labels = Int32Array.from({ length: 70000 }, (_, i) => i + 1);
  const image = await (await fromArrayBuffer(toBuffer(writeLabelTiff(labels, 350, 200)))).getImage();
  assert.equal(image.getBitsPerSample(), 32);
  assert.equal((await image.readRasters())[0][69999], 70000);
});

test("TIFF pages and samples become planes, and the label TIFF is itself readable", async () => {
  const labels = Int32Array.from({ length: 32 * 16 }, (_, i) => i % 7);
  const { width, height, format, planes } = await readImage("labels.tif", toBuffer(writeLabelTiff(labels, 32, 16)));
  assert.deepEqual([width, height, format], [32, 16, "TIFF"]);
  assert.equal(planes.length, 1);
  assert.equal(planes[0].label, "Intensity");
  assert.deepEqual(Array.from(planes[0].data), Array.from(labels));
});

test("a 16-bit greyscale PNG keeps its values and an RGBA PNG gives three channels", async () => {
  const grey = Uint16Array.from({ length: 20 * 18 }, (_, i) => i * 150);
  const one = await readImage("grey.png", toBuffer(encodePng({ width: 20, height: 18, data: grey, depth: 16, channels: 1 })));
  assert.equal(one.format, "PNG");
  assert.deepEqual(Array.from(one.planes[0].data), Array.from(grey));
  const rgba = Uint8Array.from({ length: 20 * 18 * 4 }, (_, i) => i % 251);
  const colour = await readImage("colour.png", toBuffer(encodePng({ width: 20, height: 18, data: rgba, depth: 8, channels: 4 })));
  assert.deepEqual(colour.planes.map((plane) => plane.label), ["red", "green", "blue"]);
  assert.equal(colour.planes[2].data[5], rgba[5 * 4 + 2]);
});

test("a four-channel 16-bit MinIsBlack TIFF keeps all four samples as channels", async () => {
  const samples = [0, 1, 2, 3].map((c) => ramp(Uint16Array, 20 * 18, 1000 * c));
  const { planes } = await readImage("four.tif", tiff([{ width: 20, height: 18, bits: 16, samples }]));
  assert.deepEqual(planes.map((plane) => plane.label), ["sample 1", "sample 2", "sample 3", "sample 4"]);
  planes.forEach((plane, c) => assert.deepEqual(Array.from(plane.data), Array.from(samples[c])));
});

test("TIFF alpha is left out only where ExtraSamples says alpha", async () => {
  const samples = [0, 1, 2, 3].map((c) => ramp(Uint8Array, 16 * 16, c));
  const rgba = await readImage("rgba.tif", tiff([{ width: 16, height: 16, bits: 8, samples, tags: { 262: [2], 338: [2] } }]));
  assert.deepEqual(rgba.planes.map((plane) => plane.label), ["red", "green", "blue"]);
  const rgbx = await readImage("rgbx.tif", tiff([{ width: 16, height: 16, bits: 8, samples, tags: { 262: [2], 338: [0] } }]));
  assert.deepEqual(rgbx.planes.map((plane) => plane.label), ["red", "green", "blue", "sample 4"]);
  assert.deepEqual(Array.from(rgbx.planes[3].data), Array.from(samples[3]));
  const greyAlpha = await readImage("ga.tif", tiff([{ width: 16, height: 16, bits: 8, samples: samples.slice(0, 2), tags: { 338: [1] } }]));
  assert.deepEqual(greyAlpha.planes.map((plane) => plane.label), ["Intensity"]);
});

test("a TIFF whose pages would decode past the budget is refused before decoding", async () => {
  // Header-only pages: the strips are never read, so the refusal must come first.
  const page = { width: 8192, height: 8192, bits: 32, samples: [], tags: { 277: [1] } };
  const pages = Array.from({ length: Math.floor(MAX_DECODED_BYTES / (8192 * 8192 * 4)) + 1 }, () => page);
  await assert.rejects(readImage("stack.tif", tiff(pages)), /GB of pixels in 5 pages; save the plane/);
});

test("float16 TIFF pages count at their decoded float32 size against the budget", async () => {
  // Stored as 2 bytes a sample, decoded to 4: five 8192² pages are 0.6 GiB on disk, 1.25 GiB decoded.
  const page = { width: 8192, height: 8192, bits: 16, samples: [], tags: { 277: [1], 339: [3] } };
  const pages = Array.from({ length: 5 }, () => page);
  await assert.rejects(readImage("half.tif", tiff(pages)), /GB of pixels in 5 pages; save the plane/);
});

test("PNGs below 8 bits are unpacked: 1, 2 and 4-bit grey and indexed colour", async () => {
  for (const depth of [1, 2, 4]) {
    const width = 19;
    const height = 17;
    const values = Uint8Array.from({ length: width * height }, (_, i) => (i * 7 + (i >> 3)) % (1 << depth));
    const rowBytes = Math.ceil((width * depth) / 8);
    const packed = new Uint8Array(rowBytes * height);
    values.forEach((value, i) => {
      const x = i % width;
      const bit = x * depth;
      packed[Math.floor(i / width) * rowBytes + (bit >> 3)] |= value << (8 - depth - (bit & 7));
    });
    const grey = await readImage("grey.png", toBuffer(encodePng({ width, height, data: packed, depth, channels: 1 })));
    assert.deepEqual(Array.from(grey.planes[0].data), Array.from(values), `${depth}-bit grey`);
    const palette = Array.from({ length: 1 << depth }, (_, k) => [10 + k, 100 + k, 200 - k]);
    const indexed = await readImage("indexed.png", toBuffer(encodePng({ width, height, data: packed, depth, channels: 1, palette })));
    assert.deepEqual(indexed.planes.map((plane) => plane.label), ["red", "green", "blue"]);
    assert.deepEqual(Array.from(indexed.planes[1].data), Array.from(values, (k) => 100 + k), `${depth}-bit indexed`);
  }
});

test("other files and tiny images are refused with the reason", async () => {
  await assert.rejects(readImage("scan.nii", new ArrayBuffer(400)), /not a TIFF, OME-TIFF or PNG/);
  const tiny = encodePng({ width: 8, height: 8, data: new Uint8Array(64), depth: 8, channels: 1 });
  await assert.rejects(readImage("tiny.png", toBuffer(tiny)), /at least 16 × 16/);
});

test("the table lists one row per nucleus", () => {
  const csv = nucleiCsv([{ id: 1, x: 10.25, y: 3.5, area: 42, mean: 120.123456789, probability: 0.98765 }]);
  assert.equal(csv, "id,centroid_x,centroid_y,area_px,mean_intensity,probability\n1,10.250,3.500,42,120.1235,0.9877\n");
});
