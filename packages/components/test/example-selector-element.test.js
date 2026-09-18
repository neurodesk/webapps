import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createExampleSelector, defineExampleSelector } from '../src/elements/example-selector.js';

const examples = [{
  id: 'brain', label: 'Brain MRI', description: 'A T1-weighted head scan.',
  expectedResult: 'Run to download a brain mask.',
  files: [{ role: 'image', name: 'brain.nii', url: 'https://example.test/brain.nii' }],
}];
const tick = () => new Promise(resolve => setImmediate(resolve));
function setup(onLoad) {
  const { window } = new JSDOM('<!doctype html><body><input type="file"></body>');
  const control = createExampleSelector({ examples, onLoad }, window.document);
  window.document.body.append(control);
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
  assert.equal(control.querySelector('label').htmlFor, control.select.id);
  assert.equal(control.querySelectorAll('select[data-neurodesk-example]').length, 1);
  choose();
  await tick();
  assert.deepEqual(loaded, ['brain']);
  assert.equal(control.dataset.exampleState, 'ready');
  assert.equal(control.dataset.exampleId, 'brain');
  assert.match(control.textContent, /Run to download a brain mask/);
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
  assert.equal(control.dataset.exampleState, 'error');
  assert.match(control.textContent, /Unavailable.*retry/);
  assert.equal(control.select.value, '');
  assert.equal(control.select.disabled, false);
  choose();
  await tick();
  assert.equal(control.dataset.exampleState, 'ready');
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
  assert.equal(control.dataset.exampleState, 'cancelled');
  choose();
  await tick();
  release();
  await tick();
  assert.deepEqual(commits, [2]);
  assert.equal(control.dataset.exampleState, 'ready');
  assert.equal(control.select.disabled, false);
  control.destroy();
});

test('replacement upload aborts example before the app input handler runs', async () => {
  let signal;
  const { control, choose, window } = setup(async contextExample => {
    assert.equal(contextExample.id, 'brain');
  });
  control.destroy();
  const replacement = createExampleSelector({ examples, onLoad: async (_example, context) => {
    signal = context.signal;
    await new Promise(() => {});
  } }, window.document);
  window.document.body.append(replacement);
  replacement.select.value = 'brain';
  replacement.select.dispatchEvent(new window.Event('change'));
  const input = window.document.querySelector('input');
  let abortedBeforeImport = false;
  input.addEventListener('change', () => { abortedBeforeImport = signal.aborted; });
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(abortedBeforeImport, true);
  assert.equal(replacement.dataset.exampleState, 'cancelled');
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
  assert.equal(control.dataset.exampleState, 'error');
  assert.equal(control.select.disabled, false);
  globalThis.fetch = async () => new Response('scan');
  choose();
  await tick();
  assert.equal(control.dataset.exampleState, 'ready');
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
  assert.equal(control.isConnected, false);
});

test('upload after a completed example clears its identity before import', async () => {
  const { control, choose, window } = setup(async () => {});
  choose();
  await tick();
  window.document.querySelector('input').dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(control.dataset.exampleState, 'idle');
  assert.equal(control.dataset.exampleId, undefined);
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
  const control = createExampleSelector({
    examples: [{ ...examples[0], files: [...examples[0].files, { role: 'metadata', name: 'brain.json', url: 'https://example.test/brain.json' }] }],
    onLoad: async (_example, { fetchFiles }) => { await fetchFiles(); imported = true; },
  }, window.document);
  window.document.body.append(control);
  control.select.value = 'brain';
  control.select.dispatchEvent(new window.Event('change'));
  await tick();
  assert.equal(companionAborted, true);
  assert.equal(imported, false);
  assert.equal(control.dataset.exampleState, 'error');
  control.destroy();
});

test('removal aborts loading; synchronous reparenting preserves it without duplicating controls', async () => {
  let signal;
  let release;
  let calls = 0;
  const { control, window, choose } = setup(async (_example, context) => {
    calls++;
    signal = context.signal;
    await new Promise(resolve => { release = resolve; });
    context.assertCurrent();
  });
  choose();
  const select = control.select;
  const other = window.document.createElement('section');
  window.document.body.append(other);
  other.append(control);
  await tick();
  assert.equal(signal.aborted, false);
  assert.equal(control.select, select);
  assert.equal(control.querySelectorAll('select').length, 1);
  release();
  await tick();
  choose();
  assert.equal(calls, 2);
  control.remove();
  await tick();
  assert.equal(signal.aborted, true);
  release();
  window.document.body.append(control);
  assert.equal(control.select.disabled, false);
  control.destroy();
});

test('replacement inputs and drops affect only their workflow', async () => {
  const { window } = new JSDOM('<body><section data-example-scope><input type="file"></section><section data-example-scope><input type="file"></section></body>');
  const signals = [];
  const controls = [...window.document.querySelectorAll('section')].map(scope => {
    const control = createExampleSelector({ examples, onLoad: async (_example, context) => {
      signals.push(context.signal);
      await new Promise(() => {});
    } }, window.document);
    scope.append(control);
    control.select.value = 'brain';
    control.select.dispatchEvent(new window.Event('change'));
    return control;
  });
  assert.notEqual(controls[0].select.id, controls[1].select.id);
  window.document.querySelector('input').dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(signals[0].aborted, true);
  assert.equal(signals[1].aborted, false);
  controls[1].parentElement.dispatchEvent(new window.Event('drop', { bubbles: true }));
  assert.equal(signals[1].aborted, true);
  controls.forEach(control => control.destroy());
});

test('explicit scopes isolate selectors in one workspace', () => {
  const { window } = new JSDOM('<body><main class="nd-imaging-workspace"><section><input type="file"></section><section><input type="file"></section></main></body>');
  const controls = [...window.document.querySelectorAll('section')].map(scope => {
    const control = createExampleSelector({ examples, scope, onLoad: async () => new Promise(() => {}) }, window.document);
    scope.append(control);
    control.select.value = 'brain';
    control.select.dispatchEvent(new window.Event('change'));
    return control;
  });
  controls[0].scope.querySelector('input').dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(controls[0].dataset.exampleState, 'cancelled');
  assert.equal(controls[1].dataset.exampleState, 'loading');
  controls.forEach(control => control.destroy());
});

test('registration upgrades properties assigned before definition', async () => {
  const { window } = new JSDOM('<body><nd-example-selector></nd-example-selector></body>');
  const control = window.document.querySelector('nd-example-selector');
  let loads = 0;
  control.examples = examples;
  control.onLoad = async () => { loads++; };
  control.disabled = true;
  const ctor = defineExampleSelector(window);
  assert.equal(defineExampleSelector(window), ctor);
  assert.equal(control.select.options.length, 2);
  assert.equal(control.select.disabled, true);
  control.disabled = false;
  control.select.value = 'brain';
  control.select.dispatchEvent(new window.Event('change'));
  await tick();
  assert.equal(loads, 1);
  assert.equal(control.dataset.exampleState, 'ready');
});

test('checksum failure prevents import and permits a corrected retry', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => new Response('scan');
  let imports = 0;
  const { control, choose } = setup(async (_example, { fetchFiles }) => {
    await fetchFiles();
    imports++;
  });
  control.examples = [{ ...examples[0], files: [{ ...examples[0].files[0], sha256: 'invalid' }] }];
  const failed = new Promise(resolve => {
    const status = event => {
      if (event.detail.state !== 'error') return;
      control.removeEventListener('nd-example-status', status);
      resolve();
    };
    control.addEventListener('nd-example-status', status);
  });
  choose();
  await failed;
  assert.equal(control.dataset.exampleState, 'error');
  assert.match(control.textContent, /checksum/);
  assert.equal(imports, 0);
  control.examples = examples;
  choose();
  await tick();
  assert.equal(imports, 1);
  assert.equal(control.dataset.exampleState, 'ready');
});

test('completed selection survives removal and reconnecting rebinds replacement input once', async () => {
  let loads = 0;
  const { control, window, choose } = setup(async () => { loads++; });
  choose();
  await tick();
  const text = control.textContent;
  const select = control.select;
  control.remove();
  await tick();
  window.document.querySelector('input').dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(control.dataset.exampleId, 'brain');
  window.document.body.append(control);
  assert.equal(control.dataset.exampleId, 'brain');
  assert.equal(control.textContent, text);
  assert.equal(control.select, select);
  choose();
  await tick();
  assert.equal(loads, 2);
  window.document.querySelector('input').dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(control.dataset.exampleId, undefined);
  control.destroy();
});
