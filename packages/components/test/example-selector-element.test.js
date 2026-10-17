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
  const hint = control.querySelector('[role="status"]');
  assert.equal(hint.textContent, 'Brain MRI loaded.', 'the visible hint stays one short line');
  const labelledBy = control.select.getAttribute('aria-labelledby');
  assert.equal(control.querySelector(`#${labelledBy}`).textContent, 'Input', 'the icon never joins the accessible name');
  const info = control.querySelector('label .nd-info-icon');
  assert.equal(info.hidden, false);
  assert.equal(info.querySelector('.nd-info-tooltip').textContent, 'A T1-weighted head scan. Run to download a brain mask.');
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

test('a rate-limited example download is retried and loads', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let calls = 0;
  globalThis.fetch = async () => (++calls === 1
    ? new Response('', { status: 429, headers: { 'Retry-After': '0' } })
    : new Response('scan'));
  const { control, choose } = setup(async (_example, { fetchFiles }) => { await fetchFiles(); });
  choose();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(calls, 2);
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

test('resolved upload scope exposes misplaced selectors to the interface audit', () => {
  const { window } = new JSDOM('<main><input type="file"><aside></aside></main>');
  const doc = window.document;
  const selector = createExampleSelector({ examples, onLoad: async () => {} }, doc);
  const misplaced = doc.querySelector('aside');
  misplaced.append(selector);
  assert.equal(selector.uploadScope, misplaced);
  assert.equal(selector.uploadScope.querySelector('input[type="file"]'), null);
  selector.scope = doc.querySelector('main');
  assert.equal(selector.uploadScope.querySelector('input[type="file"]'), doc.querySelector('input'));
  selector.remove();
  assert.equal(selector.uploadScope, undefined);
  window.close();
});

test('the menu ends with file actions that open the scope input and hide its drop box', async () => {
  const { window } = new JSDOM('<body><div id="scope"><label class="nd-file"><input type="file" data-neurodesk-input="image"></label></div></body>');
  const scope = window.document.getElementById('scope');
  const control = createExampleSelector({ examples, onLoad: async () => {}, scope }, window.document);
  scope.prepend(control);
  const input = scope.querySelector('input');
  let opened = 0;
  input.click = () => { opened++; };
  const actions = [...control.select.options].filter(option => option.dataset.action);
  assert.equal(control.select.options[0].textContent, 'Load data or example…');
  assert.deepEqual(actions.map(option => option.textContent), ['Load files…', 'Load folder…']);
  assert.deepEqual([...control.select.options].map(option => option.value).filter(Boolean), ['brain'], 'only examples carry values');
  assert.ok(scope.querySelector('.nd-file').classList.contains('nd-file-merged'));
  actions[0].selected = true;
  control.select.dispatchEvent(new window.Event('change'));
  assert.equal(opened, 1);
  assert.equal(control.select.value, '');
  assert.equal(control.dataset.exampleState, 'idle', 'a file action never loads an example');
  control.destroy();
});

// A browser with File System Access: the pickers and handles are stubs, and
// deliverFiles builds its events from the page's globals.
function accessSession(t, { files = [], folder = null } = {}) {
  const { window } = new JSDOM('<body><div id="scope"><label class="nd-file"><input type="file" multiple data-neurodesk-input="image"></label></div></body>');
  const scope = window.document.getElementById('scope');
  const input = scope.querySelector('input');
  const previous = { Event: globalThis.Event, CustomEvent: globalThis.CustomEvent, DataTransfer: globalThis.DataTransfer };
  t.after(() => Object.assign(globalThis, previous));
  Object.assign(globalThis, {
    Event: window.Event,
    CustomEvent: window.CustomEvent,
    DataTransfer: class {
      items = { list: [], add: file => this.items.list.push(file) };
      get files() { return this.items.list; }
    },
  });
  Object.defineProperty(input, 'files', { get: () => input._files ?? [], set: value => { input._files = value; } });
  const calls = [];
  const pickers = {
    files: async options => { calls.push(['files', options]); return files.map(name => ({ kind: 'file', name, getFile: async () => new window.File([], name) })); },
    folder: async options => { calls.push(['folder', options]); return folder(window); },
  };
  window.showOpenFilePicker = options => pickers.files(options);
  window.showDirectoryPicker = options => pickers.folder(options);
  let inputPicker = 0;
  input.showPicker = () => { inputPicker++; };
  const changes = [];
  input.addEventListener('change', () => changes.push(input.files.map(file => file._webkitRelativePath ?? file.name)));
  const control = createExampleSelector({ examples, onLoad: async () => {}, scope }, window.document);
  scope.prepend(control);
  const choose = async action => {
    [...control.select.options].find(option => option.dataset.action === action).selected = true;
    control.select.dispatchEvent(new window.Event('change'));
    await tick();
  };
  return { window, control, input, calls, changes, pickers, choose, inputPicker: () => inputPicker };
}

const directory = (name, children) => ({ kind: 'directory', name, async *values() { yield* children; } });
const handle = (window, name) => ({ kind: 'file', name, getFile: async () => new window.File([], name) });

test('Load folder reads the chosen folder through File System Access with relative paths', async t => {
  const session = accessSession(t, {
    folder: window => directory('session', [
      handle(window, 'notes.txt'),
      directory('series-4', [handle(window, 'a.dcm'), handle(window, 'b.dcm')]),
      directory('series-9', [directory('echo', [handle(window, 'c.dcm')])]),
    ]),
  });
  await session.choose('folder');
  assert.deepEqual(session.calls, [['folder', { mode: 'read' }]]);
  assert.deepEqual(session.changes.map(paths => paths.sort()), [[
    'session/notes.txt', 'session/series-4/a.dcm', 'session/series-4/b.dcm', 'session/series-9/echo/c.dcm',
  ]], 'the primary input gets every file once, with the path a dropped folder carries');
  assert.equal(session.inputPicker(), 0, 'the input picker that says Upload never opens');
  assert.equal(session.control.select.value, '');
  session.control.destroy();
});

test('Load files opens the File System Access file picker for the primary input', async t => {
  const session = accessSession(t, { files: ['a.nii', 'b.nii'] });
  await session.choose('files');
  assert.deepEqual(session.calls, [['files', { multiple: true }]]);
  assert.deepEqual(session.changes, [['a.nii', 'b.nii']]);
  assert.equal(session.inputPicker(), 0);
  session.control.destroy();
});

test('dismissing a File System Access picker changes nothing', async t => {
  const session = accessSession(t);
  session.pickers.folder = async () => { throw new session.window.DOMException('The user aborted a request.', 'AbortError'); };
  session.pickers.files = session.pickers.folder;
  await session.choose('folder');
  await session.choose('files');
  assert.deepEqual(session.changes, []);
  assert.equal(session.inputPicker(), 0, 'a cancelled dialog does not open a second one');
  assert.equal(session.control.querySelector('[role="status"]').textContent, '');
  session.control.destroy();
});

test('without File System Access, or when it fails, the menu opens the input picker', async t => {
  const session = accessSession(t);
  session.pickers.files = async () => { throw new session.window.DOMException('Blocked', 'SecurityError'); };
  await session.choose('files');
  assert.equal(session.inputPicker(), 1, 'a failed File System Access picker falls back');
  delete session.window.showOpenFilePicker;
  delete session.window.showDirectoryPicker;
  await session.choose('files');
  assert.equal(session.inputPicker(), 2);
  assert.deepEqual(session.calls, []);
  assert.deepEqual(session.changes, []);
  session.control.destroy();
});

test('a refused picker brings the drop box back instead of failing silently', () => {
  const { window } = new JSDOM('<body><div id="scope"><label class="nd-file"><input type="file" data-neurodesk-input="model"></label><label class="nd-file"><input type="file" data-neurodesk-input="image"></label></div></body>');
  const scope = window.document.getElementById('scope');
  const control = createExampleSelector({ examples, onLoad: async () => {}, scope }, window.document);
  scope.prepend(control);
  const [model, image] = scope.querySelectorAll('input');
  assert.ok(image.closest('.nd-file').classList.contains('nd-file-merged'), 'the scan input is primary, not the first input');
  assert.ok(!model.closest('.nd-file').classList.contains('nd-file-merged'));
  image.showPicker = () => { throw new window.DOMException('No activation', 'NotAllowedError'); };
  [...control.select.options].find(option => option.dataset.action === 'files').selected = true;
  control.select.dispatchEvent(new window.Event('change'));
  assert.ok(!image.closest('.nd-file').classList.contains('nd-file-merged'));
  assert.match(control.textContent, /file box below/);
  control.destroy();
});

test('a replaced file field takes over the menu and loses its box', () => {
  const { window } = new JSDOM('<body><div id="scope"><label class="nd-file" id="old"><input type="file" data-neurodesk-input="image"></label></div></body>');
  const scope = window.document.getElementById('scope');
  const control = createExampleSelector({ examples, onLoad: async () => {}, scope }, window.document);
  scope.prepend(control);
  scope.querySelector('#old').replaceWith(Object.assign(window.document.createElement('label'), { className: 'nd-file', id: 'new', innerHTML: '<input type="file" data-neurodesk-input="image">' }));
  control.select.dispatchEvent(new window.Event('focus'));
  assert.ok(scope.querySelector('#new').classList.contains('nd-file-merged'));
  assert.equal(control.select.querySelectorAll('option[data-action="files"]').length, 1, 'actions are not duplicated');
  control.destroy();
});

test('pinned examples share verified cached files across controls and keep loading events offline', async t => {
  const previousFetch = globalThis.fetch;
  const previousCaches = globalThis.caches;
  const previousLocation = globalThis.location;
  t.after(() => {
    globalThis.fetch = previousFetch;
    globalThis.caches = previousCaches;
    globalThis.location = previousLocation;
  });
  const cache = new Map();
  globalThis.location = new URL('https://apps.example.org/first-app/');
  globalThis.caches = { async open() { return {
    async match(key) { return cache.has(key) ? new Response(cache.get(key)) : undefined; },
    async put(key, response) { cache.set(key, await response.arrayBuffer()); },
    async delete(key) { cache.delete(key); },
  }; } };
  const scan = new Uint8Array([1, 2, 3]);
  let downloads = 0;
  globalThis.fetch = async () => { downloads++; return new Response(scan); };
  const states = [];
  const imported = [];
  const pinned = [{ ...examples[0], files: [{ ...examples[0].files[0], bytes: 3,
    sha256: '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81' }] }];
  for (let index = 0; index < 2; index++) {
    const { control, choose } = setup(async (_example, { fetchFiles }) => {
      const files = await fetchFiles();
      imported.push([files[0].name, files[0].size]);
    });
    control.examples = index === 0 ? pinned : [{ ...pinned[0], files: [{ ...pinned[0].files[0], url: 'https://mirror.example.org/brain.nii' }] }];
    const ready = new Promise((resolve, reject) => control.addEventListener('nd-example-status', event => {
      states.push(event.detail.state);
      if (event.detail.state === 'ready') resolve();
      if (event.detail.state === 'error') reject(Error(event.detail.message));
    }));
    choose();
    await ready;
    control.destroy();
    globalThis.fetch = async () => { throw Error('offline'); };
    globalThis.location = new URL('https://apps.example.org/another-app/');
  }
  assert.equal(downloads, 1);
  assert.equal(cache.size, 1);
  assert.deepEqual(imported, [['brain.nii', 3], ['brain.nii', 3]]);
  assert.deepEqual(states, ['loading', 'ready', 'loading', 'ready']);
});
