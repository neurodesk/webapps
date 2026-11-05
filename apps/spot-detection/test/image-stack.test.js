import { test } from "node:test";
import assert from "node:assert/strict";
import { readImageStack } from "../src/image-stack.js";
import { writeTiffStack } from "./tiff-fixture.mjs";
import { writeTiffStack as writeSharedTiff } from "@neurodesk/webapp-components/file-io/tiff";

const arrayBuffer = (buffer) => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length);

test("a multi-page uint16 TIFF reads as a z, y, x stack with its ImageJ voxel size", async () => {
  const data = Uint16Array.from({ length: 3 * 4 * 5 }, (_, i) => i * 7);
  const tiff = writeTiffStack({ data, shape: [3, 4, 5] }, { description: "ImageJ=1.53t\nimages=3\nslices=3\nunit=micron\nspacing=0.3\n", resolution: [1 / 0.103, 1 / 0.103] });
  const image = await readImageStack(arrayBuffer(tiff));
  assert.deepEqual(image.shape, [3, 4, 5]);
  assert.equal(image.dtype, "uint16");
  assert.deepEqual(Array.from(image.data), Array.from(data));
  assert.ok(Math.abs(image.voxelSize.z - 300) < 1e-6);
  assert.ok(Math.abs(image.voxelSize.x - 103) < 1e-3);
});

test("a one-page TIFF is a 2D image; OME physical sizes are read in nm", async () => {
  const data = Uint8Array.from({ length: 12 }, (_, i) => i);
  const ome = '<?xml version="1.0"?><OME xmlns="http://www.openmicroscopy.org/Schemas/OME/2016-06"><Image ID="Image:0"><Pixels ID="Pixels:0" DimensionOrder="XYZCT" Type="uint8" SizeX="4" SizeY="3" SizeZ="1" SizeC="1" SizeT="1" PhysicalSizeX="0.065" PhysicalSizeY="0.065"/></Image></OME>';
  const image = await readImageStack(arrayBuffer(writeTiffStack({ data, shape: [3, 4] }, { description: ome })));
  assert.deepEqual(image.shape, [3, 4]);
  assert.equal(image.dtype, "uint8");
  assert.ok(Math.abs(image.voxelSize.x - 65) < 1e-9);
  assert.equal(image.voxelSize.z, null);
});

test("multichannel ImageJ stacks are refused", async () => {
  const tiff = writeTiffStack({ data: new Uint16Array(2 * 4), shape: [2, 2, 2] }, { description: "ImageJ=1.53t\nimages=2\nchannels=2\n" });
  await assert.rejects(readImageStack(arrayBuffer(tiff)), /several channels/);
});

const prefixedOme = (sizeC) => `<?xml version="1.0"?><ome:OME xmlns:ome="http://www.openmicroscopy.org/Schemas/OME/2016-06"><ome:Image ID="Image:0"><ome:Pixels ID="Pixels:0" DimensionOrder="XYZCT" Type="uint16" SizeX="2" SizeY="2" SizeZ="${4 / sizeC}" SizeC="${sizeC}" SizeT="1" PhysicalSizeX="0.1" PhysicalSizeY="0.1" PhysicalSizeZ="0.25"/></ome:Image></ome:OME>`;

test("OME-XML with a namespace prefix gives its voxel size", async () => {
  const tiff = writeTiffStack({ data: new Uint16Array(4 * 4), shape: [4, 2, 2] }, { description: prefixedOme(1) });
  const image = await readImageStack(arrayBuffer(tiff));
  assert.deepEqual(image.shape, [4, 2, 2]);
  assert.ok(Math.abs(image.voxelSize.z - 250) < 1e-9);
  assert.ok(Math.abs(image.voxelSize.x - 100) < 1e-9);
});

test("multichannel OME-TIFFs are refused whatever their namespace prefix", async () => {
  const tiff = writeTiffStack({ data: new Uint16Array(4 * 4), shape: [4, 2, 2] }, { description: prefixedOme(2) });
  await assert.rejects(readImageStack(arrayBuffer(tiff)), /several channels/);
  const timeSeries = prefixedOme(1).replace('SizeT="1"', 'SizeT="4"');
  await assert.rejects(readImageStack(arrayBuffer(writeTiffStack({ data: new Uint16Array(4 * 4), shape: [4, 2, 2] }, { description: timeSeries }))), /time points/);
});

test("single-quoted OME-XML attributes are read: several channels are refused", async () => {
  const quoted = prefixedOme(2).replace(/"/g, "'");
  await assert.rejects(readImageStack(arrayBuffer(writeTiffStack({ data: new Uint16Array(4 * 4), shape: [4, 2, 2] }, { description: quoted }))), /several channels/);
  const one = await readImageStack(arrayBuffer(writeTiffStack({ data: new Uint16Array(4 * 4), shape: [4, 2, 2] }, { description: prefixedOme(1).replace(/"/g, "'") })));
  assert.ok(Math.abs(one.voxelSize.z - 250) < 1e-9);
});

test("float32 and float64 stacks keep their type; other sample types are refused", async () => {
  for (const Type of [Float32Array, Float64Array]) {
    const data = Type.from({ length: 2 * 2 * 3 }, (_, i) => i / 4 - 1);
    const image = await readImageStack(arrayBuffer(writeSharedTiff({ width: 3, height: 2, data })));
    assert.equal(image.dtype, Type.name.replace("Array", "").toLowerCase());
    assert.ok(image.data instanceof Type);
    assert.deepEqual(image.shape, [2, 2, 3]);
    assert.deepEqual(Array.from(image.data), Array.from(data));
    assert.equal(image.voxelSize, null);
  }
  await assert.rejects(readImageStack(arrayBuffer(writeSharedTiff({ width: 2, height: 2, data: new Int16Array(4) }))), /int16 is not uint8, uint16, float32 or float64/);
});

test("a TIFF whose header declares more than the memory budget is refused before any pixel is allocated", async () => {
  const buffer = writeTiffStack({ data: new Uint16Array(4), shape: [2, 1, 2] });
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  // Rewrite ImageWidth and ImageLength in every IFD to 32768.
  for (let ifd = view.getUint32(4, true); ifd; ) {
    const entries = view.getUint16(ifd, true);
    for (let i = 0; i < entries; i++) {
      const at = ifd + 2 + i * 12;
      if (view.getUint16(at, true) === 256 || view.getUint16(at, true) === 257) view.setUint32(at + 8, 32768, true);
    }
    ifd = view.getUint32(ifd + 2 + entries * 12, true);
  }
  const allocate = Uint16Array;
  let largest = 0;
  globalThis.Uint16Array = new Proxy(allocate, { construct(target, args) { if (typeof args[0] === "number") largest = Math.max(largest, args[0]); return new target(...args); } });
  try {
    await assert.rejects(readImageStack(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)), /2 × 32768 × 32768 uint16 image needs about 78\.0 GB/);
  } finally {
    globalThis.Uint16Array = allocate;
  }
  assert.ok(largest < 1e6, `allocated ${largest} elements before refusing`);
});
