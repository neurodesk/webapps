import { test } from "node:test";
import assert from "node:assert/strict";
import { encode as encodePng } from "fast-png";
import { fromArrayBuffer } from "geotiff";
import { nucleiCsv, readImage, writeLabelTiff } from "../src/image-io.js";

const toBuffer = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

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

test("other files and tiny images are refused with the reason", async () => {
  await assert.rejects(readImage("scan.nii", new ArrayBuffer(400)), /not a TIFF, OME-TIFF or PNG/);
  const tiny = encodePng({ width: 8, height: 8, data: new Uint8Array(64), depth: 8, channels: 1 });
  await assert.rejects(readImage("tiny.png", toBuffer(tiny)), /at least 16 × 16/);
});

test("the table lists one row per nucleus", () => {
  const csv = nucleiCsv([{ id: 1, x: 10.25, y: 3.5, area: 42, mean: 120.123456789, probability: 0.98765 }]);
  assert.equal(csv, "id,centroid_x,centroid_y,area_px,mean_intensity,probability\n1,10.250,3.500,42,120.1235,0.9877\n");
});
