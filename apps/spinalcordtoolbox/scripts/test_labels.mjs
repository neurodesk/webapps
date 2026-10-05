#!/usr/bin/env node --no-warnings

// Asserts the label colormap handed to NiiVue 1.0's `setColormapLabel()`.
// NiiVue builds an index-addressed lookup table from it: entry `I[n]` paints
// label value `I[n]` with `R/G/B/A[n]` and names it `labels[n]`. The table is
// sampled nearest-neighbour, so adjacent labels never blend, and it starts at
// the lowest index, so label 0 must be present and transparent.

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const { generateLabelColormap, getLabelName } = await import(pathToFileURL(path.join(ROOT, 'web/js/app/labels.js')));
const { getTaskLabels } = await import(pathToFileURL(path.join(ROOT, 'web/js/app/sct-tasks.js')));

// The table NiiVue 1.0 derives from a label colormap (`makeLabelLut`).
function buildLabelLut(colormap) {
  const min = Math.min(...colormap.I);
  const max = Math.max(...colormap.I);
  const lut = new Uint8ClampedArray((max - min + 1) * 4);
  const labels = Array(max - min + 1).fill('?');
  colormap.I.forEach((index, entry) => {
    const offset = (index - min) * 4;
    lut.set([colormap.R[entry], colormap.G[entry], colormap.B[entry], colormap.A[entry]], offset);
    labels[index - min] = colormap.labels[entry];
  });
  return { lut, labels, min, max };
}

for (const labelSet of ['spinalcord', 'lesion_sci_t2', 'totalspineseg', 'spineDiscs']) {
  const source = getTaskLabels(labelSet);
  const colormap = generateLabelColormap(labelSet);
  const length = colormap.I.length;

  for (const channel of ['R', 'G', 'B', 'A', 'labels']) {
    assert.equal(colormap[channel].length, length, `${labelSet}: ${channel} has one value per label`);
  }
  assert.deepEqual(colormap.I, [...colormap.I].sort((a, b) => a - b), `${labelSet}: labels are in index order`);
  assert.equal(new Set(colormap.I).size, length, `${labelSet}: label indices are unique`);
  assert.ok(colormap.I.every(Number.isInteger), `${labelSet}: I holds raw label values, not a 0..255 ramp`);
  assert.equal(colormap.I[0], 0, `${labelSet}: label 0 anchors the table`);
  assert.equal(colormap.A[0], 0, `${labelSet}: background is transparent`);

  const { lut, labels } = buildLabelLut(colormap);
  for (const label of source) {
    if (label.index === 0) continue;
    const color = label.color || label.rgba;
    assert.deepEqual(
      Array.from(lut.slice(label.index * 4, label.index * 4 + 4)),
      [color[0], color[1], color[2], color[3] ?? 255],
      `${labelSet}: label ${label.index} paints its own colour`
    );
    assert.ok(lut[label.index * 4 + 3] > 0, `${labelSet}: label ${label.index} is visible`);
    assert.equal(labels[label.index], label.name, `${labelSet}: label ${label.index} is named for the viewer legend`);
    assert.equal(getLabelName(label.index, labelSet), label.name);
  }
}

// Regression guard for the binary cord mask: its single label must be painted.
// (The NiiVue 0.68 step LUT once rounded this mask fully transparent.)
{
  const cord = generateLabelColormap('spinalcord');
  assert.deepEqual(cord.I, [0, 1]);
  assert.deepEqual(cord.labels, ['Background', 'Spinal cord']);
  assert.deepEqual([cord.R[1], cord.G[1], cord.B[1], cord.A[1]], [68, 128, 255, 255]);
}

// Each call returns fresh arrays: NiiVue clamps `I` in place.
{
  const first = generateLabelColormap('totalspineseg');
  const second = generateLabelColormap('totalspineseg');
  first.I[1] = 999;
  assert.notEqual(second.I[1], 999);
}

// Multi-label sets keep every label distinct, so neighbours are told apart.
{
  const spine = generateLabelColormap('totalspineseg');
  assert.ok(spine.I.length > 10, 'TotalSpineSeg ships its full label set');
  assert.equal(Math.max(...spine.I), Math.max(...getTaskLabels('totalspineseg').map(label => label.index)), 'the highest label value is preserved');
}

console.log('Label colormap tests passed');
