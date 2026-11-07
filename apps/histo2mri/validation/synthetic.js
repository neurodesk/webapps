// The synthetic experiment: an MRI slice deformed by a known affine and smooth warp and
// re-coloured as an H&E brightfield section, registered back, scored by landmark error.
//
// The section's pixel p shows the MRI at local point W(R p + t), where W(y) = y + v(y) is a
// smooth displacement (mm) and R p + t a similarity with anisotropic shrinkage (the section's
// pixel to local mm). A landmark x on the MRI plane therefore lies at the section pixel p with
// W(R p + t) = x, found by fixed-point iteration. The registration's estimate is
// register.js `sectionPixelAt`; the error is |estimate − p| in section pixels, reported in mm
// and in MRI voxels.
import { apply } from '../src/core/matrix.js';
import { bilinear } from '../src/core/image2d.js';
import { sectionPixelAt } from '../src/core/register.js';

const RGB_FROM_HED = [[0.65, 0.7, 0.29], [0.07, 0.99, 0.11], [0.27, 0.57, 0.78]];

/** The known section → plane mapping of the experiment (all lengths in mm). */
export function syntheticTransform({ spacing, nu, nv }) {
  const pixel = spacing / 3;
  const angle = (14 * Math.PI) / 180;
  const sx = pixel * 1.06;
  const sy = pixel * 0.95;
  const rotation = [[Math.cos(angle) * sx, -Math.sin(angle) * sy], [Math.sin(angle) * sx, Math.cos(angle) * sy]];
  const width = Math.round(nu * 3.3);
  const height = Math.round(nv * 3.3);
  // Centre the section on the plane's centre, offset by a few millimetres.
  const centre = [((nu - 1) / 2) * spacing + 2.1, ((nv - 1) / 2) * spacing - 1.4];
  const translation = [
    centre[0] - (rotation[0][0] * (width - 1) / 2 + rotation[0][1] * (height - 1) / 2),
    centre[1] - (rotation[1][0] * (width - 1) / 2 + rotation[1][1] * (height - 1) / 2),
  ];
  const extent = [nu * spacing, nv * spacing];
  const warp = ([x, y]) => [
    1.2 * Math.sin((2 * Math.PI * y) / extent[1]) * Math.sin((Math.PI * x) / extent[0]),
    0.9 * Math.sin((2 * Math.PI * x) / extent[0]) * Math.cos((Math.PI * y) / extent[1]),
  ];
  const toLocal = ([px, py]) => {
    const y = [rotation[0][0] * px + rotation[0][1] * py + translation[0], rotation[1][0] * px + rotation[1][1] * py + translation[1]];
    const v = warp(y);
    return [y[0] + v[0], y[1] + v[1]];
  };
  const toPixel = ([x, y]) => {
    // Solve y + v(y) = x, then invert the similarity.
    let guess = [x, y];
    for (let iteration = 0; iteration < 50; iteration++) {
      const v = warp(guess);
      guess = [x - v[0], y - v[1]];
    }
    const det = rotation[0][0] * rotation[1][1] - rotation[0][1] * rotation[1][0];
    const dx = guess[0] - translation[0];
    const dy = guess[1] - translation[1];
    return [(rotation[1][1] * dx - rotation[0][1] * dy) / det, (-rotation[1][0] * dx + rotation[0][0] * dy) / det];
  };
  return { width, height, pixel, toLocal, toPixel };
}

/**
 * The H&E section: the plane image's normalised intensity t drives haematoxylin (strong where
 * the MRI is dark, as nuclei-rich grey matter in a T1-like contrast) and eosin, through
 * Beer–Lambert; outside tissue the slide is white. 8-bit interleaved RGB with mild noise.
 */
export function syntheticSection(image, plane, transform, seed = 1) {
  const { width, height, toLocal } = transform;
  let maximum = 0;
  for (const value of image) maximum = Math.max(maximum, value);
  let state = seed;
  const noise = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32 - 0.5;
  };
  const data = new Uint8Array(width * height * 3);
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const [x, y] = toLocal([px, py]);
      const t = bilinear(image, plane.nu, plane.nv, x / plane.spacing, y / plane.spacing) / maximum;
      const tissue = t > 0.08;
      const h = tissue ? 0.25 + 0.9 * (1 - t) : 0;
      const e = tissue ? 0.35 + 0.25 * t : 0;
      for (let c = 0; c < 3; c++) {
        const od = h * RGB_FROM_HED[0][c] + e * RGB_FROM_HED[1][c];
        data[(py * width + px) * 3 + c] = Math.max(0, Math.min(255, Math.round(255 * 10 ** -od + 4 * noise())));
      }
    }
  }
  return { width, height, channels: 3, data, maxValue: 255, pixelSize: null };
}

/** Landmarks on the plane: a grid of local points inside the MRI's tissue. */
export function syntheticLandmarks(plane, image, stride = 8) {
  let maximum = 0;
  for (const value of image) maximum = Math.max(maximum, value);
  const points = [];
  for (let j = stride; j < plane.nv - stride; j += stride) {
    for (let i = stride; i < plane.nu - stride; i += stride) {
      if (image[j * plane.nu + i] > 0.3 * maximum) points.push([i * plane.spacing, j * plane.spacing]);
    }
  }
  return points;
}

/** Landmark errors of a registration result against the known transform. */
export function landmarkErrors(result, transform, landmarks) {
  return landmarks.map(([x, y]) => {
    const truth = transform.toPixel([x, y]);
    const estimate = sectionPixelAt(result, apply(result.plane.frame, [x, y, 0]));
    const mm = Math.hypot(estimate.x - truth[0], estimate.y - truth[1]) * transform.pixel;
    return { mm, voxels: mm / result.plane.spacing };
  });
}

/** Mean, median and maximum landmark error in MRI voxels and in mm. */
export function summarise(errors) {
  const stats = (key) => {
    const values = errors.map((error) => error[key]).sort((a, b) => a - b);
    return { mean: values.reduce((sum, value) => sum + value, 0) / values.length, median: values[values.length >> 1], max: values[values.length - 1] };
  };
  const voxels = stats('voxels');
  const mm = stats('mm');
  return { landmarks: errors.length, meanVoxels: voxels.mean, medianVoxels: voxels.median, maxVoxels: voxels.max, meanMm: mm.mean, medianMm: mm.median, maxMm: mm.max };
}
