import { test } from "node:test";
import assert from "node:assert/strict";
import { readTiffStack } from "../src/tiff.js";
import { writeTiffStack } from "./tiff-fixture.mjs";

const arrayBuffer = (buffer) => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length);

test("a multi-page uint16 TIFF reads as a z, y, x stack with its ImageJ voxel size", async () => {
  const data = Uint16Array.from({ length: 3 * 4 * 5 }, (_, i) => i * 7);
  const tiff = writeTiffStack({ data, shape: [3, 4, 5] }, { description: "ImageJ=1.53t\nimages=3\nslices=3\nunit=micron\nspacing=0.3\n", resolution: [1 / 0.103, 1 / 0.103] });
  const image = await readTiffStack(arrayBuffer(tiff));
  assert.deepEqual(image.shape, [3, 4, 5]);
  assert.equal(image.dtype, "uint16");
  assert.deepEqual(Array.from(image.data), Array.from(data));
  assert.ok(Math.abs(image.voxelSize.z - 300) < 1e-6);
  assert.ok(Math.abs(image.voxelSize.x - 103) < 1e-3);
});

test("a one-page TIFF is a 2D image; OME physical sizes are read in nm", async () => {
  const data = Uint8Array.from({ length: 12 }, (_, i) => i);
  const ome = '<?xml version="1.0"?><OME xmlns="http://www.openmicroscopy.org/Schemas/OME/2016-06"><Image ID="Image:0"><Pixels ID="Pixels:0" DimensionOrder="XYZCT" Type="uint8" SizeX="4" SizeY="3" SizeZ="1" SizeC="1" SizeT="1" PhysicalSizeX="0.065" PhysicalSizeY="0.065"/></Image></OME>';
  const image = await readTiffStack(arrayBuffer(writeTiffStack({ data, shape: [3, 4] }, { description: ome })));
  assert.deepEqual(image.shape, [3, 4]);
  assert.equal(image.dtype, "uint8");
  assert.ok(Math.abs(image.voxelSize.x - 65) < 1e-9);
  assert.equal(image.voxelSize.z, null);
});

test("multichannel ImageJ stacks are refused", async () => {
  const tiff = writeTiffStack({ data: new Uint16Array(2 * 4), shape: [2, 2, 2] }, { description: "ImageJ=1.53t\nimages=2\nchannels=2\n" });
  await assert.rejects(readTiffStack(arrayBuffer(tiff)), /several channels/);
});

const prefixedOme = (sizeC) => `<?xml version="1.0"?><ome:OME xmlns:ome="http://www.openmicroscopy.org/Schemas/OME/2016-06"><ome:Image ID="Image:0"><ome:Pixels ID="Pixels:0" DimensionOrder="XYZCT" Type="uint16" SizeX="2" SizeY="2" SizeZ="${4 / sizeC}" SizeC="${sizeC}" SizeT="1" PhysicalSizeX="0.1" PhysicalSizeY="0.1" PhysicalSizeZ="0.25"/></ome:Image></ome:OME>`;

test("OME-XML with a namespace prefix gives its voxel size", async () => {
  const tiff = writeTiffStack({ data: new Uint16Array(4 * 4), shape: [4, 2, 2] }, { description: prefixedOme(1) });
  const image = await readTiffStack(arrayBuffer(tiff));
  assert.deepEqual(image.shape, [4, 2, 2]);
  assert.ok(Math.abs(image.voxelSize.z - 250) < 1e-9);
  assert.ok(Math.abs(image.voxelSize.x - 100) < 1e-9);
});

test("multichannel OME-TIFFs are refused whatever their namespace prefix", async () => {
  const tiff = writeTiffStack({ data: new Uint16Array(4 * 4), shape: [4, 2, 2] }, { description: prefixedOme(2) });
  await assert.rejects(readTiffStack(arrayBuffer(tiff)), /several channels/);
  const timeSeries = prefixedOme(1).replace('SizeT="1"', 'SizeT="4"');
  await assert.rejects(readTiffStack(arrayBuffer(writeTiffStack({ data: new Uint16Array(4 * 4), shape: [4, 2, 2] }, { description: timeSeries }))), /time points/);
});
