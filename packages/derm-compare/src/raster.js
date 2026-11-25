// Pure Node PNG and JPEG raster image decoder with header preflight and size bounds.
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { InputTooLargeError, MAX_INPUT_BYTES } from "@neurodesk/webapp-components/file-io/input-limits";
import { probeRasterImage } from "@neurodesk/webapp-components/file-io/raster-image";
import { convertIndexedToRgb, decode as decodePng } from "fast-png";
import jpeg from "jpeg-js";

function unpackSubByteSamples(data, width, height, depth) {
  const out = new Uint8Array(width * height);
  const rowBytes = Math.ceil((width * depth) / 8);
  const mask = (1 << depth) - 1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const bit = x * depth;
      out[y * width + x] = (data[y * rowBytes + (bit >> 3)] >> (8 - depth - (bit & 7))) & mask;
    }
  }
  return out;
}

function toByte(sample, depth) {
  return depth === 16 ? sample >> 8 : sample;
}

/**
 * Decode a PNG or JPEG byte buffer to tightly-backed 8-bit RGBA pixels without DOM or Canvas.
 * Preflights header dimensions before decompressing so oversized images are rejected cleanly.
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
    const rgba = new Uint8ClampedArray(decoded.width * decoded.height * 4);
    rgba.set(decoded.data);
    return { width: decoded.width, height: decoded.height, format: "jpeg", rgba };
  }

  const png = decodePng(view);
  if (png.width !== header.width || png.height !== header.height) {
    throw new Error(
      `Decoded PNG dimensions (${png.width}x${png.height}) do not match header (${header.width}x${header.height}).`,
    );
  }
  const pixelCount = png.width * png.height;
  const rgba = new Uint8ClampedArray(pixelCount * 4);

  if (png.palette) {
    const rgb = convertIndexedToRgb(png);
    const trns = png.transparency;
    const indices = trns && png.depth < 8
      ? unpackSubByteSamples(png.data, png.width, png.height, png.depth)
      : png.data;
    for (let i = 0; i < pixelCount; i += 1) {
      const p = i * 4;
      const rIdx = i * 3;
      rgba[p] = rgb[rIdx];
      rgba[p + 1] = rgb[rIdx + 1];
      rgba[p + 2] = rgb[rIdx + 2];
      rgba[p + 3] = trns && indices[i] < trns.length ? trns[indices[i]] : 255;
    }
    return { width: png.width, height: png.height, format: "png", rgba };
  }

  const { channels, depth } = png;
  let src = png.data;
  let srcDepth = depth;
  if (channels === 1 && depth < 8) {
    const unpacked = unpackSubByteSamples(png.data, png.width, png.height, depth);
    const scale = 255 / ((1 << depth) - 1);
    for (let i = 0; i < unpacked.length; i += 1) {
      unpacked[i] = Math.round(unpacked[i] * scale);
    }
    src = unpacked;
    srcDepth = 8;
  }

  if (channels === 4) {
    if (srcDepth === 8) {
      rgba.set(src);
    } else {
      for (let i = 0; i < pixelCount * 4; i += 1) rgba[i] = toByte(src[i], srcDepth);
    }
  } else if (channels === 3) {
    for (let i = 0, s = 0, d = 0; i < pixelCount; i += 1, s += 3, d += 4) {
      rgba[d] = toByte(src[s], srcDepth);
      rgba[d + 1] = toByte(src[s + 1], srcDepth);
      rgba[d + 2] = toByte(src[s + 2], srcDepth);
      rgba[d + 3] = 255;
    }
  } else if (channels === 2) {
    for (let i = 0, s = 0, d = 0; i < pixelCount; i += 1, s += 2, d += 4) {
      const v = toByte(src[s], srcDepth);
      rgba[d] = v;
      rgba[d + 1] = v;
      rgba[d + 2] = v;
      rgba[d + 3] = toByte(src[s + 1], srcDepth);
    }
  } else if (channels === 1) {
    for (let i = 0, d = 0; i < pixelCount; i += 1, d += 4) {
      const v = toByte(src[i], srcDepth);
      rgba[d] = v;
      rgba[d + 1] = v;
      rgba[d + 2] = v;
      rgba[d + 3] = 255;
    }
  } else {
    throw new Error(`${name}: unsupported PNG channel count (${channels}).`);
  }

  return { width: png.width, height: png.height, format: "png", rgba };
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
