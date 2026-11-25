// Pure Node PNG and JPEG raster image decoder with header preflight, CRC checks,
// PNG tRNS/Adam7/gAMA/iCCP handling, and JPEG EXIF orientation + ICC validation.
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { inflateSync } from "node:zlib";
import { InputTooLargeError, MAX_INPUT_BYTES } from "@neurodesk/webapp-components/file-io/input-limits";
import { probeRasterImage } from "@neurodesk/webapp-components/file-io/raster-image";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";

const NON_SRGB_PROFILE_RE =
  /\b(p3|display\s*p3|dci[- ]?p3|adobe\s*rgb|adobe\s*1998|prophoto|romm|rec\.?\s*2020|bt\.?\s*2020|wide\s*gamut|cmyk|linear|scrgb|aces|apple\s*rgb|colormatch|eci\s*rgb)\b/i;
const SRGB_PROFILE_RE = /\bsrgb\b|iec\s*61966[- ]?2[.-]1|srgb2014|srgb\s*iec61966/i;
const MAX_ICC_BYTES = 4 * 1024 * 1024;

// Standard sRGB chromaticities (ITU-R BT.709 / IEC 61966-2-1).
const SRGB_CHRM = Object.freeze([0.3127, 0.329, 0.64, 0.33, 0.3, 0.6, 0.15, 0.06]);
const CHRM_TOLERANCE = 0.025;

const PNG_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function pngCrc32(view, start, end) {
  let c = 0xffffffff;
  for (let i = start; i < end; i += 1) {
    c = PNG_CRC_TABLE[(c ^ view[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function readUint16BE(view, offset) {
  return (view[offset] << 8) | view[offset + 1];
}

function readUint16LE(view, offset) {
  return view[offset] | (view[offset + 1] << 8);
}

function readUint32BE(view, offset) {
  return (
    ((view[offset] << 24) >>> 0) +
    (view[offset + 1] << 16) +
    (view[offset + 2] << 8) +
    view[offset + 3]
  );
}

function readUint32LE(view, offset) {
  return (
    view[offset] +
    (view[offset + 1] << 8) +
    (view[offset + 2] << 16) +
    ((view[offset + 3] << 24) >>> 0)
  );
}

function asciiSlice(view, start, end) {
  let out = "";
  const stop = Math.min(end, view.length);
  for (let i = start; i < stop; i += 1) {
    out += String.fromCharCode(view[i]);
  }
  return out;
}

function readIccDescription(profile) {
  if (profile.length < 132) return "";
  const tagCount = Math.min(readUint32BE(profile, 128), 256);
  for (let i = 0; i < tagCount; i += 1) {
    const entryOffset = 132 + i * 12;
    if (entryOffset + 12 > profile.length) break;
    const sig = asciiSlice(profile, entryOffset, entryOffset + 4);
    if (sig !== "desc") continue;
    const tagOffset = readUint32BE(profile, entryOffset + 4);
    const tagSize = readUint32BE(profile, entryOffset + 8);
    if (tagOffset + 12 > profile.length || tagSize < 12) continue;
    const type = asciiSlice(profile, tagOffset, tagOffset + 4);
    if (type === "desc") {
      const len = readUint32BE(profile, tagOffset + 8);
      const start = tagOffset + 12;
      const stop = Math.min(profile.length, start + Math.min(len, tagSize - 12));
      return asciiSlice(profile, start, stop).replace(/\0+$/, "").trim();
    }
    if (type === "mluc" && tagOffset + 28 <= profile.length) {
      const recordCount = readUint32BE(profile, tagOffset + 8);
      if (recordCount >= 1) {
        const strLen = readUint32BE(profile, tagOffset + 20);
        const strOff = readUint32BE(profile, tagOffset + 24);
        const start = tagOffset + strOff;
        const stop = Math.min(profile.length, start + strLen);
        let text = "";
        for (let p = start; p + 1 < stop; p += 2) {
          const code = (profile[p] << 8) | profile[p + 1];
          if (code === 0) break;
          text += String.fromCharCode(code);
        }
        return text.trim();
      }
    }
  }
  return "";
}

function validateIccProfile(profile, chunkName, name) {
  if (profile.length < 128) {
    throw new Error(`${name}: embedded ICC profile is truncated or invalid.`);
  }
  const colorSpace = asciiSlice(profile, 16, 20).trim();
  const description = readIccDescription(profile);
  const label = description || chunkName || colorSpace || "unknown";
  if (colorSpace !== "RGB" && colorSpace !== "GRAY") {
    throw new Error(
      `${name}: embedded non-sRGB ICC color profile "${label}" (${colorSpace}) is not supported in the CLI; convert the image to sRGB first.`,
    );
  }
  const combined = `${description} ${chunkName}`.trim();
  if (NON_SRGB_PROFILE_RE.test(combined) || !SRGB_PROFILE_RE.test(combined)) {
    throw new Error(
      `${name}: embedded non-sRGB ICC color profile "${label}" is not supported in the CLI; convert the image to sRGB first.`,
    );
  }
  return label;
}

function inspectPngColorChunks(view, name) {
  let pos = 8;
  let hasSrgb = false;
  let gamma = null;
  let chrm = null;
  let iccp = null;

  while (pos + 12 <= view.length) {
    const length = readUint32BE(view, pos);
    const type = asciiSlice(view, pos + 4, pos + 8);
    const dataStart = pos + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > view.length) {
      throw new Error(`${name}: truncated PNG ${type} chunk.`);
    }
    const expectedCrc = readUint32BE(view, dataEnd);
    const actualCrc = pngCrc32(view, pos + 4, dataEnd);
    if (actualCrc !== expectedCrc) {
      throw new Error(`${name}: PNG ${type} chunk CRC mismatch.`);
    }

    if (type === "sRGB") {
      hasSrgb = true;
    } else if (type === "gAMA" && length === 4) {
      const value = readUint32BE(view, dataStart);
      if (value > 0) gamma = value / 100000;
    } else if (type === "cHRM" && length === 32) {
      chrm = [];
      for (let i = 0; i < 8; i += 1) {
        chrm.push(readUint32BE(view, dataStart + i * 4) / 100000);
      }
    } else if (type === "iCCP" && length > 2) {
      let nul = dataStart;
      while (nul < dataEnd && view[nul] !== 0) nul += 1;
      if (nul + 2 > dataEnd) {
        throw new Error(`${name}: malformed PNG iCCP chunk.`);
      }
      const profileName = asciiSlice(view, dataStart, nul).trim();
      const compressionMethod = view[nul + 1];
      if (compressionMethod !== 0) {
        throw new Error(`${name}: unsupported PNG iCCP compression method (${compressionMethod}).`);
      }
      let profileBytes;
      try {
        profileBytes = inflateSync(view.subarray(nul + 2, dataEnd), { maxOutputLength: MAX_ICC_BYTES });
      } catch (error) {
        throw new Error(`${name}: invalid PNG iCCP profile (${error.message}).`);
      }
      iccp = { profileName, profileBytes };
    } else if (type === "IEND") {
      break;
    }

    pos = dataEnd + 4;
  }

  let iccLabel = null;
  if (iccp) {
    iccLabel = validateIccProfile(iccp.profileBytes, iccp.profileName, name);
  } else if (!hasSrgb && chrm) {
    const matchesSrgb = chrm.every((val, idx) => Math.abs(val - SRGB_CHRM[idx]) <= CHRM_TOLERANCE);
    if (!matchesSrgb) {
      throw new Error(
        `${name}: PNG cHRM chunk specifies non-sRGB chromaticities; convert the image to sRGB first.`,
      );
    }
  }

  return { hasSrgb, gamma, iccLabel };
}

function applyGammaToSrgb(rgba, fileGamma) {
  const lut = new Uint8Array(256);
  const invGamma = 1 / fileGamma;
  for (let i = 0; i < 256; i += 1) {
    const linear = Math.pow(i / 255, invGamma);
    const srgb = linear <= 0.0031308 ? 12.92 * linear : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055;
    lut[i] = Math.min(255, Math.max(0, Math.round(srgb * 255)));
  }
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = lut[rgba[i]];
    rgba[i + 1] = lut[rgba[i + 1]];
    rgba[i + 2] = lut[rgba[i + 2]];
  }
}

function parseExifOrientation(payload) {
  if (payload.length < 14) return 1;
  const tiff = payload.subarray(6);
  const byteOrder = asciiSlice(tiff, 0, 2);
  let littleEndian;
  if (byteOrder === "II") {
    littleEndian = true;
  } else if (byteOrder === "MM") {
    littleEndian = false;
  } else {
    return 1;
  }
  const u16 = littleEndian ? readUint16LE : readUint16BE;
  const u32 = littleEndian ? readUint32LE : readUint32BE;
  if (u16(tiff, 2) !== 42) return 1;
  const ifdOffset = u32(tiff, 4);
  if (ifdOffset + 2 > tiff.length) return 1;
  const entryCount = u16(tiff, ifdOffset);
  for (let i = 0; i < entryCount; i += 1) {
    const entry = ifdOffset + 2 + i * 12;
    if (entry + 12 > tiff.length) break;
    const tag = u16(tiff, entry);
    if (tag !== 0x0112) continue;
    const type = u16(tiff, entry + 2);
    const count = u32(tiff, entry + 4);
    if (type === 3 && count >= 1) {
      const orientation = u16(tiff, entry + 8);
      if (orientation >= 1 && orientation <= 8) return orientation;
    }
  }
  return 1;
}

function inspectJpegMetadata(view, name) {
  let pos = 2;
  let exifOrientation = 1;
  let iccExpected = 0;
  const iccChunks = new Map();

  while (pos + 2 <= view.length) {
    if (view[pos] !== 0xff) break;
    while (pos < view.length && view[pos] === 0xff) pos += 1;
    if (pos >= view.length) break;
    const marker = view[pos];
    pos += 1;
    if (marker === 0xda || marker === 0xd9) break;
    if ((marker >= 0xd0 && marker <= 0xd8) || marker === 0x01) continue;
    if (pos + 2 > view.length) break;
    const segLen = readUint16BE(view, pos);
    if (segLen < 2 || pos + segLen > view.length) break;
    const payload = view.subarray(pos + 2, pos + segLen);

    if (marker === 0xe1 && payload.length >= 6 && asciiSlice(payload, 0, 6) === "Exif\0\0") {
      exifOrientation = parseExifOrientation(payload);
    } else if (
      marker === 0xe2 &&
      payload.length >= 14 &&
      asciiSlice(payload, 0, 12) === "ICC_PROFILE\0"
    ) {
      const seqNo = payload[12];
      const total = payload[13];
      if (seqNo >= 1 && total >= 1 && seqNo <= total) {
        iccExpected = total;
        iccChunks.set(seqNo, payload.subarray(14));
      }
    }

    pos += segLen;
  }

  let iccLabel = null;
  if (iccExpected > 0 && iccChunks.size > 0) {
    const parts = [];
    let totalBytes = 0;
    for (let i = 1; i <= iccExpected; i += 1) {
      const part = iccChunks.get(i);
      if (!part) {
        throw new Error(`${name}: incomplete JPEG APP2 ICC_PROFILE segments (${iccChunks.size}/${iccExpected}).`);
      }
      totalBytes += part.length;
      if (totalBytes > MAX_ICC_BYTES) {
        throw new Error(`${name}: embedded JPEG ICC profile exceeds size limit.`);
      }
      parts.push(part);
    }
    const combined = new Uint8Array(totalBytes);
    let offset = 0;
    for (const part of parts) {
      combined.set(part, offset);
      offset += part.length;
    }
    iccLabel = validateIccProfile(combined, "", name);
  }

  return { exifOrientation, iccLabel };
}

function applyExifOrientation(rgba, width, height, orientation) {
  if (orientation <= 1 || orientation > 8) {
    return { width, height, rgba };
  }
  const swaps = orientation >= 5;
  const outWidth = swaps ? height : width;
  const outHeight = swaps ? width : height;
  const out = new Uint8ClampedArray(outWidth * outHeight * 4);

  for (let sy = 0; sy < height; sy += 1) {
    for (let sx = 0; sx < width; sx += 1) {
      let dx;
      let dy;
      switch (orientation) {
        case 2:
          dx = width - 1 - sx;
          dy = sy;
          break;
        case 3:
          dx = width - 1 - sx;
          dy = height - 1 - sy;
          break;
        case 4:
          dx = sx;
          dy = height - 1 - sy;
          break;
        case 5:
          dx = sy;
          dy = sx;
          break;
        case 6:
          dx = height - 1 - sy;
          dy = sx;
          break;
        case 7:
          dx = height - 1 - sy;
          dy = width - 1 - sx;
          break;
        case 8:
          dx = sy;
          dy = width - 1 - sx;
          break;
        default:
          dx = sx;
          dy = sy;
      }
      const src = (sy * width + sx) * 4;
      const dst = (dy * outWidth + dx) * 4;
      out[dst] = rgba[src];
      out[dst + 1] = rgba[src + 1];
      out[dst + 2] = rgba[src + 2];
      out[dst + 3] = rgba[src + 3];
    }
  }
  return { width: outWidth, height: outHeight, rgba: out };
}

/**
 * Decode a PNG or JPEG byte buffer to tightly-backed 8-bit sRGB RGBA pixels without DOM or Canvas.
 * Preflights header dimensions before decompressing so oversized images are rejected cleanly.
 * Verifies PNG chunk CRCs, decodes tRNS/Adam7/sub-byte/16-bit PNGs, applies PNG gAMA -> sRGB when
 * applicable, applies JPEG EXIF orientation (1..8), and rejects embedded non-sRGB ICC profiles.
 */
export function decodeRasterBytes(bytes, { name = "image", maxBytes = MAX_INPUT_BYTES } = {}) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const header = probeRasterImage(view);
  if (!header) throw new Error(`${name} is not a PNG or JPEG image.`);
  if (!header.width || !header.height) throw new Error(`${name} has no pixels.`);
  const decodedBytes = header.width * header.height * 4;
  if (decodedBytes > maxBytes) {
    throw new InputTooLargeError(decodedBytes, maxBytes, { subject: `Decoded image (${name})` });
  }

  if (header.format === "jpeg") {
    const meta = inspectJpegMetadata(view, name);
    const decoded = jpeg.decode(view, {
      useTArray: true,
      formatAsRGBA: true,
      maxMemoryUsageInMB: Math.max(512, Math.ceil((maxBytes * 4) / (1024 * 1024))),
    });
    if (decoded.width !== header.width || decoded.height !== header.height) {
      throw new Error(
        `Decoded JPEG dimensions (${decoded.width}x${decoded.height}) do not match header (${header.width}x${header.height}).`,
      );
    }
    const rawRgba = new Uint8ClampedArray(decoded.width * decoded.height * 4);
    rawRgba.set(decoded.data);
    const oriented = applyExifOrientation(rawRgba, decoded.width, decoded.height, meta.exifOrientation);
    return {
      width: oriented.width,
      height: oriented.height,
      format: "jpeg",
      rgba: oriented.rgba,
      exifOrientation: meta.exifOrientation,
      gammaApplied: null,
      colorSpace: "srgb",
      colorSpaceDescription: meta.iccLabel
        ? `srgb (Node JPEG decode; verified ICC "${meta.iccLabel}")`
        : "srgb (Node JPEG decode; untagged assumed sRGB, non-sRGB ICC rejected)",
    };
  }

  const pngMeta = inspectPngColorChunks(view, name);
  const buffer = Buffer.from(view.buffer, view.byteOffset, view.byteLength);
  const png = PNG.sync.read(buffer, { checkCRC: true, skipRescale: false });
  if (png.width !== header.width || png.height !== header.height) {
    throw new Error(
      `Decoded PNG dimensions (${png.width}x${png.height}) do not match header (${header.width}x${header.height}).`,
    );
  }
  const rgba = new Uint8ClampedArray(png.width * png.height * 4);
  rgba.set(png.data);

  let gammaApplied = null;
  if (!pngMeta.hasSrgb && !pngMeta.iccLabel && pngMeta.gamma !== null && Math.abs(pngMeta.gamma - 1 / 2.2) > 0.01) {
    applyGammaToSrgb(rgba, pngMeta.gamma);
    gammaApplied = pngMeta.gamma;
  }

  const colorSpaceDescription = pngMeta.iccLabel
    ? `srgb (Node PNG decode; verified ICC "${pngMeta.iccLabel}")`
    : gammaApplied !== null
      ? `srgb (Node PNG decode; gAMA ${gammaApplied.toFixed(5)} converted to sRGB)`
      : "srgb (Node PNG decode; non-sRGB ICC rejected)";

  return {
    width: png.width,
    height: png.height,
    format: "png",
    rgba,
    exifOrientation: 1,
    gammaApplied,
    colorSpace: "srgb",
    colorSpaceDescription,
  };
}

/** Read and decode a PNG or JPEG file from disk. */
export async function readRasterImageFile(filePath, { maxBytes = MAX_INPUT_BYTES } = {}) {
  const bytes = await readFile(filePath);
  const name = basename(filePath);
  const decoded = decodeRasterBytes(bytes, { name, maxBytes });
  return {
    ...decoded,
    name,
    size: bytes.byteLength,
  };
}
