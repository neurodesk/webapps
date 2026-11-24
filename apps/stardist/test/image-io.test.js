import { test } from "node:test";
import assert from "node:assert/strict";
import { encode as encodePng } from "fast-png";
import { writeLabelTiff } from "@neurodesk/webapp-components/file-io/tiff";
import { MAX_DECODED_BYTES, interleaveRgb, nucleiCsv, nucleiCsv3D, readImage, writeLabelsTiff } from "../src/image-io.js";

const toBuffer = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

/**
 * A little-endian TIFF with one IFD per page, every sample a strip of its own (planar
 * configuration 2). Each page is { width, height, bits, samples: [TypedArray], tags: { tag: values } },
 * a tag's values SHORTs, or ASCII when they are a string.
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
  return toBuffer(out);
}

const ramp = (Type, length, offset) => Type.from({ length }, (_, i) => (i * 37 + offset) % 60000);

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

test("a palette TIFF is its colour indices, as tifffile reads it, not its colours", async () => {
  // Fiji saves an 8-bit channel with the Blue LUT as a palette TIFF: red and green are zero.
  const blue = Array.from({ length: 3 * 256 }, (_, i) => (i >= 512 ? (i - 512) * 257 : 0));
  const indices = ramp(Uint8Array, 20 * 18, 3).map((value) => value % 256);
  const { planes } = await readImage("dapi.tif", tiff([{ width: 20, height: 18, bits: 8, samples: [indices], tags: { 262: [3], 320: blue } }]));
  assert.deepEqual(planes.map((plane) => plane.label), ["Intensity"]);
  assert.deepEqual(Array.from(planes[0].data), Array.from(indices));
});

test("OME-TIFF pages take channel names through TiffData, and unfollowable TiffData is refused", async () => {
  const pages = (tiffData) => {
    const description = `<OME UUID="urn:uuid:a"><Image ID="Image:0"><Pixels SizeC="2" SizeZ="1" SizeT="1"><Channel Name="DAPI"/><Channel Name="GFP"/>${tiffData}</Pixels></Image></OME>`;
    return tiff([0, 1].map((c) => ({ width: 16, height: 16, bits: 16, samples: [ramp(Uint16Array, 256, c)], tags: c ? {} : { 270: description } })));
  };
  const plain = await readImage("plain.ome.tif", pages(""));
  assert.deepEqual([plain.format, plain.planes.map((plane) => plane.label)], ["OME-TIFF", ["DAPI", "GFP"]]);
  const mapped = await readImage("mapped.ome.tif", pages('<TiffData IFD="0" FirstC="1"/><TiffData IFD="1" FirstC="0"/>'));
  assert.deepEqual(mapped.planes.map((plane) => plane.label), ["GFP", "DAPI"]);
  assert.deepEqual(Array.from(mapped.planes[0].data), Array.from(ramp(Uint16Array, 256, 0)));
  await assert.rejects(readImage("split.ome.tif", pages('<TiffData PlaneCount="2"><UUID>urn:uuid:b</UUID></TiffData>')), /split\.ome\.tif maps its channels to TIFF pages in a way the app cannot read \(planes in another file\)/);
});

test("an oversized TIFF is refused for its size before its sample type", async () => {
  // Header-only and 64-bit unsigned, a sample type geotiff cannot decode.
  const page = { width: 8193, height: 8193, bits: 64, samples: [], tags: { 277: [1] } };
  await assert.rejects(readImage("big.tif", tiff([page])), /big\.tif is 8193 × 8193; split images over 64 megapixels into tiles first/);
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
  const csv3d = nucleiCsv3D([{ id: 1, x: 10.25, y: 3.5, z: 2.125, volume: 120, mean: 450.5, probability: 0.91234 }]);
  assert.equal(csv3d, "id,centroid_x,centroid_y,centroid_z,volume_vox,mean_intensity,probability\n1,10.250,3.500,2.125,120,450.5000,0.9123\n");
});

test("multi-page 3D label stacks roundtrip through writeLabelsTiff and readImage", async () => {
  const width = 20;
  const height = 18;
  const depth = 6;
  const labels = Int32Array.from({ length: depth * height * width }, (_, i) => i % 11);
  const bytes = writeLabelsTiff(labels, width, height, depth);
  const loaded = await readImage("labels3d.tif", toBuffer(bytes));
  assert.equal(loaded.depth, depth);
  assert.equal(loaded.is3dHint, true);
  assert.ok(loaded.stack);
  assert.equal(loaded.stack.depth, depth);
  assert.equal(loaded.stack.channels.length, 1);
  assert.deepEqual(Array.from(loaded.stack.channels[0].data), Array.from(labels));
});

test("interleaveRgb packs three RGB planes into interleaved HWC floats", () => {
  const rgb = interleaveRgb([
    { data: Uint8Array.from([10, 20]) },
    { data: Uint8Array.from([30, 40]) },
    { data: Uint8Array.from([50, 60]) },
  ]);
  assert.deepEqual(Array.from(rgb), [10, 30, 50, 20, 40, 60]);
});

test("3D OME-TIFF honors explicit TiffData plane mapping and rejects time series", async () => {
  const mkPlane = (v) => new Uint16Array(16 * 16).fill(v);
  // IFD 0=(Z1,C0)=100, IFD 1=(Z0,C0)=200, IFD 2=(Z1,C1)=300, IFD 3=(Z0,C1)=400 (reversed Z!)
  const omeXml = '<OME xmlns="http://www.openmicroscopy.org/Schemas/OME/2016-06"><Image ID="Image:0"><Pixels DimensionOrder="XYZCT" SizeX="16" SizeY="16" SizeZ="2" SizeC="2" SizeT="1" PhysicalSizeX="0.5" PhysicalSizeY="0.5" PhysicalSizeZ="1.5"><Channel Name="DAPI"/><Channel Name="GFP"/><TiffData IFD="0" FirstZ="1" FirstC="0" FirstT="0" PlaneCount="1"/><TiffData IFD="1" FirstZ="0" FirstC="0" FirstT="0" PlaneCount="1"/><TiffData IFD="2" FirstZ="1" FirstC="1" FirstT="0" PlaneCount="1"/><TiffData IFD="3" FirstZ="0" FirstC="1" FirstT="0" PlaneCount="1"/></Pixels></Image></OME>';
  const buf = tiff([
    { width: 16, height: 16, bits: 16, samples: [mkPlane(100)], tags: { 270: omeXml } },
    { width: 16, height: 16, bits: 16, samples: [mkPlane(200)] },
    { width: 16, height: 16, bits: 16, samples: [mkPlane(300)] },
    { width: 16, height: 16, bits: 16, samples: [mkPlane(400)] },
  ]);
  const img = await readImage("mapped3d.ome.tif", buf);
  assert.equal(img.is3dHint, true);
  assert.equal(img.stack.depth, 2);
  assert.deepEqual(img.stack.channels.map((c) => c.label), ["DAPI", "GFP"]);
  assert.equal(img.stack.channels[0].data[0], 200);
  assert.equal(img.stack.channels[0].data[256], 100);
  assert.equal(img.stack.channels[1].data[0], 400);
  assert.equal(img.stack.channels[1].data[256], 300);
  assert.deepEqual(img.spacing, { x: 0.5, y: 0.5, z: 1.5, unit: "micron" });

  // Time series (SizeT=5) must be refused instead of treated as Z slices.
  const timeXml = '<OME xmlns="http://www.openmicroscopy.org/Schemas/OME/2016-06"><Image ID="Image:0"><Pixels DimensionOrder="XYZCT" SizeX="16" SizeY="16" SizeZ="1" SizeC="1" SizeT="5"><TiffData/></Pixels></Image></OME>';
  const timeBuf = tiff(Array.from({ length: 5 }, (_, i) => ({ width: 16, height: 16, bits: 16, samples: [mkPlane(i + 1)], tags: i ? {} : { 270: timeXml } })));
  await assert.rejects(readImage("movie.ome.tif", timeBuf), /time series/);
});

test("ImageJ 3D hyperstack separates channels in CZT order and mixed-type stacks are refused", async () => {
  const mkPlane = (v) => new Uint16Array(16 * 16).fill(v);
  const ijDesc = "ImageJ=1.11a\nimages=6\nchannels=2\nslices=3\nhyperstack=true\nspacing=2.5\nunit=micron\n";
  const ijBuf = tiff([10, 20, 30, 40, 50, 60].map((v, i) => ({
    width: 16,
    height: 16,
    bits: 16,
    samples: [mkPlane(v)],
    tags: i ? {} : { 270: ijDesc },
  })));
  const img = await readImage("ij.tif", ijBuf);
  assert.equal(img.is3dHint, true);
  assert.equal(img.stack.depth, 3);
  assert.equal(img.stack.channels.length, 2);
  assert.deepEqual([img.stack.channels[0].data[0], img.stack.channels[0].data[256], img.stack.channels[0].data[512]], [10, 30, 50]);
  assert.deepEqual([img.stack.channels[1].data[0], img.stack.channels[1].data[256], img.stack.channels[1].data[512]], [20, 40, 60]);
  assert.equal(img.spacing?.z, 2.5);

  // Mixed uint8 + uint16 stack must be refused instead of silently truncating uint16 to uint8.
  const mixed = tiff([
    { width: 16, height: 16, bits: 8, samples: [new Uint8Array(256).fill(10)] },
    { width: 16, height: 16, bits: 16, samples: [new Uint16Array(256).fill(500)] },
  ]);
  await assert.rejects(readImage("mixed.tif", mixed), /different sample type/);
});

test("oversized PNG header is rejected during IHDR preflight before decompression", async () => {
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
});

test("writeLabelsTiff preserves physical spacing in 3D output", async () => {
  const labels = new Int32Array(2 * 16 * 16);
  labels[10] = 1;
  const tif = writeLabelsTiff(labels, 16, 16, 2, { x: 0.25, y: 0.25, z: 1.25, unit: "micron" });
  const back = await readImage("spaced.tif", toBuffer(tif));
  assert.equal(back.depth, 2);
  assert.ok(Math.abs(back.spacing.z - 1.25) < 1e-4);
  assert.ok(Math.abs(back.spacing.x - 0.25) < 1e-4);
});

test("OME-XML on a reduced-resolution IFD 0 and BinaryOnly OME-TIFFs are rejected", async () => {
  const mkPlane = (v) => new Uint16Array(16 * 16).fill(v);
  const timeXml = '<OME xmlns="http://www.openmicroscopy.org/Schemas/OME/2016-06"><Image ID="Image:0"><Pixels DimensionOrder="XYZCT" SizeX="16" SizeY="16" SizeZ="1" SizeC="1" SizeT="5"><TiffData/></Pixels></Image></OME>';
  const reducedFirst = tiff([
    { width: 16, height: 16, bits: 16, samples: [mkPlane(1)], tags: { 254: [1], 270: timeXml } },
    ...Array.from({ length: 5 }, (_, i) => ({ width: 16, height: 16, bits: 16, samples: [mkPlane(i + 2)] })),
  ]);
  await assert.rejects(readImage("thumb-movie.ome.tif", reducedFirst), /time series/);

  const binaryOnlyXml = '<OME xmlns="http://www.openmicroscopy.org/Schemas/OME/2016-06"><BinaryOnly MetadataFile="companion.ome" UUID="urn:uuid:1234"/></OME>';
  const companionBuf = tiff(Array.from({ length: 5 }, (_, i) => ({
    width: 16,
    height: 16,
    bits: 16,
    samples: [mkPlane(i + 1)],
    tags: i ? {} : { 270: binaryOnlyXml },
  })));
  await assert.rejects(readImage("companion.ome.tif", companionBuf), /companion file/);
});
