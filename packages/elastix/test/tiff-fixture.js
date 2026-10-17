import { buildTiff, makeImageTags } from "@fideus-labs/fiff";

export async function tiffFixture({ attributes = 'PhysicalSizeX="0.25" PhysicalSizeY="0.75"', planes = "", size = [20, 20], data } = {}) {
  data ??= Float32Array.from({ length: size[0] * size[1] }, (_, index) => {
    const x = index % size[0], y = Math.floor(index / size[0]);
    return 1000 * Math.exp(-((x - 9) ** 2 + (y - 10) ** 2) / 12);
  });
  const xml = `<?xml version="1.0"?><OME xmlns="http://www.openmicroscopy.org/Schemas/OME/2016-06"><Image ID="Image:0"><Pixels ID="Pixels:0" DimensionOrder="XYZCT" Type="float" SizeX="${size[0]}" SizeY="${size[1]}" SizeZ="1" SizeC="1" SizeT="1" ${attributes}><Channel ID="Channel:0:0" SamplesPerPixel="1"/><TiffData IFD="0" PlaneCount="1"/>${planes}</Pixels></Image></OME>`;
  return new Uint8Array(await buildTiff([{
    tags: makeImageTags(size[0], size[1], 32, 3, "none", xml, false, 0),
    tiles: [new Uint8Array(data.buffer, data.byteOffset, data.byteLength)],
  }]));
}
