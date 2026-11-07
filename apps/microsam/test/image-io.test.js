// The image reader on small tifffile and Pillow files (fixtures/make_fixtures.py) and the label TIFF.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { writeLabelTiff } from "@neurodesk/webapp-components/file-io/tiff";
import { channelChoices, describedLayout, MAX_PIXELS, readImage } from "../src/image-io.js";
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

test("ExtraSamples alpha is left out in either order", async () => {
  // red, green, blue = base + 0..2; the unspecified sample is base + 3; alpha is 255.
  for (const name of ["extras-0-2.tif", "extras-2-0.tif"]) {
    const image = await readImage(name, fixture(name));
    assert.deepEqual(image.planes.map((plane) => plane.label), ["red", "green", "blue", "sample 4"].map((label, i) => (name === "extras-2-0.tif" && i === 3 ? "sample 5" : label)), name);
    assert.equal(image.planes[3].data[1], base(1, 0) + 3, name);
    assert.deepEqual(channelChoices(image).map((item) => item.label), ["Colour (RGB)", ...image.planes.map((plane) => plane.label)], name);
  }
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

test("OME-TIFF channel names follow TiffData, not IFD order", async () => {
  // IFD 0 holds GFP (base * 2) and IFD 1 DAPI (base).
  const image = await readImage("mapped.ome.tif", fixture("mapped.ome.tif"));
  assert.deepEqual(image.planes.map((plane) => [plane.label, plane.data[1]]), [["GFP", base(1, 0) * 2], ["DAPI", base(1, 0)]]);
});

test("TiffData layouts the reader cannot follow are refused", () => {
  const xml = (tiffData, uuid = "") => `<OME UUID="urn:uuid:a"><Image ID="Image:0"><Pixels SizeC="2" SizeZ="1" SizeT="1">`
    + `<Channel Name="A" SamplesPerPixel="1"/><Channel Name="B" SamplesPerPixel="1"/>${tiffData}${uuid}</Pixels></Image></OME>`;
  assert.deepEqual(describedLayout("x", xml('<TiffData IFD="0" PlaneCount="2"/>'), [0, 1]).names, ["A", "B"]);
  assert.deepEqual(describedLayout("x", xml(""), [0, 1]).names, ["A", "B"]);
  assert.deepEqual(describedLayout("x", xml('<TiffData IFD="0" FirstC="1"/><TiffData IFD="1"/>'), [0, 1]).names, ["B", "A"]);
  assert.deepEqual(describedLayout("x", xml('<TiffData IFD="0"><UUID FileName="x.ome.tif">urn:uuid:a</UUID></TiffData><TiffData IFD="1" FirstC="1"/>'), [0, 1]).names, ["A", "B"]);
  assert.throws(() => describedLayout("x", xml('<TiffData IFD="0"><UUID FileName="y.ome.tif">urn:uuid:b</UUID></TiffData><TiffData IFD="1" FirstC="1"/>'), [0, 1]), /another file/);
  assert.throws(() => describedLayout("x", xml('<TiffData IFD="0"/><TiffData IFD="1"/>'), [0, 1]), /a channel in two IFDs/);
  assert.throws(() => describedLayout("x", xml('<TiffData IFD="0" PlaneCount="2"/><TiffData IFD="1" FirstC="1"/>'), [0, 1]), /IFD 1 named twice/);
  assert.throws(() => describedLayout("x", xml('<TiffData IFD="0" FirstC="2"/>'), [0, 1]), /channel 3 of 2/);
  assert.throws(() => describedLayout("x", xml('<TiffData IFD="0" FirstZ="1"/>'), [0, 1]), /beyond Z 0/);
  assert.throws(() => describedLayout("x", xml('<TiffData IFD="2" PlaneCount="2"/>'), [0, 1]), /IFD 0\) its OME-XML assigns to no channel/);
});

test("OME-XML with a namespace prefix, single quotes and entities is understood", () => {
  const xml = `<?xml version="1.0"?><ome:OME xmlns:ome="http://www.openmicroscopy.org/Schemas/OME/2016-06"><ome:Image ID='Image:0'>`
    + `<ome:Pixels SizeC='2' SizeZ="1" SizeT='1'><ome:Channel Name='A &amp; B'/><ome:Channel Name="&#67;y5"/></ome:Pixels></ome:Image></ome:OME>`;
  assert.deepEqual(describedLayout("x.ome.tif", xml, [0, 1]), { format: "OME-TIFF", names: ["A & B", "Cy5"] });
  assert.throws(() => describedLayout("x.ome.tif", xml.replace("SizeZ=\"1\"", "SizeZ='4'"), [0, 1]), /Z-stack/);
  const two = xml.replace("</ome:OME>", "<ome:Image ID='Image:1'><ome:Pixels SizeC='1'/></ome:Image></ome:OME>");
  assert.throws(() => describedLayout("x.ome.tif", two, [0, 1]), /holds 2 OME images/);
});

test("a palette TIFF is its red, green and blue colours, offered together", async () => {
  const image = await readImage("palette-blue.tif", fixture("palette-blue.tif"));
  assert.deepEqual(image.planes.map((plane) => plane.label), ["red", "green", "blue"]);
  assert.deepEqual(channelChoices(image).map((item) => item.id), ["rgb", "0", "1", "2"]);
  const index = Array.from({ length: 12 * 10 }, (_, i) => base(i % 10, Math.floor(i / 10)) % 4);
  assert.deepEqual(image.planes.map((plane) => Array.from(plane.data)), [index.map(() => 0), index.map(() => 0), index.map((k) => k * 80)]);
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

test("images over 4096 × 4096 pixels are refused before decoding", async () => {
  assert.equal(MAX_PIXELS, 4096 * 4096);
  const header = (width, height) => {
    const bytes = writeLabelTiff(new Uint32Array(64), 8, 8);
    const view = new DataView(bytes.buffer);
    // ImageWidth and ImageLength are the second and third entries of the first IFD, after NewSubfileType.
    const ifd = view.getUint32(4, true);
    assert.deepEqual([view.getUint16(ifd + 2 + 12, true), view.getUint16(ifd + 2 + 24, true)], [256, 257]);
    view.setUint32(ifd + 2 + 12 + 8, width, true);
    view.setUint32(ifd + 2 + 24 + 8, height, true);
    return bytes.buffer;
  };
  await assert.rejects(readImage("big.tif", header(4097, 4096)), /4097 × 4096; split images over 16 megapixels \(4096 × 4096\) into tiles first/);
  await assert.rejects(readImage("big.tif", header(4096, 4096)), (error) => !/megapixels/.test(error.message));
  // A sample type geotiff cannot decode (64-bit unsigned) is refused for its size first.
  const uint64 = header(4097, 4096);
  const view = new DataView(uint64);
  const ifd = view.getUint32(4, true);
  assert.equal(view.getUint16(ifd + 2 + 36, true), 258);
  view.setUint16(ifd + 2 + 36 + 8, 64, true);
  await assert.rejects(readImage("big.tif", uint64), /4097 × 4096; split images over 16 megapixels \(4096 × 4096\) into tiles first/);
});
