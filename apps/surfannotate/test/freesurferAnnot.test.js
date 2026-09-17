import test from 'node:test';
import assert from 'node:assert/strict';

import {
  writeFreeSurferAnnot, readFreeSurferAnnot, uniqueAnnotColors, packAnnotation
} from '../src/io/freesurferAnnot.js';
import { parcellationLabels } from '../src/io/parcellationExport.js';

const ENTRIES = [
  { name: 'V1', rgb: [76, 176, 79] },
  { name: 'V2 dorsal', rgb: [33, 150, 243] }
];

test('the annotation is the colour packed r + g<<8 + b<<16, as FreeSurfer reads it', () => {
  assert.equal(packAnnotation([1, 2, 3]), 1 + 2 * 256 + 3 * 65536);
  assert.equal(packAnnotation([0, 0, 0]), 0);
});

test('an .annot round-trips labels, names and colours', () => {
  const labels = Int32Array.from([1, 1, 0, 2, 2, 2, 0]);
  const bytes = writeFreeSurferAnnot(labels, ENTRIES);
  const back = readFreeSurferAnnot(bytes);
  assert.deepEqual(Array.from(back.labels), Array.from(labels));
  assert.deepEqual(back.entries, ENTRIES);
});

test('an .annot is big-endian, starts with the vertex count and pairs each vertex with its colour', () => {
  const bytes = writeFreeSurferAnnot(Int32Array.from([0, 2]), ENTRIES);
  const view = new DataView(bytes.buffer);
  assert.equal(view.getInt32(0), 2, 'vertex count, big-endian');
  assert.equal(view.getInt32(4), 0, 'vertex 0');
  assert.equal(view.getInt32(8), 0, 'unlabelled vertices carry annotation 0');
  assert.equal(view.getInt32(12), 1, 'vertex 1');
  assert.equal(view.getInt32(16), packAnnotation(ENTRIES[1].rgb));
  assert.equal(view.getInt32(20), 1, 'TAG_OLD_COLORTABLE');
  assert.equal(view.getInt32(24), -2, 'colour table version 2');
});

test('names are written null-terminated, as FreeSurfer writes them', () => {
  const bytes = writeFreeSurferAnnot(Int32Array.from([1]), [{ name: 'V1', rgb: [1, 2, 3] }]);
  const text = new TextDecoder('latin1').decode(bytes);
  assert.ok(text.includes('V1\0'));
  assert.ok(text.includes('SurfAnnotate\0'));
});

test('the writer refuses colours that would merge or vanish', () => {
  assert.throws(() => writeFreeSurferAnnot(Int32Array.from([1, 2]), [
    { name: 'a', rgb: [1, 2, 3] }, { name: 'b', rgb: [1, 2, 3] }
  ]), /distinct/);
  assert.throws(() => writeFreeSurferAnnot(Int32Array.from([1]), [
    { name: 'black', rgb: [0, 0, 0] }
  ]), /non-black/);
});

test('colliding palette colours are nudged apart and black is avoided', () => {
  const colors = uniqueAnnotColors([[10, 20, 30], [10, 20, 30], [10, 20, 31], [0, 0, 0]]);
  assert.deepEqual(colors[0], [10, 20, 30]);
  assert.deepEqual(colors[1], [10, 20, 31], 'the later duplicate is the one nudged');
  assert.deepEqual(colors[2], [10, 20, 32], 'and its own value was taken by then');
  assert.deepEqual(colors[3], [0, 0, 1], 'never pure black, which reads as unlabelled');
  assert.equal(new Set(colors.map(packAnnotation)).size, 4);
});

test('the parcellation is stacked in list order and unresolved ROIs are named, not dropped silently', () => {
  const rois = [
    { name: 'V1', colorIndex: 0, mask: Uint8Array.from([1, 1, 0, 0, 0]) },
    { name: 'broken', colorIndex: 1, mask: null },
    { name: 'V2', colorIndex: 0, mask: Uint8Array.from([0, 0, 1, 1, 0]) }
  ];
  const palette = [[1, 0, 0], [0, 1, 0]];
  const { labels, entries, skipped } = parcellationLabels(rois, 5, palette);
  assert.deepEqual(Array.from(labels), [1, 1, 2, 2, 0], 'keys follow the entries, not the list');
  assert.deepEqual(entries.map((e) => e.name), ['V1', 'V2']);
  assert.deepEqual(entries[0].rgb, [255, 0, 0]);
  assert.deepEqual(skipped, ['broken']);
});
