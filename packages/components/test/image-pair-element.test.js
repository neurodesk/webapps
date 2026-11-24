import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { JSDOM } from 'jsdom';
import { createImagePair, fetchTemplateFile } from '../src/elements/image-pair.js';
import { describeNiftiFile } from '../src/file-io/NiftiUtils.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };

const brainTemplate = {
  id: 'brain', label: 'Brain template', filename: 'brain.nii.gz', license: 'Open', brainExtracted: true,
  dimensionality: 3, dims: [4, 4, 4], spacingMm: [1, 1, 1], url: 'https://example.test/brain.nii.gz', sha256: '0'.repeat(64), bytes: 1,
};

function sizeOf(name) {
  if (name.includes('flat')) return { dims: [8, 8], spacingMm: [0.5, 0.5], dimensionality: 2 };
  return { dims: [4, 4, 4], spacingMm: [1, 1, 1.5], dimensionality: 3 };
}

function setup(config = {}) {
  const { window } = new JSDOM('<!doctype html><body></body>');
  const calls = { open: [], clear: [], changes: [], status: [] };
  const pair = createImagePair({
    read: files => files.map(file => ({ name: file.name, file })),
    open: async (slot, candidate) => {
      calls.open.push([slot, candidate.name]);
      if (candidate.name.includes('broken')) throw new Error(`Cannot read ${candidate.name}`);
      return { name: candidate.name, ...sizeOf(candidate.name) };
    },
    clear: slot => { calls.clear.push(slot); },
    onChange: change => calls.changes.push(change),
    onStatus: (message, error) => calls.status.push([message, Boolean(error)]),
    fetchTemplate: async entry => new window.File(['x'], entry.filename),
    ...config,
  }, window.document);
  window.document.body.append(pair);
  const file = name => new window.File(['x'], name);
  const pick = async (id, names) => {
    const input = window.document.getElementById(id);
    Object.defineProperty(input, 'files', { value: names.map(file), configurable: true });
    input.dispatchEvent(new window.Event('change'));
    await settle();
  };
  return { window, pair, calls, pick, file, $: id => window.document.getElementById(id) };
}

test('the pair renders fixed then moving with explicit file and folder pickers', () => {
  const { pair, $ } = setup({ templates: [brainTemplate] });
  const slots = [...pair.querySelectorAll('.nd-image-slot')].map(slot => slot.dataset.slot);
  assert.deepEqual(slots, ['fixed', 'moving']);
  for (const slot of ['fixed', 'moving']) {
    const input = $(`${slot}Input`);
    const folder = $(`${slot}FolderInput`);
    assert.ok(input.closest('label.nd-file.nd-file-button'), 'the picker is a label.nd-file');
    assert.equal(input.multiple, true);
    assert.equal(input.hasAttribute('accept'), false);
    assert.equal(input.dataset.neurodeskInput, 'image');
    assert.equal(folder.hasAttribute('webkitdirectory'), true);
    assert.equal(input.closest('label').textContent, `Load ${slot} image…`);
    assert.ok(`${input.closest('label').textContent}`.startsWith(input.getAttribute('aria-label')), 'the accessible name contains the visible text');
    assert.equal($(`${slot}SlotTitle`).textContent, slot === 'fixed' ? 'Fixed image' : 'Moving image');
  }
  assert.ok($('fixedTemplate'), 'the fixed slot offers templates');
  assert.equal(pair.querySelector('#movingSlot #fixedTemplate, #movingTemplate'), null, 'the moving slot has no template select');
  assert.equal($('swapButton').disabled, true, 'nothing to swap yet');
  assert.equal(pair.querySelectorAll('.nd-btn-primary').length, 0, 'the run button stays the only primary');
});

test('picked files are read, opened and summarised; both slots make the pair ready', async () => {
  const { pair, calls, pick, $ } = setup();
  await pick('movingInput', ['t1.nii.gz']);
  assert.deepEqual(calls.open, [['moving', 't1.nii.gz']]);
  assert.equal($('movingInfo').hidden, false);
  assert.equal($('movingInfo').textContent, 't1.nii.gz · 4×4×4 · 1×1×1.5 mm');
  assert.ok($('movingSlot').classList.contains('has-files'));
  assert.equal(pair.ready, false);
  await pick('fixedInput', ['mni.nii.gz']);
  assert.equal(pair.ready, true);
  assert.equal(calls.changes.at(-1).ready, true);
  assert.equal($('fixedClear').hidden, false);
});

test('a failed load reopens the previous image and reports the error', async () => {
  const { pair, calls, pick, $ } = setup();
  await pick('fixedInput', ['good.nii.gz']);
  await pick('fixedInput', ['broken.nii.gz']);
  assert.deepEqual(calls.open, [['fixed', 'good.nii.gz'], ['fixed', 'broken.nii.gz'], ['fixed', 'good.nii.gz']]);
  assert.equal(pair.fixed.candidate.name, 'good.nii.gz');
  assert.match($('fixedInfo').textContent, /^good\.nii\.gz/);
  assert.deepEqual(calls.status.at(-1), ['Cannot read broken.nii.gz', true]);
  await pick('movingInput', ['broken.nii.gz']);
  assert.deepEqual(calls.clear, ['moving'], 'a failed first load empties its viewer');
  assert.equal(pair.moving, null);
});

test('clear empties one slot and swap exchanges both', async () => {
  const { pair, calls, pick, $ } = setup();
  await pick('fixedInput', ['a.nii.gz']);
  await pick('movingInput', ['b.nii.gz']);
  calls.open.length = 0;
  $('swapButton').click();
  await settle();
  assert.deepEqual(calls.open, [['fixed', 'b.nii.gz'], ['moving', 'a.nii.gz']]);
  assert.equal(pair.fixed.candidate.name, 'b.nii.gz');
  assert.equal(pair.moving.candidate.name, 'a.nii.gz');
  $('movingClear').click();
  assert.deepEqual(calls.clear, ['moving']);
  assert.equal(pair.moving, null);
  assert.equal($('movingInfo').hidden, true);
  assert.equal(pair.ready, false);
});

test('a template loads through the same slot path and carries its brain extraction', async () => {
  const { pair, calls, pick, $, window } = setup({ templates: [brainTemplate] });
  const select = $('fixedTemplate');
  select.value = 'brain';
  select.dispatchEvent(new window.Event('change'));
  await settle();
  assert.deepEqual(calls.open, [['fixed', 'brain.nii.gz']]);
  assert.equal(pair.fixed.image.brainExtracted, true);
  assert.match($('fixedInfo').textContent, /^Brain template · /, 'a template is named by its catalogue label');
  assert.equal(select.value, 'brain');
  await pick('fixedInput', ['own.nii.gz']);
  assert.equal(select.value, '', 'a user file replaces the template choice');
});

test('a dimensionality mismatch blocks the pair and disables 3D templates for a 2D moving image', async () => {
  const { pair, pick, $ } = setup({ templates: [brainTemplate] });
  await pick('fixedInput', ['volume.nii.gz']);
  await pick('movingInput', ['flat.tif']);
  assert.equal(pair.ready, false);
  assert.match(pair.error, /fixed image is 3D and the moving image is 2D/);
  assert.equal($('pairMessage').hidden, false);
  assert.ok($('pairMessage').classList.contains('error'));
  assert.equal($('fixedTemplate').disabled, true);
  assert.equal($('fixedHint').textContent, 'Templates are 3D; the moving image is 2D.');
  assert.ok($('fixedHint').textContent.length <= 90);
});

test('an app check adds to the default validation', async () => {
  const { pair, pick } = setup({ validatePair: (fixed, moving) => moving.candidate.name === 'odd.nii.gz' ? 'Odd image.' : '' });
  await pick('fixedInput', ['a.nii.gz']);
  await pick('movingInput', ['odd.nii.gz']);
  assert.equal(pair.error, 'Odd image.');
  assert.equal(pair.ready, false);
});

test('a brain-only image paired with a head image shows a short hint without blocking', async () => {
  const { pair, $, window } = setup({ templates: [brainTemplate] });
  const select = $('fixedTemplate');
  select.value = 'brain';
  select.dispatchEvent(new window.Event('change'));
  await settle();
  await pair.use('moving', { name: 'head.nii.gz', file: new window.File(['x'], 'head.nii.gz'), brainExtracted: false });
  assert.equal(pair.ready, true);
  assert.equal($('pairMessage').hidden, false);
  assert.ok($('pairMessage').classList.contains('warning'));
  assert.ok($('pairMessage').textContent.length <= 90);
});

test('several series offer a series select that reopens the chosen one', async () => {
  const { pair, calls, $, window, file } = setup({ read: () => [{ name: 'one.nii.gz' }, { name: 'two.nii.gz' }] });
  await pair.load('moving', [file('dicom')]);
  assert.equal($('movingSeriesField').hidden, false);
  assert.deepEqual([...$('movingSeries').options].map(option => option.textContent), ['one.nii.gz', 'two.nii.gz']);
  $('movingSeries').value = '1';
  $('movingSeries').dispatchEvent(new window.Event('change'));
  await settle();
  assert.deepEqual(calls.open.at(-1), ['moving', 'two.nii.gz']);
  assert.equal(pair.moving.index, 1);
});

test('a locked fixed template has no pickers, no swap and counts as loaded', async () => {
  const { pair, $ } = setup({ lockedFixed: brainTemplate, slotHelp: { moving: 'Your scan; normalized to the template' } });
  assert.equal($('fixedInput'), null);
  assert.equal($('swapButton'), null);
  assert.equal($('fixedInfo').textContent, 'Brain template · 4×4×4 · 1×1×1 mm');
  assert.ok($('movingSlot').querySelector('.nd-info-icon'));
  await pair.use('moving', { name: 'scan.nii.gz' });
  assert.equal(pair.ready, true);
  pair.reset('fixed');
  assert.ok(pair.fixed, 'the locked template cannot be cleared');
});

test('examples fill the slots by role through the same path as files', async () => {
  const { window } = new JSDOM('<!doctype html><body></body>');
  const opened = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async url => new Response(new TextEncoder().encode(url));
  try {
    const examples = [{
      id: 'pair', label: 'Pair', files: [
        { role: 'moving', name: 'moving.nii.gz', url: 'https://example.test/moving.nii.gz', brainExtracted: true },
        { role: 'fixed', name: 'fixed.nii.gz', url: 'https://example.test/fixed.nii.gz' },
      ],
    }];
    const pair = createImagePair({ examples, open: async (slot, candidate) => { opened.push([slot, candidate.name]); return { name: candidate.name, dimensionality: 3 }; } }, window.document);
    window.document.body.append(pair);
    const select = pair.querySelector('select[data-neurodesk-example]');
    assert.ok(select.compareDocumentPosition(pair.querySelector('#fixedInput')) & window.Node.DOCUMENT_POSITION_FOLLOWING, 'the example comes before the pickers');
    select.value = 'pair';
    select.dispatchEvent(new window.Event('change'));
    await settle();
    assert.deepEqual(opened, [['fixed', 'fixed.nii.gz'], ['moving', 'moving.nii.gz']]);
    assert.equal(pair.moving.image.brainExtracted, true);
    assert.equal(pair.exampleControl.dataset.exampleState, 'ready');
    pair.reset('moving');
    assert.equal(pair.exampleControl.dataset.exampleState, 'idle', 'clearing an image forgets the example');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

for (const cancelledBy of ['example', 'app']) {
  test(`cancelling the ${cancelledBy} during an example load preserves the previous image`, async () => {
    let release;
    let started;
    const entered = new Promise(resolve => { started = resolve; });
    const pending = new Promise(resolve => { release = resolve; });
    const controller = new AbortController();
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('example');
    try {
      const { pair, window } = setup({
        examples: [{ id: 'pair', label: 'Pair', files: [{ role: 'fixed', name: 'new.nii.gz', url: 'https://example.test/new.nii.gz' }] }],
        perform: (_message, task) => task(controller.signal),
        open: async (_slot, candidate) => {
          if (candidate.name === 'new.nii.gz') {
            started();
            await pending;
          }
          return { name: candidate.name, dimensionality: 3 };
        },
      });
      await pair.use('fixed', { name: 'old.nii.gz' });
      const select = pair.exampleControl.select;
      select.value = 'pair';
      select.dispatchEvent(new window.Event('change'));
      await entered;
      if (cancelledBy === 'example') pair.exampleControl.cancel();
      else controller.abort();
      release();
      await settle();
      assert.equal(pair.fixed.image.name, 'old.nii.gz');
      assert.equal(pair.querySelector('#fixedInfo').textContent, 'old.nii.gz');
      assert.notEqual(pair.exampleControl.dataset.exampleState, 'ready');
    } finally {
      release?.();
      globalThis.fetch = previousFetch;
    }
  });
}

test('loads started together run in turn, as a two-scan drop does', async () => {
  let busy = false;
  const perform = async (message, task) => {
    if (busy) throw new Error('Wait for the current operation to finish.');
    busy = true;
    try { return await task(undefined); } finally { busy = false; }
  };
  const { pair, file } = setup({ perform });
  await Promise.all([pair.load('fixed', [file('a.nii.gz')]), pair.load('moving', [file('b.nii.gz')])]);
  assert.equal(pair.fixed.candidate.name, 'a.nii.gz');
  assert.equal(pair.moving.candidate.name, 'b.nii.gz');
});

test('each change reports the files every slot holds for the page drop', async () => {
  const { pair, $, file } = setup();
  const reports = [];
  for (const slot of ['fixed', 'moving']) {
    $(`${slot}Input`).addEventListener('nd-files', event => reports.push([slot, event.detail.files.map(item => item.name)]));
  }
  await pair.load('fixed', [file('a.nii.gz')]);
  assert.deepEqual(reports.slice(-2), [['fixed', ['a.nii.gz']], ['moving', []]]);
  await pair.load('moving', [file('broken.nii.gz')]);
  assert.deepEqual(reports.slice(-2), [['fixed', ['a.nii.gz']], ['moving', []]], 'a failed load reports the slot as still empty');
  pair.reset('fixed');
  assert.deepEqual(reports.slice(-2), [['fixed', []], ['moving', []]]);
  assert.equal($('fixedSlot').hasAttribute('data-drop-target'), true, 'the card owns its drops');
});

test('a failed template or series load puts its select back on the image the slot holds', async () => {
  const { pair, $, window } = setup({
    templates: [brainTemplate],
    fetchTemplate: async () => { throw new Error('offline'); },
    read: () => [{ name: 'one.nii.gz' }, { name: 'broken.nii.gz' }],
  });
  const select = $('fixedTemplate');
  select.value = 'brain';
  select.dispatchEvent(new window.Event('change'));
  await settle();
  assert.equal(select.value, '', 'the template choice is withdrawn so the user can retry it');
  await pair.load('moving', [new window.File(['x'], 'dicom')]);
  $('movingSeries').value = '1';
  $('movingSeries').dispatchEvent(new window.Event('change'));
  await settle();
  assert.equal($('movingSeries').value, '0');
  assert.equal(pair.moving.candidate.name, 'one.nii.gz');
});

test('a replacement waits for a cancelled example rollback before opening its image', async () => {
  let releaseExample;
  let enterExample;
  let releaseRollback;
  let enterRollback;
  const exampleStarted = new Promise(resolve => { enterExample = resolve; });
  const examplePending = new Promise(resolve => { releaseExample = resolve; });
  const rollbackStarted = new Promise(resolve => { enterRollback = resolve; });
  const rollbackPending = new Promise(resolve => { releaseRollback = resolve; });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('example');
  let displayed;
  let exampleOpened = false;
  let replacement;
  try {
    const { pair, window, file } = setup({
      examples: [{ id: 'pair', label: 'Pair', files: [{ role: 'fixed', name: 'example.nii.gz', url: 'https://example.test/example.nii.gz' }] }],
      open: async (_slot, candidate) => {
        if (candidate.name === 'example.nii.gz') {
          exampleOpened = true;
          enterExample();
          await examplePending;
        } else if (candidate.name === 'old.nii.gz' && exampleOpened) {
          enterRollback();
          await rollbackPending;
        }
        displayed = candidate.name;
        return { name: candidate.name, dimensionality: 3 };
      },
    });
    await pair.use('fixed', { name: 'old.nii.gz' });
    pair.exampleControl.select.value = 'pair';
    pair.exampleControl.select.dispatchEvent(new window.Event('change'));
    await exampleStarted;
    replacement = pair.load('fixed', [file('replacement.nii.gz')]);
    releaseExample();
    await rollbackStarted;
    releaseRollback();
    await replacement;
    await settle();
    assert.equal(pair.fixed.image.name, 'replacement.nii.gz');
    assert.equal(displayed, 'replacement.nii.gz');
  } finally {
    releaseExample?.();
    releaseRollback?.();
    await replacement;
    globalThis.fetch = previousFetch;
  }
});

test('the pair\'s example menu lists only examples and hides no picker', async () => {
  const { window } = new JSDOM('<!doctype html><body></body>');
  const pair = createImagePair({
    examples: [{ id: 'pair', label: 'Pair', files: [] }],
    open: async (_slot, candidate) => ({ name: candidate.name }),
  }, window.document);
  window.document.body.append(pair);
  const select = pair.querySelector('select[data-neurodesk-example]');
  select.dispatchEvent(new window.Event('focus'));
  assert.deepEqual([...select.options].map(option => option.textContent), ['Choose an example…', 'Pair']);
  assert.equal(pair.querySelector('.nd-file-merged'), null);
});

test('disabling the pair disables every control', async () => {
  const { pair, pick, $ } = setup({ templates: [brainTemplate] });
  await pick('fixedInput', ['a.nii.gz']);
  pair.disabled = true;
  for (const id of ['fixedInput', 'fixedFolderInput', 'movingInput', 'fixedTemplate', 'swapButton', 'fixedClear']) {
    assert.equal($(id).disabled, true, `${id} is disabled`);
  }
});

test('fetchTemplateFile verifies the pinned bytes and names the template on failure', async () => {
  const bytes = new TextEncoder().encode('template bytes');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const sha256 = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
  const entry = { ...brainTemplate, sha256, bytes: bytes.length };
  const serve = body => async () => new Response(body, { headers: { 'content-type': 'application/gzip' } });
  const file = await fetchTemplateFile(entry, { fetch: serve(bytes), cache: null });
  assert.equal(file.name, 'brain.nii.gz');
  assert.equal(file.size, bytes.length);
  await assert.rejects(fetchTemplateFile(entry, { fetch: serve(new TextEncoder().encode('other bytes!!!')), cache: null }),
    /The Brain template template does not match its pinned size and SHA-256\./);
  await assert.rejects(fetchTemplateFile(entry, { fetch: async () => new Response('no', { status: 503 }), cache: null }),
    /Could not download the Brain template template\./);
});

test('describeNiftiFile reads spatial size, spacing and volumes from the header', async () => {
  const header = new ArrayBuffer(352);
  const view = new DataView(header);
  view.setInt32(0, 348, true);
  [4, 10, 12, 8, 5, 1, 1, 1].forEach((value, index) => view.setInt16(40 + index * 2, value, true));
  [1, 2, 2, 3, 1, 0, 0, 0].forEach((value, index) => view.setFloat32(76 + index * 4, value, true));
  view.setFloat32(108, 352, true);
  const summary = await describeNiftiFile(new File([header], 'bold.nii'));
  assert.deepEqual(summary, { name: 'bold.nii', dims: [10, 12, 8, 5], spacingMm: [2, 2, 3], dimensionality: 3, frames: 5 });
});

for (const [units, scale] of [[0, 1], [1, 1000], [2, 1], [3, 0.001]]) {
  test(`describeNiftiFile converts spatial unit ${units} to millimetres`, async () => {
    const header = new ArrayBuffer(352);
    const view = new DataView(header);
    view.setInt32(0, 348, true);
    [3, 10, 12, 8, 1, 1, 1, 1].forEach((value, index) => view.setInt16(40 + index * 2, value, true));
    [1, 2 / scale, 2 / scale, 3 / scale, 1, 0, 0, 0].forEach((value, index) => view.setFloat32(76 + index * 4, value, true));
    view.setFloat32(108, 352, true);
    view.setUint8(123, units | 8);
    const summary = await describeNiftiFile(new File([header], 'scan.nii'));
    summary.spacingMm.forEach((spacing, axis) => assert.ok(Math.abs(spacing - [2, 2, 3][axis]) < 1e-6));
  });
}
test('describeNiftiFile reads a gzipped header without reading the whole file', async () => {
  const image = new ArrayBuffer(352 + 4 * 4 * 4);
  const view = new DataView(image);
  view.setInt32(0, 348, true);
  [3, 4, 4, 4, 1, 1, 1, 1].forEach((value, index) => view.setInt16(40 + index * 2, value, true));
  [1, 1, 1, 1.5, 0, 0, 0, 0].forEach((value, index) => view.setFloat32(76 + index * 4, value, true));
  view.setFloat32(108, 352, true);
  const file = new File([gzipSync(new Uint8Array(image))], 't1.nii.gz');
  let wholeReads = 0;
  const arrayBuffer = file.arrayBuffer.bind(file);
  file.arrayBuffer = () => { wholeReads += 1; return arrayBuffer(); };
  const summary = await describeNiftiFile(file);
  assert.deepEqual(summary, { name: 't1.nii.gz', dims: [4, 4, 4], spacingMm: [1, 1, 1.5], dimensionality: 3, frames: 1 });
  assert.equal(wholeReads, 0, 'the gzipped file is streamed, not read whole');
});

async function compressedSummaryFile() {
  const { gzipSync } = await import('node:zlib');
  const header = new ArrayBuffer(352);
  const view = new DataView(header);
  view.setInt32(0, 348, true);
  [3, 10, 12, 8, 1, 1, 1, 1].forEach((value, index) => view.setInt16(40 + index * 2, value, true));
  [1, 2, 2, 3, 1, 0, 0, 0].forEach((value, index) => view.setFloat32(76 + index * 4, value, true));
  view.setFloat32(108, 352, true);
  return new File([gzipSync(new Uint8Array(header))], 'scan.nii.gz');
}

for (const unavailable of ['file stream', 'DecompressionStream']) {
  test(`describeNiftiFile reads gzip headers without ${unavailable}`, async () => {
    const file = await compressedSummaryFile();
    const decompressor = globalThis.DecompressionStream;
    if (unavailable === 'file stream') file.stream = undefined;
    else globalThis.DecompressionStream = undefined;
    try {
      const summary = await describeNiftiFile(file);
      assert.deepEqual(summary.spacingMm, [2, 2, 3]);
      assert.deepEqual(summary.dims, [10, 12, 8]);
    } finally {
      globalThis.DecompressionStream = decompressor;
    }
  });
}

test('createImagePair supports raster slotLabels, exampleRoles, showFolder:false, and empty-change Undo reset', async () => {
  const { window } = new JSDOM('<!doctype html><body></body>');
  const cleared = [];
  const pair = createImagePair({
    slotLabels: { fixed: 'Baseline', moving: 'Follow-up' },
    exampleRoles: { fixed: 'baseline', moving: 'followup' },
    showFolder: false,
    open: async (_slot, candidate) => ({ name: candidate.name, dims: [64, 64], dimensionality: 2 }),
    clear: slot => cleared.push(slot),
  }, window.document);
  window.document.body.append(pair);

  assert.equal(pair.querySelector('#fixedSlotTitle').textContent, 'Baseline image');
  assert.equal(pair.querySelector('#movingSlotTitle').textContent, 'Follow-up image');
  assert.equal(pair.querySelector('#fixedFolderInput'), null);
  assert.equal(pair.querySelector('#swapButton').textContent, '⇅ Swap baseline and follow-up');

  const input = pair.querySelector('#fixedInput');
  Object.defineProperty(input, 'files', { get: () => input._files ?? [], set: files => { input._files = files; } });
  input.files = [new window.File(['a'], 't0.png')];
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(pair.fixed?.image.name, 't0.png');

  // Shell Undo delivering an empty FileList resets the slot cleanly.
  input.files = [];
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(pair.fixed, null);
  assert.deepEqual(cleared, ['fixed']);
});

test('nd-replace Undo queued while a decode holds the pair disabled still runs once decode finishes', async () => {
  let releaseDecode;
  let decodeStarted;
  const started = new Promise(resolve => { decodeStarted = resolve; });
  const gate = new Promise(resolve => { releaseDecode = resolve; });
  const { pair, $, window } = setup({
    perform: async (_msg, task) => {
      pair.disabled = true;
      try { return await task(undefined); } finally { pair.disabled = false; }
    },
    open: async (_slot, candidate) => {
      if (candidate.name === 'dropped.png') {
        decodeStarted();
        await gate;
      }
      return { name: candidate.name, dims: [32, 32], dimensionality: 2 };
    },
  });
  await pair.use('fixed', { name: 'original.png', file: new window.File(['a'], 'original.png') });
  assert.equal(pair.fixed?.image.name, 'original.png');

  const input = $('fixedInput');
  Object.defineProperty(input, 'files', { get: () => input._files ?? [], set: files => { input._files = files; } });
  // Start a dropped load that holds decode open (pair.disabled === true).
  input.files = [new window.File(['b'], 'dropped.png')];
  input.dispatchEvent(new window.CustomEvent('nd-replace', { bubbles: true }));
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
  await started;
  assert.equal(pair.disabled, true);

  // Click Undo while decode is held open -> shell fires nd-replace + change with original file.
  input.files = [new window.File(['a'], 'original.png')];
  input.dispatchEvent(new window.CustomEvent('nd-replace', { bubbles: true }));
  input.dispatchEvent(new window.Event('change', { bubbles: true }));

  releaseDecode();
  await settle();
  assert.equal(pair.fixed?.image.name, 'original.png');
});

test('example downloads enter perform before fetch resolves so app footer cancel aborts download', async () => {
  let fetchAborted = false;
  let enteredPerform = false;
  const controller = new AbortController();
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (_url, init = {}) => new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => {
      fetchAborted = true;
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
  try {
    const { pair, window } = setup({
      examples: [{ id: 'pair', label: 'Pair', files: [{ role: 'fixed', name: 'f.png', url: 'https://example.test/f.png' }] }],
      perform: (_msg, task) => {
        enteredPerform = true;
        return task(controller.signal);
      },
      open: async (_slot, candidate) => ({ name: candidate.name, dimensionality: 2 }),
    });
    const select = pair.exampleControl.select;
    select.value = 'pair';
    select.dispatchEvent(new window.Event('change'));
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(enteredPerform, true, 'perform started before fetch resolved');
    controller.abort();
    await settle();
    assert.equal(fetchAborted, true, 'aborting perform signal cancels example fetch');
  } finally {
    globalThis.fetch = previousFetch;
  }
});
