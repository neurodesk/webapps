// Fixtures are written by tifffile (scripts/make_fixtures.py), independently of this reader.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readTiffStack, writeImageJTiff, parseOmeXml, TiffRefusal } from "../src/index.js";

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const expected = Uint16Array.from({ length: 3 * 5 * 7 }, (_, i) => i * 3 + 1);
const close = (a, b, tolerance = 1e-9) => Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(b));

test("an ImageJ deflate stack keeps its type, order and micron calibration", async () => {
  const stack = await readTiffStack(fixture("imagej-uint16.tif"));
  assert.deepEqual([stack.width, stack.height, stack.depth, stack.dtype], [7, 5, 3, "uint16"]);
  assert.deepEqual(Array.from(stack.data), Array.from(expected));
  assert.equal(stack.spacingSource, "ImageJ");
  assert.ok(close(stack.spacingUm.x, 0.0659, 1e-6) && close(stack.spacingUm.y, 0.0659, 1e-6), JSON.stringify(stack.spacingUm));
  assert.equal(stack.spacingUm.z, 0.13);
});

test("OME-XML sizes in nanometres convert to micrometres, with or without a namespace prefix", async () => {
  for (const name of ["ome-float32.ome.tif", "ome-prefixed.ome.tif"]) {
    const stack = await readTiffStack(fixture(name));
    assert.equal(stack.spacingSource, "OME-XML", name);
    assert.ok(close(stack.spacingUm.x, 0.0659) && close(stack.spacingUm.y, 0.0659), `${name} ${JSON.stringify(stack.spacingUm)}`);
    assert.ok(close(stack.spacingUm.z, 0.13), name);
    assert.equal(stack.dtype, "float32");
    assert.equal(stack.depth, 3);
    assert.ok(close(stack.data[104], expected[104] / 7, 1e-6));
  }
  assert.equal(parseOmeXml('<ome:OME xmlns:ome="x"><ome:Image><ome:Pixels SizeX="2" PhysicalSizeX="5"/></ome:Image></ome:OME>').attributes.PhysicalSizeX, "5");
});

test("an alpha extra sample is not intensity; the first sample is read", async () => {
  const stack = await readTiffStack(fixture("gray-alpha.tif"));
  assert.equal(stack.dtype, "uint8");
  assert.deepEqual(Array.from(stack.data), Array.from(expected, (v) => v & 255));
});

test("WhiteIsZero pages are inverted to intensity", async () => {
  const stack = await readTiffStack(fixture("white-is-zero.tif"));
  assert.deepEqual(Array.from(stack.data), Array.from(expected, (v) => 255 - (v & 255)));
});

test("ImageJ Palette pages are intensities; Palette without ImageJ metadata is refused", async () => {
  const stack = await readTiffStack(fixture("imagej-palette.tif"));
  assert.deepEqual(Array.from(stack.data), Array.from(expected, (v) => v & 255));
  await assert.rejects(readTiffStack(fixture("palette.tif")), /Palette colour/);
});

test("a centimetre resolution tag gives the pixel size", async () => {
  const stack = await readTiffStack(fixture("resolution-cm.tif"));
  assert.equal(stack.spacingSource, "TIFF resolution");
  assert.ok(close(stack.spacingUm.x, 0.5));
  assert.equal(stack.spacingUm.z, null);
});

test("colour, multichannel samples and multichannel ImageJ stacks are refused", async () => {
  await assert.rejects(readTiffStack(fixture("rgb.tif")), /RGB colour/);
  await assert.rejects(readTiffStack(fixture("three-samples-minisblack.tif")), /3 channels per pixel/);
  await assert.rejects(readTiffStack(fixture("imagej-two-channels.tif")), /2 channels/);
  await assert.rejects(readTiffStack(Buffer.from("not a tiff")), TiffRefusal);
});

test("a stack over the memory budget is refused before decoding", async () => {
  await assert.rejects(readTiffStack(fixture("imagej-uint16.tif"), { maxBytes: 3 * 5 * 7 * 2 - 1 }), /limit/);
  await readTiffStack(fixture("imagej-uint16.tif"), { maxBytes: 3 * 5 * 7 * 2 });
});

test("writeImageJTiff round-trips float32 data and its calibration", async () => {
  const data = Float32Array.from({ length: 4 * 3 * 5 }, (_, i) => i / 3 - 2);
  const buffer = writeImageJTiff({ data, width: 5, height: 3, depth: 4, spacingUm: { x: 0.0658941, y: 0.0658941, z: 0.13 } });
  const stack = await readTiffStack(buffer);
  assert.deepEqual([stack.width, stack.height, stack.depth, stack.dtype], [5, 3, 4, "float32"]);
  assert.deepEqual(Array.from(stack.data), Array.from(data));
  assert.ok(close(stack.spacingUm.x, 0.0658941, 1e-6));
  assert.equal(stack.spacingUm.z, 0.13);
  assert.match(stack.description, /^ImageJ=1\.11a\nimages=4\nslices=4\nunit=micron\nspacing=0\.13\n/);
});
