// Minimal little-endian uncompressed TIFF writer for test fixtures: one uint8/uint16
// page per z plane, an optional ImageDescription and x/y resolution.
const TYPE = { SHORT: 3, LONG: 4, RATIONAL: 5, ASCII: 2 };

export function writeTiffStack({ data, shape }, { description = "", resolution = null } = {}) {
  const [nz, ny, nx] = shape.length === 3 ? shape : [1, ...shape];
  const bytesPerSample = data.BYTES_PER_ELEMENT;
  const planeBytes = ny * nx * bytesPerSample;
  const chunks = [];
  let offset = 8;
  const header = Buffer.alloc(8);
  header.write("II", 0, "latin1");
  header.writeUInt16LE(42, 2);
  chunks.push(header);
  const firstIfdAt = [];
  let previousNext = { buffer: header, at: 4 };
  for (let z = 0; z < nz; z++) {
    const pixels = Buffer.from(data.buffer, data.byteOffset + z * planeBytes, planeBytes);
    const pixelOffset = offset;
    chunks.push(pixels);
    offset += planeBytes;
    const extra = [];
    let extraOffset = 0;
    const tags = [
      [256, TYPE.LONG, 1, nx],
      [257, TYPE.LONG, 1, ny],
      [258, TYPE.SHORT, 1, bytesPerSample * 8],
      [259, TYPE.SHORT, 1, 1],
      [262, TYPE.SHORT, 1, 1],
    ];
    const ascii = z === 0 && description ? Buffer.from(`${description}\0`, "latin1") : null;
    if (ascii) tags.push([270, TYPE.ASCII, ascii.length, ascii]);
    tags.push([273, TYPE.LONG, 1, pixelOffset], [277, TYPE.SHORT, 1, 1], [278, TYPE.LONG, 1, ny], [279, TYPE.LONG, 1, planeBytes]);
    if (resolution) {
      for (const [tag, value] of [[282, resolution[0]], [283, resolution[1]]]) {
        const rational = Buffer.alloc(8);
        rational.writeUInt32LE(Math.round(value * 1e6), 0);
        rational.writeUInt32LE(1e6, 4);
        tags.push([tag, TYPE.RATIONAL, 1, rational]);
      }
      tags.push([296, TYPE.SHORT, 1, 1]);
    }
    tags.push([339, TYPE.SHORT, 1, 1]);
    const ifdSize = 2 + tags.length * 12 + 4;
    const ifd = Buffer.alloc(ifdSize);
    ifd.writeUInt16LE(tags.length, 0);
    tags.forEach(([tag, type, count, value], i) => {
      const at = 2 + i * 12;
      ifd.writeUInt16LE(tag, at);
      ifd.writeUInt16LE(type, at + 2);
      ifd.writeUInt32LE(count, at + 4);
      if (Buffer.isBuffer(value)) {
        ifd.writeUInt32LE(offset + ifdSize + extraOffset, at + 8);
        extra.push(value);
        extraOffset += value.length + (value.length % 2);
        if (value.length % 2) extra.push(Buffer.alloc(1));
      } else if (type === TYPE.SHORT) {
        ifd.writeUInt16LE(value, at + 8);
      } else {
        ifd.writeUInt32LE(value, at + 8);
      }
    });
    previousNext.buffer.writeUInt32LE(offset, previousNext.at);
    firstIfdAt.push(offset);
    previousNext = { buffer: ifd, at: ifdSize - 4 };
    chunks.push(ifd, ...extra);
    offset += ifdSize + extraOffset;
  }
  return Buffer.concat(chunks);
}
