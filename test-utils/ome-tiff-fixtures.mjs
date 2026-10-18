import { deflateSync } from "node:zlib";

const namespace = "http://www.openmicroscopy.org/Schemas/OME/2016-06";

// Independent classic-TIFF strips. No fiff writer or metadata parser is used.
export function omeTiffFixture({ images = [{}], metadataImages = "", subIfd = false, reduced = true, volume = false, prefix = "", quote = '"', namespaceUri = namespace } = {}) {
  const tag = (name) => `${prefix}${name}`;
  const attrs = (values) => Object.entries(values).map(([key, value]) => `${key}=${quote}${value}${quote}`).join(" ");
  const descriptors = images.map((image, index) => ({ size: [20, 20], calibration: 'PhysicalSizeX="0.25" PhysicalSizeY="0.75"', ...image, index }));
  const xmlImages = (subIfd || volume ? descriptors.slice(0, 1) : descriptors).map(({ size, calibration, planes = "", index, tiffData }) => (
    `<${tag("Image")} ${attrs({ ID: `Image:${index}` })}><${tag("Pixels")} ${attrs({ ID: `Pixels:${index}`, DimensionOrder: "XYZCT", Type: "float", SizeX: size[0], SizeY: size[1], SizeZ: volume ? descriptors.length : 1, SizeC: 1, SizeT: 1 })} ${calibration}>` +
    `<${tag("Channel")} ${attrs({ ID: `Channel:${index}:0`, SamplesPerPixel: 1 })}/>` +
    (tiffData ?? `<${tag("TiffData")} ${attrs({ IFD: index, PlaneCount: volume ? descriptors.length : 1 })}/>` ) +
    planes + `</${tag("Pixels")}></${tag("Image")}>`
  )).join("");
  const xml = `<?xml version="1.0"?><${tag("OME")} xmlns${prefix ? `:${prefix.slice(0, -1)}` : ""}=${quote}${namespaceUri}${quote}>${metadataImages}${xmlImages}</${tag("OME")}>`;
  const description = Buffer.from(`${xml}\0`);
  const strips = descriptors.map(({ size, value, offset = 0 }) => {
    const pixels = new Float32Array(size[0] * size[1]);
    for (let y = 0; y < size[1]; y += 1) {
      for (let x = 0; x < size[0]; x += 1) pixels[y * size[0] + x] = value ?? offset + 1000 * Math.exp(-((x - 9) ** 2 + (y - 10) ** 2) / 12);
    }
    return deflateSync(new Uint8Array(pixels.buffer));
  });
  const offsets = [];
  let end = 8;
  const tags = descriptors.map(({ size }, index) => {
    const list = [[256, 4, 1, size[0]], [257, 4, 1, size[1]], [258, 3, 1, 32], [259, 3, 1, 8], [262, 3, 1, 1], [273, 4, 1, 0], [277, 3, 1, 1], [278, 4, 1, size[1]], [279, 4, 1, strips[index].length], [284, 3, 1, 1], [339, 3, 1, 3]];
    if (index === 0) list.push([270, 2, description.length, 0]);
    if (subIfd && index === 0) list.push([330, 4, 1, 0]);
    if (subIfd && index > 0) list.push([254, 4, 1, reduced ? 1 : 0]);
    list.sort((a, b) => a[0] - b[0]);
    offsets.push(end);
    end += 2 + list.length * 12 + 4;
    return list;
  });
  tags[0].find(([id]) => id === 270)[3] = end;
  end += description.length;
  tags.forEach((list, index) => {
    list.find(([id]) => id === 273)[3] = end;
    end += strips[index].length;
  });
  if (subIfd) tags[0].find(([id]) => id === 330)[3] = offsets[1];
  const bytes = Buffer.alloc(end);
  bytes.write("II");
  bytes.writeUInt16LE(42, 2);
  bytes.writeUInt32LE(offsets[0], 4);
  tags.forEach((list, index) => {
    let cursor = offsets[index];
    bytes.writeUInt16LE(list.length, cursor);
    cursor += 2;
    for (const [id, type, count, value] of list) {
      bytes.writeUInt16LE(id, cursor);
      bytes.writeUInt16LE(type, cursor + 2);
      bytes.writeUInt32LE(count, cursor + 4);
      bytes.writeUInt32LE(value, cursor + 8);
      cursor += 12;
    }
    bytes.writeUInt32LE(subIfd ? 0 : offsets[index + 1] ?? 0, cursor);
    strips[index].copy(bytes, list.find(([id]) => id === 273)[3]);
  });
  description.copy(bytes, tags[0].find(([id]) => id === 270)[3]);
  return bytes;
}

export const calibrationCases = [
  {
    name: "metadata-only-before-explicit-owners",
    metadataImages: '<Image ID="Image:metadata"><Pixels ID="Pixels:metadata" DimensionOrder="XYZCT" Type="float" SizeX="20" SizeY="20" SizeZ="20" SizeC="1" SizeT="1" PhysicalSizeX="10" PhysicalSizeY="20" PhysicalSizeZ="30"><Channel ID="Channel:metadata:0" SamplesPerPixel="1"/><MetadataOnly/></Pixels></Image>',
    images: Array.from({ length: 20 }, (_, z) => ({ offset: z * 17 })),
    size: [20, 20, 20],
    spacing: [10, 20, 30],
    issue: /unambiguously associate/,
  },
  { name: "missing-tiffdata", images: [{ tiffData: "<MetadataOnly/>" }], issue: /unambiguously associate/ },
  { name: "foreign-tiffdata", images: [{ tiffData: '<foreign:TiffData xmlns:foreign="urn:not-ome"/>' }], issue: /unambiguously associate/ },
  { name: "empty-tiffdata-defaults", images: [{ tiffData: "<TiffData/>" }], unit: "µm" },
  { name: "single-quoted-nm", images: [{ calibration: "PhysicalSizeX='0.25' PhysicalSizeY='0.75' PhysicalSizeXUnit='nm' PhysicalSizeYUnit='nm'" }], quote: "'", unit: "nm" },
  { name: "prefixed-xml", prefix: "ome:", images: [{ calibration: 'PhysicalSizeX="0.25" PhysicalSizeY="0.75" PhysicalSizeXUnit="n&#109;" PhysicalSizeYUnit="nm"' }], unit: "nm" },
  { name: "numeric-entities", images: [{ calibration: 'PhysicalSizeX="&#48;.25" PhysicalSizeY="7.5e-1"' }], unit: "µm" },
  { name: "unknown-single-quoted", images: [{ calibration: "PhysicalSizeX='0.25' PhysicalSizeY='0.75' PhysicalSizeXUnit='pixel' PhysicalSizeYUnit='pixel'" }], issue: /known spatial units/ },
  { name: "invalid-number", images: [{ calibration: 'PhysicalSizeX="0.25junk" PhysicalSizeY="0.75"' }], issue: /known physical pixel sizes/ },
  { name: "unknown-double-quoted", images: [{ calibration: 'PhysicalSizeX="0.25" PhysicalSizeY="0.75" PhysicalSizeXUnit="pixel"' }], issue: /known spatial units/ },
  { name: "ambiguous-image", images: [{}, { tiffData: '<TiffData IFD="0" PlaneCount="1"/>' }], issue: /unambiguously associate/ },
  { name: "foreign-plane", images: [{ planes: '<foreign:Plane xmlns:foreign="urn:not-ome" PositionX="100"/>' }], unit: "µm" },
  { name: "unselected-position", images: [{}, { planes: '<Plane TheZ="0" TheC="0" TheT="0" PositionX="100"/>' }], unit: "µm" },
  { name: "selected-position", images: [{ planes: '<Plane TheZ="0" TheC="0" TheT="0" PositionX="100"/>' }], issue: /source plane positions/ },
  { name: "other-image-uncalibrated", images: [{ size: [4098, 4098], value: 0 }, { calibration: "" }], issue: /known physical pixel sizes/ },
  { name: "other-image-calibrated", images: [{ size: [4098, 4098], value: 0 }, { calibration: 'PhysicalSizeX="10" PhysicalSizeY="20"' }], issue: /decoded grid.*selected OME Image/ },
  { name: "selected-second-image", images: [{ size: [4098, 4098], value: 0, planes: '<Plane TheZ="0" TheC="0" TheT="0" PositionY="100"/>' }, { calibration: 'PhysicalSizeX="51.225" PhysicalSizeY="153.675"' }], unit: "µm", spacing: [51.225, 153.675] },
  { name: "selected-second-position", images: [{ size: [4098, 4098], value: 0 }, { planes: '<Plane TheZ="0" TheC="0" TheT="0" PositionX="100"/>' }], issue: /source plane positions/ },
  { name: "true-subifd", images: [{ size: [4098, 4098], value: 0 }, {}], subIfd: true, unit: "µm", spacing: [51.225, 153.675] },
];
