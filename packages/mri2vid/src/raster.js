// Frames as the encoder sees them, without a canvas: the frame on a black codec-sized
// picture, the slice label in a bitmap font, and the conversion to I420.
//
// A frame is a Uint8ClampedArray of length fH * fW * channels, row-major, with channels
// interleaved (1 for grayscale, 3 for RGB), as pipeline.js returns it.

import { FIRST_CODE_POINT, GLYPHS } from './font8x8.js';

// The reference label: "Slice {origIndex+1}/{total}", bottom-left, white.
export function sliceLabel(origIndex, total) {
  return `Slice ${origIndex + 1}/${total}`;
}

// Where the label goes in a frame fH pixels high. cv2.putText's baseline sits at
// (10, height - 10); the font size grows with the frame and is clamped to 9-16 px.
export function labelPlacement(fH) {
  return { x: 10, baseline: fH - 10, fontPx: Math.max(9, Math.min(16, Math.round(fH * 0.06))) };
}

// The frame at the top left of a width x height RGB picture. The codec pads odd sizes by
// one pixel; the browser leaves that pixel cleared, which encodes as black.
export function rasterize(frame, fW, fH, channels, width, height) {
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < fH; y++) {
    for (let x = 0; x < fW; x++) {
      const s = (y * fW + x) * channels;
      const d = (y * width + x) * 3;
      if (channels === 1) {
        rgb[d] = frame[s];
        rgb[d + 1] = frame[s];
        rgb[d + 2] = frame[s];
      } else {
        rgb[d] = frame[s];
        rgb[d + 1] = frame[s + 1];
        rgb[d + 2] = frame[s + 2];
      }
    }
  }
  return rgb;
}

// Draws the label in white with font8x8, scaled by whole pixels so its capitals are about
// as tall as the browser's sans-serif at the same font size (cap height ~0.72 em).
export function drawLabel(rgb, width, height, label, fH) {
  const { x, baseline, fontPx } = labelPlacement(fH);
  const scale = Math.max(1, Math.round((fontPx * 0.72) / 7));
  const top = baseline - 7 * scale;
  for (let n = 0; n < label.length; n++) {
    const glyph = GLYPHS[label.charCodeAt(n) - FIRST_CODE_POINT] ?? GLYPHS[0];
    const left = x + n * 8 * scale;
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        if (!((glyph[row] >> col) & 1)) continue;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            const px = left + col * scale + dx;
            const py = top + row * scale + dy;
            if (px < 0 || py < 0 || px >= width || py >= height) continue;
            rgb.fill(255, (py * width + px) * 3, (py * width + px) * 3 + 3);
          }
        }
      }
    }
  }
}

const clampByte = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

// Full-range BT.709 I420 (Y plane, then U and V at half resolution), the conversion
// Chromium applies to canvas frames for VP9. Chroma averages each 2 x 2 block.
export function rgbToI420(rgb, width, height) {
  const cw = width >> 1;
  const ch = height >> 1;
  const out = new Uint8Array(width * height + 2 * cw * ch);
  for (let i = 0, p = 0; i < width * height; i++, p += 3) {
    out[i] = clampByte(0.2126 * rgb[p] + 0.7152 * rgb[p + 1] + 0.0722 * rgb[p + 2]);
  }
  const u0 = width * height;
  const v0 = u0 + cw * ch;
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const p = ((2 * y + dy) * width + 2 * x + dx) * 3;
        r += rgb[p];
        g += rgb[p + 1];
        b += rgb[p + 2];
      }
      r /= 4;
      g /= 4;
      b /= 4;
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      out[u0 + y * cw + x] = clampByte((b - luma) / 1.8556 + 128);
      out[v0 + y * cw + x] = clampByte((r - luma) / 1.5748 + 128);
    }
  }
  return out;
}
