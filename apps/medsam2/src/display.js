// 2D slice rendering helpers for MedSAM2's interactive prompt view. DOM-free.

export function labelColour(id) {
  const hue = ((id * 137.508) % 360) / 60;
  const lightness = 0.55;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * 0.9;
  const x = chroma * (1 - Math.abs((hue % 2) - 1));
  const [r, g, b] = [[chroma, x, 0], [x, chroma, 0], [0, chroma, x], [0, x, chroma], [x, 0, chroma], [chroma, 0, x]][Math.floor(hue) % 6];
  const m = lightness - chroma / 2;
  return [r, g, b].map((value) => Math.round((value + m) * 255));
}

export function greyRgba(sliceUint8) {
  const out = new Uint8ClampedArray(sliceUint8.length * 4);
  for (let i = 0; i < sliceUint8.length; i++) {
    const v = sliceUint8[i];
    out[i * 4] = v;
    out[i * 4 + 1] = v;
    out[i * 4 + 2] = v;
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

export function overlayRgba({ labels, width, height, opacity, outlines = false, preview = null, previewId = 1 }) {
  const out = new Uint8ClampedArray(width * height * 4);
  const alpha = Math.round(opacity * 255);
  const colours = new Map();
  const colour = (id) => {
    if (!colours.has(id)) colours.set(id, labelColour(id));
    return colours.get(id);
  };
  for (let i = 0; i < labels.length; i++) {
    const id = labels[i];
    if (!id || (outlines && !isEdge(labels, width, height, i))) continue;
    const [r, g, b] = colour(id);
    out.set([r, g, b, outlines ? 255 : alpha], i * 4);
  }
  if (preview) {
    const [r, g, b] = colour(previewId);
    const previewAlpha = Math.max(alpha, 128);
    for (let i = 0; i < preview.length; i++) {
      if (preview[i] && !labels[i]) out.set([r, g, b, previewAlpha], i * 4);
    }
  }
  return out;
}
