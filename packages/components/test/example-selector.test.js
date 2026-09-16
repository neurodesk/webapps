import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { renderExampleSelector } from '../src/ui/renderExampleSelector.js';

const examples = [{
  id: 'brain', label: 'Brain MRI', description: 'A T1-weighted head scan.',
  expectedResult: 'Run to download a brain mask.',
  files: [{ role: 'image', name: 'brain.nii', url: 'https://example.test/brain.nii' }],
}];
const tick = () => new Promise(resolve => setImmediate(resolve));
function setup(onLoad) {
  const { window } = new JSDOM('<!doctype html><body><input type="file"></body>');
  const control = renderExampleSelector({ examples, onLoad }, window.document);
  window.document.body.append(control.root);
  const choose = () => {
    control.select.value = 'brain';
    control.select.dispatchEvent(new window.Event('change'));
  };
  return { control, window, choose };
}

test('one labelled selector loads only when chosen and reports successful import', async () => {
  const loaded = [];
  const { control, choose } = setup(async example => { loaded.push(example.id); });
  assert.deepEqual(loaded, []);
  assert.equal(control.root.querySelector('label').htmlFor, control.select.id);
  assert.equal(control.root.querySelectorAll('select[data-neurodesk-example]').length, 1);
  choose();
  await tick();
  assert.deepEqual(loaded, ['brain']);
  assert.equal(control.root.dataset.exampleState, 'ready');
  assert.equal(control.root.dataset.exampleId, 'brain');
  assert.match(control.root.textContent, /Run to download a brain mask/);
  assert.equal(control.select.disabled, false);
  control.destroy();
});

test('a failed import can retry the same selection', async () => {
  let attempts = 0;
  const { control, choose } = setup(async () => {
    if (++attempts === 1) throw new Error('Unavailable');
  });
  choose();
  await tick();
  assert.equal(control.root.dataset.exampleState, 'error');
  assert.match(control.root.textContent, /Unavailable.*retry/);
  assert.equal(control.select.value, '');
  assert.equal(control.select.disabled, false);
  choose();
  await tick();
  assert.equal(control.root.dataset.exampleState, 'ready');
  assert.equal(attempts, 2);
  control.destroy();
});

test('cancel prevents a late import from committing and does not clobber a newer load', async () => {
  let release;
  let calls = 0;
  const commits = [];
  const { control, choose } = setup(async (_example, { assertCurrent }) => {
    const attempt = ++calls;
    if (attempt === 1) await new Promise(resolve => { release = resolve; });
    assertCurrent();
    commits.push(attempt);
  });
  choose();
  control.cancel();
  assert.equal(control.root.dataset.exampleState, 'cancelled');
  choose();
  await tick();
  release();
  await tick();
  assert.deepEqual(commits, [2]);
  assert.equal(control.root.dataset.exampleState, 'ready');
  assert.equal(control.select.disabled, false);
  control.destroy();
});

test('replacement upload aborts example before the app input handler runs', async () => {
  let signal;
  const { control, choose, window } = setup(async contextExample => {
    assert.equal(contextExample.id, 'brain');
  });
  control.destroy();
  const replacement = renderExampleSelector({ examples, onLoad: async (_example, context) => {
    signal = context.signal;
    await new Promise(() => {});
  } }, window.document);
  window.document.body.append(replacement.root);
  replacement.select.value = 'brain';
  replacement.select.dispatchEvent(new window.Event('change'));
  const input = window.document.querySelector('input');
  let abortedBeforeImport = false;
  input.addEventListener('change', () => { abortedBeforeImport = signal.aborted; });
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(abortedBeforeImport, true);
  assert.equal(replacement.root.dataset.exampleState, 'cancelled');
  replacement.destroy();
});

test('download failure aborts companion fetches, then permits retry', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let signal;
  globalThis.fetch = async (_url, options) => {
    signal = options.signal;
    return new Response('failed', { status: 503 });
  };
  const { control, choose } = setup(async (_example, { fetchFiles }) => { await fetchFiles(); });
  choose();
  await tick();
  assert.equal(signal.aborted, true);
  assert.equal(control.root.dataset.exampleState, 'error');
  assert.equal(control.select.disabled, false);
  globalThis.fetch = async () => new Response('scan');
  choose();
  await tick();
  assert.equal(control.root.dataset.exampleState, 'ready');
  control.destroy();
});

test('destroy aborts loading and detaches the control', () => {
  let signal;
  const { control, choose } = setup(async (_example, context) => {
    signal = context.signal;
    await new Promise(() => {});
  });
  choose();
  control.destroy();
  assert.equal(signal.aborted, true);
  assert.equal(control.root.isConnected, false);
});

test('upload after a completed example clears its identity before import', async () => {
  const { control, choose, window } = setup(async () => {});
  choose();
  await tick();
  window.document.querySelector('input').dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(control.root.dataset.exampleState, 'idle');
  assert.equal(control.root.dataset.exampleId, undefined);
  control.destroy();
});

test('one failed bundle download aborts an unfinished companion without importing', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let companionAborted = false;
  let imported = false;
  globalThis.fetch = async (url, { signal }) => {
    if (url.endsWith('brain.nii')) return new Response('', { status: 503 });
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        companionAborted = true;
        reject(signal.reason);
      });
    });
  };
  const { window } = new JSDOM('<!doctype html><body></body>');
  const control = renderExampleSelector({
    examples: [{ ...examples[0], files: [...examples[0].files, { role: 'metadata', name: 'brain.json', url: 'https://example.test/brain.json' }] }],
    onLoad: async (_example, { fetchFiles }) => { await fetchFiles(); imported = true; },
  }, window.document);
  control.select.value = 'brain';
  control.select.dispatchEvent(new window.Event('change'));
  await tick();
  assert.equal(companionAborted, true);
  assert.equal(imported, false);
  assert.equal(control.root.dataset.exampleState, 'error');
  control.destroy();
});
