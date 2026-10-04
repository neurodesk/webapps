import assert from 'node:assert/strict';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { JSDOM } from 'jsdom';
import { createFloat32Nifti, createNiftiHeaderFromVolume, parseNiftiHeader } from '../src/file-io/NiftiUtils.js';
import { createMaskEditor } from '../src/elements/mask-editor.js';
import { createResultList } from '../src/elements/result-list.js';

function maskFile(values, name = 'mask.nii.gz') {
  const data = new Float32Array(24);
  data.set(values);
  const header = createNiftiHeaderFromVolume({ hdr: { dims: [3, 4, 3, 2, 1, 1, 1, 1] } });
  return new File([createFloat32Nifti(data, header)], name);
}

function fakeNv() {
  return {
    calls: [],
    drawIsEnabled: false,
    drawPenValue: 1,
    drawPenFilled: false,
    drawPenSize: 1,
    volumes: [{ opacity: 1, hdr: { dims: [3, 4, 3, 2, 1] } }, { opacity: 0.6 }],
    accept: true,
    drawing: null,
    async loadDrawing(file) {
      if (this.accept) this.drawing = new Uint8Array(await file.arrayBuffer());
      return this.accept;
    },
    createEmptyDrawing() {},
    drawUndo() { this.calls.push(['drawUndo']); },
    closeDrawing() { this.calls.push(['closeDrawing']); this.drawIsEnabled = false; },
    async setVolume(index, options) { this.calls.push(['setVolume', index, options]); },
    async saveDrawing() { return this.drawing.slice(); },
  };
}

async function until(condition) {
  for (let i = 0; i < 1000 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.ok(condition(), 'condition never held');
}

function setup(options = {}) {
  const { window } = new JSDOM('<div id="viewer"></div>');
  const nv = fakeNv();
  const applied = [];
  const cancelled = [];
  const editor = createMaskEditor({
    nv,
    doc: window.document,
    onApply: (...args) => applied.push(args),
    onCancel: (stage) => cancelled.push(stage),
    ...options,
  });
  window.document.getElementById('viewer').append(editor);
  const events = [];
  for (const name of ['nd-mask-edit-start', 'nd-mask-edit-apply', 'nd-mask-edit-cancel']) {
    window.document.body.addEventListener(name, (event) => events.push([name, event.detail]));
  }
  const key = (key, init = {}, target = window.document.body) => target.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, ...init }));
  return { window, nv, editor, applied, cancelled, events, key };
}

test('the toolbar is hidden until a session starts and renders the editing controls', async (t) => {
  const { window, editor, events } = setup();
  t.after(() => window.close());
  assert.equal(editor.hidden, true);
  assert.equal(await editor.start({ stage: 'mask', file: maskFile([1, 1]), label: 'Brain mask', overlayIndex: 1 }), true);
  assert.equal(editor.hidden, false);
  assert.equal(editor.session.state, 'editing');
  assert.equal(editor.querySelector('.nd-viewer-label').textContent, 'Editing Brain mask');
  const tools = [...editor.querySelectorAll('.nd-tool-group[role="group"] .nd-tool-btn')];
  assert.deepEqual(tools.map(button => button.textContent), ['Draw', 'Erase', 'Fill']);
  assert.deepEqual(tools.map(button => button.getAttribute('aria-pressed')), ['true', 'false', 'false']);
  assert.equal(tools[2].title, 'Outline a region; it fills when you release');
  assert.equal(editor.querySelector('select'), null, 'a binary mask has no Label select');
  const brush = editor.querySelector('.nd-brush-control input[type="range"]');
  assert.deepEqual([brush.min, brush.max, brush.value], ['1', '25', '3']);
  assert.deepEqual([...editor.querySelectorAll('.nd-btn.nd-btn-sm')].map(button => button.textContent), ['Undo', 'Apply', 'Cancel']);
  assert.equal(editor.querySelector('[style], dialog, h1, h2, h3, h4'), null);
  assert.deepEqual(events, [['nd-mask-edit-start', { stage: 'mask', message: 'Editing Brain mask. Left-drag paints; Apply keeps the changes.' }]]);
});

test('a label map offers its values, and names when known', async (t) => {
  const { window, editor, nv } = setup({ labelNames: { 3: 'Hippocampus' } });
  t.after(() => window.close());
  await editor.start({ stage: 'aseg', file: maskFile([2, 2, 5]) });
  const select = editor.querySelector('label > select');
  assert.deepEqual([...select.options].map(option => option.textContent), ['2', '3 — Hippocampus', '5']);
  assert.equal(nv.drawPenValue, 2);
  select.value = '5';
  select.dispatchEvent(new window.Event('change'));
  assert.equal(nv.drawPenValue, 5);
});

test('tools, brush and shortcuts drive the drawing pen', async (t) => {
  const { window, editor, nv, key } = setup();
  t.after(() => window.close());
  await editor.start({ stage: 'mask', file: maskFile([1]) });
  assert.deepEqual([nv.drawPenValue, nv.drawPenFilled, nv.drawPenSize], [1, false, 3]);
  editor.querySelector('[data-tool="erase"]').click();
  assert.equal(nv.drawPenValue, 0);
  assert.equal(editor.querySelector('[data-tool="erase"]').getAttribute('aria-pressed'), 'true');
  key('f');
  assert.deepEqual([nv.drawPenValue, nv.drawPenFilled], [1, true]);
  key(']');
  key(']');
  assert.equal(nv.drawPenSize, 5);
  assert.equal(editor.querySelector('.nd-brush-control span').textContent, '5');
  key('z', { ctrlKey: true });
  assert.deepEqual(nv.calls, [['drawUndo']]);
  key('d', {}, editor.querySelector('input[type="range"]'));
  assert.equal(nv.drawPenFilled, true, 'keys typed into a control are not shortcuts');
  const brush = editor.querySelector('input[type="range"]');
  brush.value = '25';
  brush.dispatchEvent(new window.Event('input'));
  assert.equal(nv.drawPenSize, 25);
});

test('Apply returns a gzipped File with the original name and restores the overlay', async (t) => {
  const { window, editor, nv, applied, events, key } = setup();
  t.after(() => window.close());
  const file = maskFile([1]);
  await editor.start({ stage: 'mask', file, overlayIndex: 1 });
  assert.deepEqual(nv.calls, [['setVolume', 1, { opacity: 0 }]]);
  editor.querySelectorAll('.nd-btn')[1].click();
  await until(() => applied.length === 1);
  assert.equal(applied.length, 1);
  const [stage, edited, context] = applied[0];
  assert.equal(stage, 'mask');
  assert.equal(edited.name, 'mask.nii.gz');
  assert.equal(context.original, file);
  const bytes = new Uint8Array(gunzipSync(new Uint8Array(await edited.arrayBuffer())));
  assert.equal(parseNiftiHeader(bytes.buffer).datatype, 2);
  assert.deepEqual([...bytes.subarray(352, 355)], [1, 0, 0]);
  assert.deepEqual(nv.calls.slice(1), [['closeDrawing'], ['setVolume', 1, { opacity: 0.6 }]]);
  assert.equal(editor.session.state, 'idle');
  assert.equal(editor.hidden, true);
  assert.deepEqual(events.at(-1), ['nd-mask-edit-apply', { stage: 'mask' }]);
  key('e');
  assert.equal(nv.drawPenValue, 1, 'shortcuts stop when the session closes');
});

test('an uncompressed result stays uncompressed', async (t) => {
  const { window, editor } = setup();
  t.after(() => window.close());
  await editor.start({ stage: 'mask', file: maskFile([1], 'mask.nii') });
  const edited = await editor.apply();
  assert.equal(edited.name, 'mask.nii');
  assert.equal(parseNiftiHeader(await edited.arrayBuffer()).voxOffset, 352);
});

test('Cancel discards the drawing and restores the overlay', async (t) => {
  const { window, editor, nv, cancelled, applied, events } = setup();
  t.after(() => window.close());
  await editor.start({ stage: 'mask', file: maskFile([1]), overlayIndex: 1 });
  editor.querySelectorAll('.nd-btn')[2].click();
  await until(() => cancelled.length === 1);
  assert.deepEqual(cancelled, ['mask']);
  assert.deepEqual(applied, []);
  assert.deepEqual(nv.calls, [['setVolume', 1, { opacity: 0 }], ['closeDrawing'], ['setVolume', 1, { opacity: 0.6 }]]);
  assert.deepEqual(events.at(-1), ['nd-mask-edit-cancel', { stage: 'mask' }]);
  assert.equal(editor.hidden, true);
});

test('a mask NiiVue refuses leaves the editor idle with the overlay restored', async (t) => {
  const { window, editor, nv } = setup();
  t.after(() => window.close());
  nv.accept = false;
  await assert.rejects(editor.start({ stage: 'mask', file: maskFile([1]), label: 'Brain mask', overlayIndex: 1 }), /Brain mask does not share/);
  assert.equal(editor.session.state, 'idle');
  assert.equal(editor.hidden, true);
  assert.deepEqual(nv.calls, [['setVolume', 1, { opacity: 0 }], ['setVolume', 1, { opacity: 0.6 }]]);
  nv.accept = true;
  assert.equal(await editor.start({ stage: 'mask', file: maskFile([1]) }), true);
  await assert.rejects(editor.start({ stage: 'other', file: maskFile([1]) }), /while mask is open/);
});

test('a result list disables its Edit buttons while a session is open', async (t) => {
  const { window, editor } = setup();
  t.after(() => window.close());
  const list = createResultList({}, window.document);
  window.document.body.append(list);
  list.render({ mask: { editable: true }, labels: { editable: true } });
  window.document.addEventListener('nd-mask-edit-start', () => list.setEditingEnabled(false));
  for (const name of ['nd-mask-edit-apply', 'nd-mask-edit-cancel']) window.document.addEventListener(name, () => list.setEditingEnabled(true));
  const disabled = () => [...list.querySelectorAll('.nd-edit-btn')].map(button => button.disabled);
  await editor.start({ stage: 'mask', file: maskFile([1]) });
  assert.deepEqual(disabled(), [true, true]);
  await editor.cancel();
  assert.deepEqual(disabled(), [false, false]);
});

test('a session cancelled while its mask loads closes its drawing before the next one opens', async (t) => {
  const { window, nv, editor } = setup();
  t.after(() => window.close());
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const load = nv.loadDrawing.bind(nv);
  nv.loadDrawing = async (file) => { await gate; return load(file); };
  const first = editor.start({ stage: 'mask', file: maskFile([1]), overlayIndex: 1 });
  await until(() => editor.session.state === 'opening');
  await editor.cancel();
  assert.equal(editor.session.state, 'idle');
  const second = editor.start({ stage: 'other', file: maskFile([2]), overlayIndex: 1 });
  release();
  assert.equal(await first, false);
  assert.equal(await second, true);
  assert.equal(editor.session.stage, 'other');
  const closes = nv.calls.filter(([name]) => name === 'closeDrawing').length;
  assert.equal(closes, 1, 'the superseded drawing was closed once');
  assert.deepEqual(nv.calls.filter(([name]) => name === 'setVolume').map(([, , options]) => options.opacity), [0, 0.6, 0]);
  assert.deepEqual([...nv.drawing.subarray(352)].filter(Boolean), [2]);
});
