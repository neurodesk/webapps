import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function section(source, start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `Missing source section ${start}`);
  return source.slice(first, last);
}

const synthseg = await readFile(new URL('../apps/synthseg/src/main.js', import.meta.url), 'utf8');
test('SynthSeg input replacement waits for an entered editor callback to finish loading its volumes', async () => {
  const pending = deferred();
  const nodes = new Map();
  const run = { signal: new AbortController().signal, current: true, ready() {}, fail() {} };
  let visible = 'old input';
  let replacementLoads = 0;
  const oldLoad = pending.promise.then(() => { visible = 'old labels'; });
  const context = vm.createContext({
    editor: { cancel: () => oldLoad },
    runs: { begin: () => run },
    $: id => {
      if (!nodes.has(id)) nodes.set(id, {});
      return nodes.get(id);
    },
    renderResults() {}, setBusy() {}, status() {},
    readNifti: async () => ({ data: [], dims: [1, 1, 1] }),
    gridOf: () => ({}), looksLikeCt: () => false,
    show() { replacementLoads++; visible = 'new input'; },
    file: { name: 'new.nii', arrayBuffer: async () => new ArrayBuffer(0) },
  });
  vm.runInContext(`let source, sourceGrid, labels, provenance, operation;
    let viewRevision = 0, busy = false, webgpu = true;
    ${section(synthseg, 'function clearOutputs()', '\nasync function importImages(')}`, context);
  const loading = vm.runInContext('load(file)', context);
  await tick();
  assert.equal(replacementLoads, 0, 'new input loaded while old editor callback still owns the viewer');
  pending.resolve();
  assert.equal(await loading, true);
  assert.equal(visible, 'new input');
});

const musclemap = await readFile(new URL('../apps/musclemap/web/js/musclemap-app.js', import.meta.url), 'utf8');
for (const [method, end] of [
  ['onFileLoaded', '\n  onFilesChanged()'],
  ['clearResults', '\n  // ==================== UI Helpers'],
]) {
  test(`MuscleMap ${method} waits for drawing cleanup before replacing the viewer`, async () => {
    const pending = deferred();
    const loads = [];
    const noop = () => {};
    const context = vm.createContext({
      document: { getElementById: () => null },
      parseFloat,
    });
    const start = musclemap.match(new RegExp(`  (?:async )?${method}\\(`))[0];
    const instance = vm.runInContext(`new class { ${section(musclemap, start, end)} }`, context);
    Object.assign(instance, {
      maskEditor: { cancel: () => pending.promise },
      inputFile: { name: 'input.nii' },
      isViewerAvailable: () => true,
      viewerController: { loadBaseVolume: async file => { loads.push(file); return true; } },
      nv: { volumes: [] },
      syncWindowControls: noop, syncImfControls: noop, syncPostprocessingControls: noop,
      muscleLegend: { hide: noop }, metricsSummary: { hide: noop },
      inferenceExecutor: { clearResults: noop }, disableAllResultTabs: noop,
      updateViewerInfo: noop,
    });
    const file = instance.inputFile;
    const replacing = instance[method](file);
    await tick();
    assert.equal(loads.length, 0, 'replacement reached viewer before editor cleanup settled');
    pending.resolve();
    await replacing;
    assert.deepEqual(loads, [file]);
  });
}

for (const app of ['brain-extraction', 'white-matter-lesions']) {
  const source = await readFile(new URL(`../apps/${app}/src/main.js`, import.meta.url), 'utf8');
  test(`${app} import waits for drawing cleanup before showing a replacement image`, async () => {
    const pending = deferred();
    const nodes = new Map();
    const loads = [];
    const noop = () => {};
    const file = { name: 'new.nii', arrayBuffer: async () => new ArrayBuffer(0) };
    const run = { signal: new AbortController().signal, current: true, ready: noop, fail: noop };
    const current = { run, controller: new AbortController() };
    const context = vm.createContext({
      editor: { cancel: () => pending.promise },
      results: { setEditingEnabled: noop, render: noop },
      renderOutputs: noop,
      exampleControl: { cancel: noop },
      start: () => current, begin: () => current,
      finish: noop, end: noop, status: noop,
      picker: { setHasFiles: noop },
      $: id => {
        if (!nodes.has(id)) nodes.set(id, { classList: { add: noop, remove: noop } });
        return nodes.get(id);
      },
      readImageFiles: async files => files,
      readVolume: () => ({ dims: [1, 1, 1] }),
      show: () => { loads.push(file); },
      files: Promise.resolve([file]),
    });
    const functions = app === 'brain-extraction'
      ? section(source, 'function resetOutputs()', '\nasync function ensureViewer(') +
        section(source, 'async function importImages(', '\npicker.onFiles(')
      : section(source, 'function closeEdit()', '\nasync function editResult(') +
        section(source, 'async function loadFiles(', '\nfunction importFiles(');
    vm.runInContext(`let source, editing, outputs = {}, viewRevision = 0;
      let state = { phase: 'idle' }, job;
      ${functions}`, context);
    const loading = vm.runInContext(app === 'brain-extraction' ? 'importImages(files)' : 'loadFiles(files)', context);
    await tick();
    assert.equal(loads.length, 0, 'replacement reached viewer before editor cleanup settled');
    pending.resolve();
    await loading;
    assert.deepEqual(loads, [file]);
  });
}
