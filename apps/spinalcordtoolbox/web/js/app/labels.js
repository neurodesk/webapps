import { getTaskLabels } from './sct-tasks.js';

export const LABELS = Object.freeze([
  { index: 0, name: 'Background', color: [0, 0, 0, 0] },
  { index: 1, name: 'Spinal cord', color: [68, 128, 255, 255] },
]);

// NiiVue 1.0 label colormap for `nv.setColormapLabel(volumeIndex, colormap)`:
// one entry per label, `I` holding the raw label value. NiiVue builds an
// index-addressed lookup table from it, samples it nearest-neighbour (so
// neighbouring labels never blend), and reports `labels[value]` in its
// location events and legend. Label 0 is always present and transparent,
// otherwise NiiVue would treat the lowest label as the table origin.
export function generateLabelColormap(taskId = 'spinalcord') {
  const labels = [...getTaskLabels(taskId)].sort((a, b) => a.index - b.index);
  if (!labels.some(label => label.index === 0)) {
    labels.unshift({ index: 0, name: 'Background', color: [0, 0, 0, 0] });
  }
  const R = [];
  const G = [];
  const B = [];
  const A = [];
  const I = [];
  const names = [];
  for (const label of labels) {
    const color = label.color || label.rgba || [128, 128, 128, 255];
    R.push(color[0]);
    G.push(color[1]);
    B.push(color[2]);
    A.push(label.index === 0 ? 0 : color[3] ?? 255);
    I.push(label.index);
    names.push(label.name);
  }
  return { R, G, B, A, I, labels: names };
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
