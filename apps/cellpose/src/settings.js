// Run settings, output names and label colormap for Cellpose: pure, for the page and Node tests.

function bounded(value, fallback, min, max, name) {
  if (value === undefined || value === null || Number.isNaN(value)) return fallback;
  if (typeof value !== "number" || value < min || value > max) throw new Error(`${name} must be between ${min} and ${max}.`);
  return value;
}

/** Validated settings for one Cellpose run; omitted values take the chosen model's defaults. */
export function segmentationSettings(parameters, model) {
  const channel = bounded(parameters.channel, 1, 1, 256, "The primary channel");
  const nuclearChannel = bounded(parameters.nuclearChannel, 0, 0, 256, "The nuclear channel");
  const diameter = bounded(parameters.diameter, model.diamMean, 5, 500, "The cell diameter");
  const flowThresh = bounded(parameters.flowThresh, model.defaults.flowThresh, 0, 3, "The flow error threshold");
  const cellprobThresh = bounded(parameters.cellprobThresh, model.defaults.cellprobThresh, -6, 6, "The cell probability threshold");
  const minSize = bounded(parameters.minSize, model.defaults.minSize, 1, 100000, "The minimum cell size");
  const anisotropy = bounded(parameters.anisotropy, 1, 0.1, 20, "The Z anisotropy");
  if (!Number.isInteger(channel)) throw new Error("The primary channel must be a whole number.");
  if (!Number.isInteger(nuclearChannel)) throw new Error("The nuclear channel must be a whole number.");
  if (!Number.isInteger(minSize)) throw new Error("The minimum cell size must be a whole number.");
  return {
    model: model.name,
    channel,
    nuclearChannel: model.supportsNuclearChannel ? nuclearChannel : 0,
    diameter,
    flowThresh,
    cellprobThresh,
    minSize,
    do3D: Boolean(parameters.do3D),
    anisotropy,
  };
}

/** `<input name>_cellpose_<suffix>`, keeping only filesystem-safe characters. */
export function outputName(base, suffix) {
  const safe = base.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "image";
  return `${safe}_cellpose_${suffix}`;
}

/** NiiVue label colormap for labels 1…count with golden-angle hues; 0 is transparent. */
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
