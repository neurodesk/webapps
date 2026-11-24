import assert from "node:assert/strict";
import test from "node:test";
import { encode as encodePng } from "fast-png";
import { writeLabelTiff } from "@neurodesk/webapp-components/file-io/tiff";
import { cellsCsv, cellsCsv3D, readImage, writeLabelsTiff } from "../src/image-io.js";

test("readImage decodes 2D PNG grayscale and RGB images", async () => {
  const gray = new Uint8Array(16 * 16);
  for (let i = 0; i < gray.length; i++) gray[i] = i;
  const pngBytes = encodePng({ width: 16, height: 16, data: gray, channels: 1, depth: 8 });
  const img = await readImage("sample.png", pngBytes.buffer.slice(pngBytes.byteOffset, pngBytes.byteOffset + pngBytes.byteLength));
  assert.equal(img.format, "PNG");
  assert.equal(img.width, 16);
  assert.equal(img.height, 16);
  assert.equal(img.depth, 1);
  assert.equal(img.planes.length, 1);
  assert.equal(img.planes[0].data[42], 42);

  const rgb = new Uint8Array(16 * 16 * 3);
  for (let i = 0; i < 16 * 16; i++) {
    rgb[3 * i] = 10 + (i % 50);
    rgb[3 * i + 1] = 80 + (i % 50);
    rgb[3 * i + 2] = 150 + (i % 50);
  }
  const rgbBytes = encodePng({ width: 16, height: 16, data: rgb, channels: 3, depth: 8 });
  const rgbImg = await readImage("color.png", rgbBytes.buffer.slice(rgbBytes.byteOffset, rgbBytes.byteOffset + rgbBytes.byteLength));
  assert.equal(rgbImg.isRgb, true);
  assert.equal(rgbImg.planes.length, 3);
  assert.equal(rgbImg.planes[0].data[5], 15);
  assert.equal(rgbImg.planes[1].data[5], 85);
  assert.equal(rgbImg.planes[2].data[5], 155);
});

test("writeLabelsTiff round-trips 2D and 3D label stacks through readImage", async () => {
  const labels2d = new Int32Array(16 * 16);
  for (let i = 0; i < labels2d.length; i++) labels2d[i] = i % 5;
  const tif2d = writeLabelsTiff(labels2d, 16, 16, 1);
  const back2d = await readImage("out.tif", tif2d.buffer.slice(tif2d.byteOffset, tif2d.byteOffset + tif2d.byteLength));
  assert.equal(back2d.width, 16);
  assert.equal(back2d.height, 16);
  assert.equal(back2d.depth, 1);
  assert.deepEqual(Array.from(back2d.planes[0].data), Array.from(labels2d));

  // 3D stack: 4 slices x 16x16
  const labels3d = new Int32Array(4 * 16 * 16);
  for (let i = 0; i < labels3d.length; i++) labels3d[i] = i % 7;
  const tif3d = writeLabelsTiff(labels3d, 16, 16, 4);
  const back3d = await readImage("out3d.tif", tif3d.buffer.slice(tif3d.byteOffset, tif3d.byteOffset + tif3d.byteLength));
  assert.equal(back3d.width, 16);
  assert.equal(back3d.height, 16);
  assert.equal(back3d.depth, 4);
  assert.equal(back3d.is3dHint, true);
  assert.equal(back3d.stack.depth, 4);
  assert.deepEqual(Array.from(back3d.stack.channels[0].data), Array.from(labels3d));
});

test("readImage rejects non-image files and images smaller than 16x16", async () => {
  const garbage = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  await assert.rejects(() => readImage("scan.nii", garbage.buffer), /is not a TIFF, OME-TIFF or PNG image/);

  const tiny = encodePng({ width: 4, height: 3, data: new Uint8Array(12), channels: 1, depth: 8 });
  await assert.rejects(() => readImage("tiny.png", tiny.buffer.slice(tiny.byteOffset, tiny.byteOffset + tiny.byteLength)), /at least 16 × 16/);
});

test("cellsCsv and cellsCsv3D format expected headers and precision", () => {
  const csv2 = cellsCsv([{ id: 1, x: 12.3456, y: 7.8, area: 150, mean: 1024.5 }]);
  assert.equal(csv2, "id,centroid_x,centroid_y,area_px,mean_intensity\n1,12.346,7.800,150,1024.500\n");

  const csv3 = cellsCsv3D([{ id: 2, x: 3.1, y: 4.2, z: 5.3, volume: 420, mean: 88.25 }]);
  assert.equal(csv3, "id,centroid_x,centroid_y,centroid_z,volume_vox,mean_intensity\n2,3.100,4.200,5.300,420,88.25000\n");
});

test("readImage handles 16-bit TIFF written by writeLabelTiff", async () => {
  const data = new Int32Array(16 * 16);
  for (let i = 0; i < data.length; i++) data[i] = 100 + i;
  const tif = writeLabelTiff(data, 16, 16);
  const img = await readImage("synthetic.tif", tif.buffer.slice(tif.byteOffset, tif.byteOffset + tif.byteLength));
  assert.equal(img.format, "TIFF");
  assert.deepEqual(Array.from(img.planes[0].data), Array.from(data));
});
