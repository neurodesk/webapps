// Frame drawing helpers shared by the preview scrubber and the encoder.
//
// A frame is a Uint8ClampedArray of length fH * fW * channels, row-major, with
// channels interleaved. Grayscale has channels === 1, color has channels === 3.

import { labelPlacement } from '../vendor/mri2vid/src/raster.js';

// Draw a frame into a 2D context sized fW x fH.
export function drawFrame(ctx, frame, fW, fH, channels) {
  const img = ctx.createImageData(fW, fH);
  const out = img.data;
  if (channels === 1) {
    for (let p = 0; p < fW * fH; p++) {
      const v = frame[p];
      out[p * 4] = v;
      out[p * 4 + 1] = v;
      out[p * 4 + 2] = v;
      out[p * 4 + 3] = 255;
    }
  } else {
    for (let p = 0; p < fW * fH; p++) {
      out[p * 4] = frame[p * 3];
      out[p * 4 + 1] = frame[p * 3 + 1];
      out[p * 4 + 2] = frame[p * 3 + 2];
      out[p * 4 + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

// The slice label (sliceLabel in the shared raster.js) in the browser's sans-serif.
// Canvas fillText uses the alphabetic baseline, so the placement matches
// cv2.putText's; the command line draws the same label with a bitmap font.
export function drawAnnotation(ctx, label, fH) {
  const { x, baseline, fontPx } = labelPlacement(fH);
  ctx.save();
  ctx.font = `${fontPx}px sans-serif`;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(label, x, baseline);
  ctx.restore();
}
