// The image reader on small tifffile and Pillow files (fixtures/make_fixtures.py) and the label TIFF.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fromArrayBuffer } from "geotiff";
import { channelChoices, describedLayout, readImage, writeLabelTiff } from "../src/image-io.js";
import { channelToUint8 } from "../src/preprocess.js";

const fixture = (name) => {
  const bytes = readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
};
const base = (x, y) => (x * 7 + y * 3) & 255;

test("an RGB TIFF is three colour planes, offered together and one by one", async () => {
  const image = await readImage("rgb.tif", fixture("rgb.tif"));
  assert.equal(image.width, 10);
  assert.equal(image.height, 12);
  assert.deepEqual(image.planes.map((plane) => plane.label), ["red", "green", "blue"]);
  assert.equal(image.planes[2].data[1 * 10 + 2], base(2, 1) + 2);
  assert.deepEqual(channelChoices(image).map((item) => item.id), ["rgb", "0", "1", "2"]);
});

test("an alpha sample is left out; an unspecified extra sample is its own channel", async () => {
  const rgba = await readImage("rgba.tif", fixture("rgba.tif"));
  assert.deepEqual(rgba.planes.map((plane) => plane.label), ["red", "green", "blue"]);
  const two = await readImage("two-samples.tif", fixture("two-samples.tif"));
  assert.deepEqual(two.planes.map((plane) => plane.label), ["sample 1", "sample 2"]);
  assert.equal(two.planes[1].data[5], base(5, 0) + 5);
  // Two samples are not colour: each is offered alone, greyscale.
  assert.deepEqual(channelChoices(two).map((item) => item.id), ["0", "1"]);
});

test("16-bit and float TIFFs keep their values", async () => {
  const image = await readImage("uint16.tif", fixture("uint16.tif"));
  assert.ok(image.planes[0].data instanceof Uint16Array);
  assert.equal(image.planes[0].data[11 * 10 + 9], base(9, 11) * 300);
  assert.equal(image.format, "TIFF");
});

test("NaN pixels are read, then refused before the model sees them", async () => {
  const image = await readImage("nan.tif", fixture("nan.tif"));
  assert.ok(Number.isNaN(image.planes[0].data[3 * 10 + 4]));
  assert.throws(() => channelToUint8(image.planes[0].data), /NaN or infinite/);
});

test("OME-TIFF channels take their names; Z-stacks and ImageJ stacks are refused", async () => {
  const image = await readImage("two-channels.ome.tif", fixture("two-channels.ome.tif"));
  assert.equal(image.format, "OME-TIFF");
  assert.deepEqual(image.planes.map((plane) => plane.label), ["DAPI", "GFP & co"]);
  assert.equal(image.planes[1].data[4], base(4, 0) * 2);
  await assert.rejects(readImage("stack.ome.tif", fixture("stack.ome.tif")), /Z-stack \(3 slices, 1 time points\)/);
  await assert.rejects(readImage("zstack-imagej.tif", fixture("zstack-imagej.tif")), /ImageJ Z-stack/);
  const hyperstack = await readImage("hyperstack.tif", fixture("hyperstack.tif"));
  assert.equal(hyperstack.format, "ImageJ TIFF");
  assert.deepEqual(hyperstack.planes.map((plane) => plane.label), ["Channel 1", "Channel 2"]);
});

test("OME-XML with a namespace prefix, single quotes and entities is understood", () => {
  const xml = `<?xml version="1.0"?><ome:OME xmlns:ome="http://www.openmicroscopy.org/Schemas/OME/2016-06"><ome:Image ID='Image:0'>`
    + `<ome:Pixels SizeC='2' SizeZ="1" SizeT='1'><ome:Channel Name='A &amp; B'/><ome:Channel Name="&#67;y5"/></ome:Pixels></ome:Image></ome:OME>`;
  assert.deepEqual(describedLayout("x.ome.tif", xml, 2), { format: "OME-TIFF", names: ["A & B", "Cy5"] });
  assert.throws(() => describedLayout("x.ome.tif", xml.replace("SizeZ=\"1\"", "SizeZ='4'"), 2), /Z-stack/);
  const two = xml.replace("</ome:OME>", "<ome:Image ID='Image:1'><ome:Pixels SizeC='1'/></ome:Image></ome:OME>");
  assert.throws(() => describedLayout("x.ome.tif", two, 2), /holds 2 OME images/);
});

test("palette, 1-bit and 16-bit PNGs are unpacked", async () => {
  const palette = await readImage("palette.png", fixture("palette.png"));
  assert.deepEqual(palette.planes.map((plane) => plane.label), ["red", "green", "blue"]);
  // Index base % 4 → [black, red, green, blue].
  const index = base(1, 0) % 4;
  assert.deepEqual(palette.planes.map((plane) => plane.data[1]), [[0, 0, 0], [255, 0, 0], [0, 255, 0], [0, 0, 255]][index]);
  const bits = await readImage("bits.png", fixture("bits.png"));
  assert.equal(bits.planes.length, 1);
  assert.deepEqual([...bits.planes[0].data.slice(0, 4)], [0, 1, 0, 1].map((_, x) => base(x, 0) % 2));
  const grey = await readImage("grey16.png", fixture("grey16.png"));
  assert.equal(grey.planes[0].data[2 * 10 + 3], base(3, 2) * 200);
});

test("other files and tiny images are refused", async () => {
  await assert.rejects(readImage("x.nii", new Uint8Array(16).buffer), /not a TIFF, OME-TIFF or PNG/);
});

test("the label TIFF round-trips through geotiff at 16 and 32 bits", async () => {
  for (const max of [65535, 70000]) {
    const labels = Uint32Array.from({ length: 6 * 4 }, (_, i) => (i === 5 ? max : i % 3));
    const bytes = writeLabelTiff(labels, 6, 4);
    const image = await (await fromArrayBuffer(bytes.buffer)).getImage();
    const [data] = await image.readRasters();
    assert.equal(image.getBitsPerSample(), max > 65535 ? 32 : 16);
    assert.deepEqual([image.getWidth(), image.getHeight()], [6, 4]);
    assert.deepEqual([...data], [...labels]);
  }
});
