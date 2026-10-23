import { defaultNorm, orientationGeometry, renderFrame, resolveSliceIndices } from '../src/pipeline.js';
import { labelPlacement, rasterize, rgbToI420 } from '../src/raster.js';
import { evenDim } from '../src/video.js';

const LABEL_INK = 64;

export function psnr(a, b, include = () => true) {
  if (a.length !== b.length) throw new Error("Reference frame dimensions differ");
  let sum = 0;
  let count = 0;
  for (let i = 0; i < a.length; i++) {
    if (!include(i)) continue;
    sum += (a[i] - b[i]) ** 2;
    count++;
  }
  return sum ? 10 * Math.log10((255 * 255 * count) / sum) : Infinity;
}

// The luma planes the shared pipeline renders for a case, unlabelled.
export function renderedLuma(vol, settings) {
  const geo = orientationGeometry(vol.dims, settings.orientation);
  const norm = defaultNorm(vol, settings);
  return resolveSliceIndices(geo.nFrames, settings).map((k) => {
    const { frame, fW, fH, channels } = renderFrame(vol, settings.orientation, k, norm, settings);
    const width = evenDim(fW);
    const height = evenDim(fH);
    return { fH, width, y: rgbToI420(rasterize(frame, fW, fH, channels, width, height), width, height).subarray(0, width * height) };
  });
}

// The label's box: from the left margin across, from two font sizes above the baseline to
// a few pixels below it.
export function labelBox(fH, width) {
  const { x, baseline, fontPx } = labelPlacement(fH);
  const top = baseline - 2 * fontPx;
  const bottom = baseline + 4;
  return (i) => {
    const px = i % width;
    const py = Math.floor(i / width);
    return px >= x - 2 && py >= top && py <= bottom;
  };
}

export function labelPixels(decoded, source, inBox) {
  let count = 0;
  for (let i = 0; i < decoded.length; i++) if (inBox(i) && decoded[i] >= source[i] + LABEL_INK) count++;
  return count;
}

