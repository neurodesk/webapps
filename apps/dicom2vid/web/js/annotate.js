// Frame drawing helpers shared by the preview scrubber and the encoder.
//
// A frame is a Uint8ClampedArray of length fH * fW * channels, row-major, with
// channels interleaved. Grayscale has channels === 1, color has channels === 3.

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

// The reference label: "Slice {origIndex+1}/{total}", bottom-left, white.
// cv2.putText baseline sits at (10, height - 10). Canvas fillText uses the
// alphabetic baseline, so the placement matches; the font is not pixel-identical
// to OpenCV's Hershey font, which is acceptable (annotation is not a parity gate).
export function sliceLabel(origIndex, total) {
  return `Slice ${origIndex + 1}/${total}`;
}

export function drawAnnotation(ctx, label, fH) {
  const fontPx = Math.max(9, Math.min(16, Math.round(fH * 0.06)));
  ctx.save();
  ctx.font = `${fontPx}px sans-serif`;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(label, 10, fH - 10);
  ctx.restore();
}
