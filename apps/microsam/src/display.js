// Pixels for the 2D viewer: the image micro-sam sees and the label overlay. DOM-free.

/** A distinct colour per object id: golden-angle hues at full saturation, as RGB bytes. */
export function labelColour(id) {
  const hue = ((id * 137.508) % 360) / 60;
  const lightness = 0.55;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * 0.9;
  const x = chroma * (1 - Math.abs((hue % 2) - 1));
  const [r, g, b] = [[chroma, x, 0], [x, chroma, 0], [0, chroma, x], [0, x, chroma], [x, 0, chroma], [chroma, 0, x]][Math.floor(hue) % 6];
  const m = lightness - chroma / 2;
  return [r, g, b].map((value) => Math.round((value + m) * 255));
}

/** The model's three 8-bit channels as opaque RGBA pixels. */
export function baseRgba([red, green, blue], width, height) {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    out[i * 4] = red[i];
    out[i * 4 + 1] = green[i];
    out[i * 4 + 2] = blue[i];
    out[i * 4 + 3] = 255;
  }
  return out;
}

function isEdge(labels, width, height, i) {
  const value = labels[i];
  const x = i % width;
  const y = (i - x) / width;
  return x === 0 || y === 0 || x === width - 1 || y === height - 1
    || labels[i - 1] !== value || labels[i + 1] !== value || labels[i - width] !== value || labels[i + width] !== value;
}

/**
 * The overlay: accepted objects filled or outlined, and the pending mask in the colour its object
 * will get, always filled so it reads as the object being prompted. `opacity` is 0..1.
 */
export function overlayRgba({ labels, width, height, mode, opacity, preview = null, previewId = 0 }) {
  const out = new Uint8ClampedArray(width * height * 4);
  if (mode === "image") return out;
  const alpha = Math.round(opacity * 255);
  const colours = new Map();
  const colour = (id) => {
    if (!colours.has(id)) colours.set(id, labelColour(id));
    return colours.get(id);
  };
  for (let i = 0; i < labels.length; i++) {
    const id = labels[i];
    if (!id || (mode === "outlines" && !isEdge(labels, width, height, i))) continue;
    const [r, g, b] = colour(id);
    out.set([r, g, b, mode === "outlines" ? 255 : alpha], i * 4);
  }
  if (preview) {
    const [r, g, b] = colour(previewId);
    const previewAlpha = Math.max(alpha, 128);
    for (let i = 0; i < preview.length; i++) if (preview[i] && !labels[i]) out.set([r, g, b, previewAlpha], i * 4);
  }
  return out;
}
