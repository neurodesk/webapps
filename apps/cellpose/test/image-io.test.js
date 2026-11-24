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

function buildRawTiff(pages) {
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
  const ascii = (text) => new TextEncoder().encode(`${text}\0`);
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
    for (const [tag, values] of Object.entries(tags)) entries[tag] = [typeof values === "string" ? 2 : 3, values];
    return Object.entries(entries).map(([tag, [type, values]]) => {
      const bytes = type === 2 ? ascii(values) : type === 3 ? shorts(values) : longs(values);
      return { tag: Number(tag), type, count: type === 2 ? bytes.byteLength : values.length, bytes, offset: bytes.byteLength > 4 ? add(bytes) : null };
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
  return out.buffer;
}

test("3D OME-TIFF honors explicit TiffData plane mapping and rejects time series", async () => {
  const mkPlane = (v) => new Uint16Array(16 * 16).fill(v);
  const omeXml = '<OME xmlns="http://www.openmicroscopy.org/Schemas/OME/2016-06"><Image ID="Image:0"><Pixels DimensionOrder="XYZCT" SizeX="16" SizeY="16" SizeZ="2" SizeC="2" SizeT="1" PhysicalSizeX="0.5" PhysicalSizeY="0.5" PhysicalSizeZ="2.0"><Channel Name="Membrane"/><Channel Name="Nuclei"/><TiffData IFD="0" FirstZ="1" FirstC="0" FirstT="0" PlaneCount="1"/><TiffData IFD="1" FirstZ="0" FirstC="0" FirstT="0" PlaneCount="1"/><TiffData IFD="2" FirstZ="1" FirstC="1" FirstT="0" PlaneCount="1"/><TiffData IFD="3" FirstZ="0" FirstC="1" FirstT="0" PlaneCount="1"/></Pixels></Image></OME>';
  const buf = buildRawTiff([
    { width: 16, height: 16, bits: 16, samples: [mkPlane(100)], tags: { 270: omeXml } },
    { width: 16, height: 16, bits: 16, samples: [mkPlane(200)] },
    { width: 16, height: 16, bits: 16, samples: [mkPlane(300)] },
    { width: 16, height: 16, bits: 16, samples: [mkPlane(400)] },
  ]);
  const img = await readImage("mapped3d.ome.tif", buf);
  assert.equal(img.is3dHint, true);
  assert.equal(img.stack.depth, 2);
  assert.deepEqual(img.stack.channels.map((c) => c.label), ["Membrane", "Nuclei"]);
  assert.equal(img.stack.channels[0].data[0], 200);
  assert.equal(img.stack.channels[0].data[256], 100);
  assert.equal(img.stack.channels[1].data[0], 400);
  assert.equal(img.stack.channels[1].data[256], 300);
  assert.deepEqual(img.spacing, { x: 0.5, y: 0.5, z: 2.0, unit: "micron" });

  // Time series must be refused rather than silently treated as Z slices.
  const timeXml = '<OME xmlns="http://www.openmicroscopy.org/Schemas/OME/2016-06"><Image ID="Image:0"><Pixels DimensionOrder="XYZCT" SizeX="16" SizeY="16" SizeZ="1" SizeC="1" SizeT="4"><TiffData/></Pixels></Image></OME>';
  const timeBuf = buildRawTiff(Array.from({ length: 4 }, (_, i) => ({ width: 16, height: 16, bits: 16, samples: [mkPlane(i + 1)], tags: i ? {} : { 270: timeXml } })));
  await assert.rejects(readImage("movie.ome.tif", timeBuf), /time series/);
});

test("ImageJ channel-only 2D stack stays 2D while CZT 3D stack separates channels and mixed types fail", async () => {
  const mkPlane = (v) => new Uint16Array(16 * 16).fill(v);
  const ij2d = buildRawTiff([
    { width: 16, height: 16, bits: 16, samples: [mkPlane(11)], tags: { 270: "ImageJ=1.11a\nimages=2\nchannels=2\nslices=1\nhyperstack=true\n" } },
    { width: 16, height: 16, bits: 16, samples: [mkPlane(22)] },
  ]);
  const res2d = await readImage("ij2d.tif", ij2d);
  assert.equal(res2d.stack, null);
  assert.equal(res2d.is3dHint, false);
  assert.equal(res2d.planes.length, 2);

  const ij3d = buildRawTiff([10, 20, 30, 40].map((v, i) => ({
    width: 16,
    height: 16,
    bits: 16,
    samples: [mkPlane(v)],
    tags: i ? {} : { 270: "ImageJ=1.11a\nimages=4\nchannels=2\nslices=2\nhyperstack=true\nspacing=1.5\nunit=micron\n" },
  })));
  const res3d = await readImage("ij3d.tif", ij3d);
  assert.equal(res3d.is3dHint, true);
  assert.deepEqual([res3d.stack.channels[0].data[0], res3d.stack.channels[0].data[256]], [10, 30]);
  assert.deepEqual([res3d.stack.channels[1].data[0], res3d.stack.channels[1].data[256]], [20, 40]);

  const mixed = buildRawTiff([
    { width: 16, height: 16, bits: 8, samples: [new Uint8Array(256).fill(10)] },
    { width: 16, height: 16, bits: 16, samples: [new Uint16Array(256).fill(500)] },
  ]);
  await assert.rejects(readImage("mixed.tif", mixed), /different sample type/);
});

test("oversized PNG header is rejected before decompression and writeLabelsTiff preserves spacing", async () => {
  const header = new Uint8Array(33);
  header.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(header.buffer);
  view.setUint32(8, 13, false);
  header.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, 9000, false);
  view.setUint32(20, 9000, false);
  header[24] = 8;
  header[25] = 6;
  await assert.rejects(readImage("huge.png", header.buffer), /9000 × 9000/);

  const labels = new Int32Array(2 * 16 * 16);
  labels[5] = 1;
  const tif = writeLabelsTiff(labels, 16, 16, 2, { x: 0.5, y: 0.5, z: 2.0, unit: "micron" });
  const back = await readImage("spaced.tif", tif.buffer.slice(tif.byteOffset, tif.byteOffset + tif.byteLength));
  assert.ok(Math.abs(back.spacing.z - 2.0) < 1e-4);
  assert.ok(Math.abs(back.spacing.x - 0.5) < 1e-4);
});
