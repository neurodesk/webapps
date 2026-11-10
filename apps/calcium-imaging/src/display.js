// NIfTI images for the viewer and the ROI label colour table. Downloads are TIFF; these files
// only feed NiiVue. NIfTI spacing is millimetres, so micrometre pixel sizes are divided by 1000;
// a movie without a pixel size is shown with 1 mm pixels. Row 0 of the image is drawn at the top.
import { createNiftiFromData, createNiftiHeaderFromVolume } from '@neurodesk/webapp-components/file-io';

/** The NIfTI pixel spacing (mm) for a pixel size in micrometres. */
export function displaySpacing(pixelSize) {
  const x = pixelSize?.x;
  const y = pixelSize?.y ?? x;
  return x && y ? [x / 1000, y / 1000] : [1, 1];
}

/** The 1st and 99.5th percentiles of up to 100 000 evenly strided samples: a display window. */
export function displayWindow(data) {
  const step = Math.max(1, Math.floor(data.length / 100000));
  const sample = [];
  for (let i = 0; i < data.length; i += step) if (Number.isFinite(data[i])) sample.push(data[i]);
  sample.sort((a, b) => a - b);
  if (!sample.length) return [0, 1];
  const low = sample[Math.floor(0.01 * (sample.length - 1))];
  const high = sample[Math.floor(0.995 * (sample.length - 1))];
  return high > low ? [low, high] : [sample[0], sample[sample.length - 1] > sample[0] ? sample[sample.length - 1] : sample[0] + 1];
}

/** A 2D image (frames = 1) or a movie (frames > 1) as a NIfTI File for NiiVue. */
export function displayNifti(name, data, { width, height, frames = 1, spacing = [1, 1], frameInterval = 1, window = displayWindow(data) }) {
  const [sx, sy] = spacing;
  const affine = [
    [sx, 0, 0, 0],
    [0, -sy, 0, (height - 1) * sy],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  ];
  const dims = [frames > 1 ? 4 : 3, width, height, 1, frames, 1, 1, 1];
  const pixDims = [1, sx, sy, 1, frames > 1 ? frameInterval : 1, 1, 1, 1];
  const header = createNiftiHeaderFromVolume({ hdr: { dims, pixDims, affine } });
  const buffer = createNiftiFromData(data, header, { dims: [width, height, 1, frames], preserveScaling: true, calMin: window[0], calMax: window[1], clampCalMax: false });
  return new File([buffer], name, { type: 'application/octet-stream' });
}

/** A label colour table for ROI ids 1…n: hues spaced by the golden angle, 0 transparent. */
export function roiColormap(count) {
  const R = [0];
  const G = [0];
  const B = [0];
  const A = [0];
  const I = [0];
  const labels = ['background'];
  for (let id = 1; id <= count; id++) {
    const hue = (id * 137.508) % 360;
    const [r, g, b] = hsvToRgb(hue, 0.75, 1);
    R.push(r);
    G.push(g);
    B.push(b);
    A.push(255);
    I.push(id);
    labels.push(`ROI ${id}`);
  }
  return { R, G, B, A, I, labels };
}

function hsvToRgb(hue, saturation, value) {
  const c = value * saturation;
  const h = hue / 60;
  const x = c * (1 - Math.abs((h % 2) - 1));
  const [r, g, b] = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
  const m = value - c;
  return [r, g, b].map((channel) => Math.round((channel + m) * 255));
}
