import { getTaskLabels } from './sct-tasks.js';

export const LABELS = Object.freeze([
  { index: 0, name: 'Background', color: [0, 0, 0, 0] },
  { index: 1, name: 'Spinal cord', color: [68, 128, 255, 255] },
]);

// NiiVue interpolates linearly between adjacent LUT stops. For discrete label
// maps this smears one vertebra into its neighbour at sub-voxel boundaries. We
// emit a step LUT: each label gets a stop at its integer index and another at
// just-below the next index, holding the color flat across (i, i+1).
//
// IMPORTANT: NiiVue's `makeLut()` casts our `I` array through
// `Uint8ClampedArray.from(...)` (round-half-to-even). For a binary mask
// (spinalcord: 2 labels → max=1) the held stop sits at scaleToLutIndex(1)
// minus this epsilon, i.e. 255-EPSILON. With EPSILON < 0.5 that rounds back
// to 255, collapsing the held stop and the label-1 stop onto the same
// Uint8 index. The first LUT segment (idxLo=0..idxHi=255) then interpolates
// background→background and the trailing zero-range segment produces NaNs
// (divide-by-zero) that Uint8ClampedArray clamps to 0 — the entire LUT
// becomes transparent and the segmentation overlay disappears even though
// the volume is loaded. EPSILON >= 1.0 keeps the held stop at a different
// Uint8 bucket from the next label start. `npm run test:labels` enforces
// the gap; the spinalcord-LUT regression case in `test_labels.mjs` confirms
// the binary case stays visible.
const STEP_EPSILON = 1.0;

export function generateNiivueColormap(taskId = 'spinalcord') {
  const labels = [...getTaskLabels(taskId)].sort((a, b) => a.index - b.index);
  const maxLabelIndex = Math.max(1, ...labels.map(label => label.index));
  const scaleToLutIndex = index => (index / maxLabelIndex) * 255;
  const R = [];
  const G = [];
  const B = [];
  const A = [];
  const I = [];
  const labelNames = [];

  for (let i = 0; i < labels.length; i++) {
    const label = labels[i];
    const color = label.color || label.rgba || [128, 128, 128, 255];
    R.push(color[0]);
    G.push(color[1]);
    B.push(color[2]);
    A.push(color[3]);
    I.push(scaleToLutIndex(label.index));
    labelNames.push(label.name);

    const next = labels[i + 1];
    if (next && next.index > label.index + 1) continue;
    if (next) {
      R.push(color[0]);
      G.push(color[1]);
      B.push(color[2]);
      A.push(color[3]);
      I.push(scaleToLutIndex(next.index) - STEP_EPSILON);
      labelNames.push('');
    }
  }

  return {
    R,
    G,
    B,
    A,
    I,
    labels: labelNames,
    min: 0,
    max: Math.max(1, ...labels.map(label => label.index))
  };
}

/**
 * Get label name by index.
 */
export function getLabelName(index, taskId = 'spinalcord') {
  const labels = getTaskLabels(taskId);
  return labels.find(label => label.index === index)?.name || `Label ${index}`;
}

/**
 * Get label color as [R, G, B, A] (0-255).
 */
export function getLabelColor(index, taskId = 'spinalcord') {
  const label = getTaskLabels(taskId).find(item => item.index === index);
  return label?.color || label?.rgba || [128, 128, 128, 255];
}
