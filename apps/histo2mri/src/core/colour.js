// From a colour section to one contrast image for registration, with background near zero.
//
// Colour deconvolution follows Ruifrok & Johnston (2001): optical density is linear in stain
// amount, so OD = C · M for the stains' OD vectors M, and C = OD · M⁻¹. The vectors are the
// paper's haematoxylin, eosin and DAB vectors as published (to two decimals, so not exactly unit
// length), and the OD scaling is scikit-image's rgb2hed, which test/colour.test.js reproduces.

const RGB_FROM_HED = [
  [0.65, 0.7, 0.29],
  [0.07, 0.99, 0.11],
  [0.27, 0.57, 0.78],
];

function inverse3(m) {
  const [[a, b, c], [d, e, f], [g, h, k]] = m;
  const det = a * (e * k - f * h) - b * (d * k - f * g) + c * (d * h - e * g);
  return [
    [(e * k - f * h) / det, (c * h - b * k) / det, (b * f - c * e) / det],
    [(f * g - d * k) / det, (a * k - c * g) / det, (c * d - a * f) / det],
    [(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det],
  ];
}

/** The stain-from-OD matrix: row r of OD · this is stain r's concentration. */
export const HED_FROM_RGB = inverse3(RGB_FROM_HED);

export const CONTRASTS = Object.freeze({
  auto: 'Brightness (background removed)',
  haematoxylin: 'Haematoxylin (colour deconvolution)',
  eosin: 'Eosin (colour deconvolution)',
  dab: 'DAB (colour deconvolution)',
});

const STAIN_INDEX = { haematoxylin: 0, eosin: 1, dab: 2 };
const LOG_ADJUST = Math.log(1e-6);

/** scikit-image rgb2hed for one pixel of [0, 1] RGB values. */
export function rgbToHed(r, g, b) {
  const od = [r, g, b].map((value) => Math.log(Math.max(value, 1e-6)) / LOG_ADJUST);
  return [0, 1, 2].map((s) => Math.max(0, od[0] * HED_FROM_RGB[0][s] + od[1] * HED_FROM_RGB[1][s] + od[2] * HED_FROM_RGB[2][s]));
}

function mean(values) {
  let sum = 0;
  for (const value of values) sum += value;
  return values.length ? sum / values.length : 0;
}

/** The median of an array's values (a copy is sorted). */
function median(values) {
  const sorted = Float32Array.from(values).sort();
  return sorted.length ? sorted[sorted.length >> 1] : 0;
}

/** Brightness of the image's outer frame (2 % of each side), to tell brightfield from dark-field. */
export function borderBrightness(grey, width, height) {
  const band = Math.max(1, Math.round(0.02 * Math.min(width, height)));
  const values = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x < band || y < band || x >= width - band || y >= height - band) values.push(grey[y * width + x]);
    }
  }
  return median(values);
}

/**
 * One contrast image from an RGB (or grey) image of [0, 1] values, channel-planar
 * (`planes[c][pixel]`). `auto` is luminance (Rec. 709, as rgb2gray), inverted when the image's
 * border is brighter than its mean, so background is dark in brightfield and dark-field
 * scans alike. The deconvolution contrasts are stain concentrations (0 for no stain).
 * @returns {{ data: Float32Array, inverted: boolean }}
 */
export function toContrast(planes, width, height, method = 'auto') {
  const n = width * height;
  const data = new Float32Array(n);
  if (method === 'auto') {
    if (planes.length === 1) data.set(planes[0]);
    else for (let i = 0; i < n; i++) data[i] = 0.2125 * planes[0][i] + 0.7154 * planes[1][i] + 0.0721 * planes[2][i];
    const inverted = borderBrightness(data, width, height) > mean(data);
    if (inverted) for (let i = 0; i < n; i++) data[i] = 1 - data[i];
    return { data, inverted };
  }
  const stain = STAIN_INDEX[method];
  if (stain === undefined) throw new Error(`Unknown contrast ${method}.`);
  if (planes.length !== 3) throw new Error('Colour deconvolution needs an RGB image.');
  const column = [HED_FROM_RGB[0][stain], HED_FROM_RGB[1][stain], HED_FROM_RGB[2][stain]];
  for (let i = 0; i < n; i++) {
    let value = 0;
    for (let c = 0; c < 3; c++) value += (Math.log(Math.max(planes[c][i], 1e-6)) / LOG_ADJUST) * column[c];
    data[i] = Math.max(0, value);
  }
  return { data, inverted: false };
}
