// Test-only baseline TIFF encoder (uncompressed strips, one strip per page) for reader tests.
// pages: [{ width, height, data: TypedArray (width*height*samples), samples?, photometric?,
//           sampleFormat?, description?, xResolution?, yResolution?, extraSamples? }]
const TYPE = { BYTE: 1, ASCII: 2, SHORT: 3, LONG: 4, RATIONAL: 5 };

export function encodeTiff(pages, { littleEndian = true } = {}) {
  const chunks = [];
  let size = 8;
  const layout = pages.map((page) => {
    const bytes = new Uint8Array(page.data.buffer, page.data.byteOffset, page.data.byteLength).slice();
    if (!littleEndian && page.data.BYTES_PER_ELEMENT > 1) {
      const n = page.data.BYTES_PER_ELEMENT;
      for (let i = 0; i < bytes.length; i += n) bytes.subarray(i, i + n).reverse();
    }
    const dataOffset = size;
    size += bytes.length + (bytes.length % 2);
    const description = page.description === undefined ? null : new TextEncoder().encode(`${page.description}\0`);
    const descriptionOffset = description ? size : 0;
    if (description) size += description.length + (description.length % 2);
    const resolutionOffset = size;
    size += 16;
    const entries = 13 + (page.extraSamples ? 1 : 0);
    const ifdOffset = size;
    size += 2 + entries * 12 + 4;
    return { page, bytes, dataOffset, description, descriptionOffset, resolutionOffset, ifdOffset };
  });
  const buffer = new ArrayBuffer(size);
  const view = new DataView(buffer);
  const u8 = new Uint8Array(buffer);
  view.setUint16(0, littleEndian ? 0x4949 : 0x4d4d, false);
  view.setUint16(2, 42, littleEndian);
  view.setUint32(4, layout[0].ifdOffset, littleEndian);
  layout.forEach((entry, index) => {
    const { page, bytes } = entry;
    const samples = page.samples ?? 1;
    const bits = page.data.BYTES_PER_ELEMENT * 8;
    u8.set(bytes, entry.dataOffset);
    if (entry.description) u8.set(entry.description, entry.descriptionOffset);
    view.setUint32(entry.resolutionOffset, page.xResolution?.[0] ?? 1, littleEndian);
    view.setUint32(entry.resolutionOffset + 4, page.xResolution?.[1] ?? 1, littleEndian);
    view.setUint32(entry.resolutionOffset + 8, page.yResolution?.[0] ?? 1, littleEndian);
    view.setUint32(entry.resolutionOffset + 12, page.yResolution?.[1] ?? 1, littleEndian);
    const tags = [
      [256, TYPE.LONG, 1, page.width],
      [257, TYPE.LONG, 1, page.height],
      samples === 2 ? [258, TYPE.SHORT, 2, [bits, bits]] : [258, TYPE.SHORT, 1, bits],
      [259, TYPE.SHORT, 1, 1],
      [262, TYPE.SHORT, 1, page.photometric ?? 1],
      [270, TYPE.ASCII, entry.description?.length ?? 1, entry.description ? entry.descriptionOffset : 0],
      [273, TYPE.LONG, 1, entry.dataOffset],
      [277, TYPE.SHORT, 1, samples],
      [278, TYPE.LONG, 1, page.height],
      [279, TYPE.LONG, 1, bytes.length],
      [282, TYPE.RATIONAL, 1, entry.resolutionOffset],
      [283, TYPE.RATIONAL, 1, entry.resolutionOffset + 8],
      ...(page.extraSamples ? [[338, TYPE.SHORT, page.extraSamples.length, page.extraSamples]] : []),
      [339, TYPE.SHORT, 1, page.sampleFormat ?? 1],
    ];
    let p = entry.ifdOffset;
    view.setUint16(p, tags.length, littleEndian);
    p += 2;
    for (const [tag, type, count, value] of tags) {
      view.setUint16(p, tag, littleEndian);
      view.setUint16(p + 2, type, littleEndian);
      view.setUint32(p + 4, count, littleEndian);
      if (Array.isArray(value)) {
        if (type !== TYPE.SHORT || count > 2) throw new Error('Only up to two inline SHORT values are supported.');
        value.forEach((v, i) => view.setUint16(p + 8 + 2 * i, v, littleEndian));
      } else if (type === TYPE.SHORT && count === 1) view.setUint16(p + 8, value, littleEndian);
      else if (type === TYPE.ASCII && count <= 4 && !entry.description) view.setUint32(p + 8, 0, littleEndian);
      else view.setUint32(p + 8, value, littleEndian);
      p += 12;
    }
    view.setUint32(p, index + 1 < layout.length ? layout[index + 1].ifdOffset : 0, littleEndian);
  });
  return new Uint8Array(buffer);
}
