// Run settings, output names and the label colours: pure, for the page and the Node tests.

function bounded(value, fallback, min, max, name) {
  if (value === undefined || value === null || Number.isNaN(value)) return fallback;
  if (typeof value !== "number" || value < min || value > max) throw new Error(`${name} must be between ${min} and ${max}.`);
  return value;
}

/** The validated settings of one run; missing values take the model's defaults. */
export function segmentationSettings(parameters, model) {
  const channel = bounded(parameters.channel, 1, 1, 256, "The channel");
  const tiles = bounded(parameters.tiles, 0, 0, 16, "Tiles per axis");
  if (!Number.isInteger(channel)) throw new Error("The channel must be a whole number.");
  if (!Number.isInteger(tiles)) throw new Error("Tiles per axis must be a whole number.");
  return {
    channel,
    probThresh: bounded(parameters.probThresh, model.thresholds.prob, 0.01, 0.99, "The probability threshold"),
    nmsThresh: bounded(parameters.nmsThresh, model.thresholds.nms, 0.01, 0.99, "The overlap threshold"),
    tiles,
  };
}

/** `<input name>_stardist_<suffix>`, keeping only characters safe in every file system. */
export function outputName(base, suffix) {
  const safe = base.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "image";
  return `${safe}_stardist_${suffix}`;
}

/**
 * A NiiVue label colormap for labels 1…count: well-separated hues (golden-angle steps) at full
 * opacity; label 0 is transparent.
 */
export function labelColormap(count) {
  const R = [0];
  const G = [0];
  const B = [0];
  const A = [0];
  const I = [0];
  for (let label = 1; label <= count; label++) {
    const hue = (label * 137.508) % 360;
    const [r, g, b] = hslToRgb(hue, 0.75, 0.55);
    R.push(r);
    G.push(g);
    B.push(b);
    A.push(255);
    I.push(label);
  }
  return { R, G, B, A, I };
}

function hslToRgb(hue, saturation, lightness) {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = lightness - chroma / 2;
  const [r, g, b] = hue < 60 ? [chroma, x, 0] : hue < 120 ? [x, chroma, 0] : hue < 180 ? [0, chroma, x] : hue < 240 ? [0, x, chroma] : hue < 300 ? [x, 0, chroma] : [chroma, 0, x];
  return [r, g, b].map((value) => Math.round(255 * (value + m)));
}
