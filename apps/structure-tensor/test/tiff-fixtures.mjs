// Small TIFF builder for the tests: uint8 greyscale pages, one strip each, with any
// ImageDescription (OME-XML) and optional deflate compression.
import { deflateSync } from "node:zlib";

/** `pages` are Uint8Arrays of width × height; returns an ArrayBuffer. */
export function buildTiff({ width, height, pages, description = null, deflate = false }) {
  const strips = pages.map((page) => (deflate ? new Uint8Array(deflateSync(page)) : page));
  const text = description === null ? null : new TextEncoder().encode(`${description}\0`);
  const entries = 9 + (text ? 1 : 0);
  const ifdBytes = 2 + entries * 12 + 4;
  const dataStart = 8 + pages.length * ifdBytes + (text ? text.length : 0);
  const total = dataStart + strips.reduce((sum, strip) => sum + strip.length, 0);
  const buffer = new ArrayBuffer(total);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  view.setUint16(0, 0x4949);
  view.setUint16(2, 42, true);
  view.setUint32(4, 8, true);
  const textAt = 8 + pages.length * ifdBytes;
  if (text) bytes.set(text, textAt);
  let stripAt = dataStart;
  strips.forEach((strip, z) => {
    const ifd = 8 + z * ifdBytes;
    const tags = [
      [256, 4, 1, width],
      [257, 4, 1, height],
      [258, 3, 1, 8],
      [259, 3, 1, deflate ? 8 : 1],
      [262, 3, 1, 1],
      ...(text ? [[270, 2, text.length, textAt]] : []),
      [273, 4, 1, stripAt],
      [277, 3, 1, 1],
      [278, 4, 1, height],
      [279, 4, 1, strip.length],
    ];
    view.setUint16(ifd, tags.length, true);
    tags.forEach(([code, type, count, value], k) => {
      const at = ifd + 2 + k * 12;
      view.setUint16(at, code, true);
      view.setUint16(at + 2, type, true);
      view.setUint32(at + 4, count, true);
      if (type === 3) view.setUint16(at + 8, value, true);
      else view.setUint32(at + 8, value, true);
    });
    view.setUint32(ifd + 2 + tags.length * 12, z + 1 < pages.length ? ifd + ifdBytes : 0, true);
    bytes.set(strip, stripAt);
    stripAt += strip.length;
  });
  return buffer;
}

/** An OME-XML description with the given Pixels attributes and `channels` Channel elements, under a prefix. */
export function omeXml({ prefix = "", channels = 1, ...pixels }) {
  const p = prefix ? `${prefix}:` : "";
  const ns = prefix ? `xmlns:${prefix}` : "xmlns";
  const attributes = Object.entries({ DimensionOrder: "XYZCT", Type: "uint8", ...pixels }).map(([k, v]) => `${k}="${v}"`).join(" ");
  const channelElements = Array.from({ length: channels }, (_, c) => `<${p}Channel ID="Channel:0:${c}" SamplesPerPixel="1"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><${p}OME ${ns}="http://www.openmicroscopy.org/Schemas/OME/2016-06"><${p}Image ID="Image:0"><${p}Pixels ID="Pixels:0" ${attributes}>${channelElements}<${p}TiffData/></${p}Pixels></${p}Image></${p}OME>`;
}
