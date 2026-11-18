import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createConsole } from '../src/elements/console.js';
import { ConsoleOutput } from '../src/ui/ConsoleOutput.js';
import { ProgressManager } from '../src/ui/ProgressManager.js';
import {
  bindMemoryCrashMonitor,
  formatMemoryError,
  isMemoryErrorMessage,
  isRawMemoryErrorText,
} from '../src/ui/memoryCrash.js';

function createWorkspaceDom(t, url = 'https://webapps.neurodesk.org/synthsr/', sessionEntries = {}) {
  const dom = new JSDOM(`<!doctype html><html><body>
    <div class="nd-app-bar"><button type="button" data-neurodesk-shell-control="standalone">Standalone</button></div>
    <header id="controls">
      <input id="imageInput" type="file" data-neurodesk-input="image" multiple />
      <button id="runButton" class="nd-btn nd-btn-primary" type="button">Run</button>
    </header>
    <main id="viewer">
      <div class="nd-viewer-canvas-wrapper"><canvas id="gl1"></canvas></div>
    </main>
    <canvas id="outsideCanvas"></canvas>
    <footer id="status">
      <span class="nd-status-label">Status</span>
      <span id="statusText" class="nd-status-text">Drag and drop files</span>
      <progress id="progress" max="1" value="0"></progress>
      <button id="cancelButton" class="nd-btn-cancel" type="button" hidden>×</button>
    </footer>
  </body></html>`, { url, pretendToBeVisual: true });
  const { window } = dom;
  window.Element.prototype.checkVisibility ??= function checkVisibility() {
    return !this.hidden && !this.closest('.hidden');
  };
  for (const [key, value] of Object.entries(sessionEntries)) {
    window.sessionStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
  }
  const log = createConsole({ id: 'technicalLog' }, window.document);
  window.document.getElementById('viewer').append(log);
  const progressManager = new ProgressManager({
    barElement: window.document.getElementById('progress'),
    textElement: window.document.getElementById('statusText'),
    cancelElement: window.document.getElementById('cancelButton'),
  });
  let monitor = null;
  t.after(() => {
    progressManager.stopTimer();
    monitor?.destroy();
    dom.window.close();
  });
  return {
    dom,
    window,
    document: window.document,
    log,
    progressManager,
    bind(options) {
      monitor = bindMemoryCrashMonitor(window.document, options);
      return monitor;
    },
  };
}

const waitMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('isMemoryErrorMessage and formatMemoryError keep status messages phone-sized and distinguish causes', () => {
  const rawMemoryFailures = [
    ['RangeError: Out of memory', 'oom'],
    ['RangeError: Array buffer allocation failed', 'oom'],
    ['RangeError: Invalid typed array length: 4294967295', 'oom'],
    ['RangeError: WebAssembly.Memory(): could not allocate memory', 'oom'],
    ['CompileError: WebAssembly.instantiate(): Out of memory: Cannot allocate Wasm memory for new instance', 'oom'],
    ['RuntimeError: Aborted(OOM)', 'oom'],
    ['Cannot enlarge memory, requested 1073741824 bytes', 'oom'],
    ['Error: OrtRun() failed: std::bad_alloc', 'oom'],
    ['Failed to allocate memory for requested buffer of size 536870912', 'oom'],
    ['memory allocation of 268435456 bytes failed', 'oom'],
    ['GPUOutOfMemoryError: buffer allocation failed', 'oom'],
    ['U-Net GPU out of memory', 'oom'],
    ['WebGL context lost', 'webgl'],
    ['Processing worker stopped unexpectedly (often low device memory)', 'worker-crash'],
    ['Worker message could not be deserialized (often low device memory)', 'worker-crash'],
  ];
  for (const [sample, expectedKind] of rawMemoryFailures) {
    assert.equal(isMemoryErrorMessage(sample), true, sample);
    const formatted = formatMemoryError(sample);
    assert.ok(formatted, sample);
    assert.equal(formatted.kind, expectedKind, sample);
    assert.ok(formatted.status.length <= 90, `${formatted.status.length} chars: ${formatted.status}`);
    assert.match(formatted.status, /use Standalone/);
  }

  for (const kind of ['reload-active', 'reload-discarded', 'reload-loaded']) {
    const formatted = formatMemoryError('', { kind, detail: 'Segmenting…' });
    assert.ok(formatted.status.length <= 90, `${kind}: ${formatted.status.length} chars`);
  }

  const ignored = [
    '',
    'HTTP 503 Service Unavailable',
    'Choose one 3D NIfTI volume.',
    'WebGPU is unavailable in this browser.',
    'RuntimeError: CUDA out of memory',
    'After neck cropping, the scan still exceeds GPU memory. Use 1.5 mm voxels to reduce detail and memory.',
    'This scan cannot fit this GPU at 1–3 mm. Use standalone SynthSeg or another device.',
    'Decoded image too large (2.40 GB; browser limit 2.00 GB).',
    'This volume needs a 512 MiB GPU buffer but this device allows 256 MiB.',
    'This device reports 4 GB of memory. BISON needs 8 GB or more.',
    'Too large for in-browser tensor fitting (WebAssembly memory limit).',
    'The last parallel reconstruction did not finish; hemispheres now run one at a time (Advanced settings).',
    formatMemoryError('RangeError: Out of memory').status,
  ];
  for (const sample of ignored) {
    assert.equal(isMemoryErrorMessage(sample), false, sample);
    assert.equal(formatMemoryError(sample), null, sample);
  }
});

test('a phone tab killed mid-run and reloaded shows honest guidance without re-triggering the observer', async (t) => {
  const url = 'https://webapps.neurodesk.org/synthseg/';
  let clock = 1_700_000_000_000;
  const first = createWorkspaceDom(t, url);
  let holds = 0;
  let settleInitialCoi;
  first.window.coiHoldReloads = () => { holds += 1; };
  first.window.coiWillReload = new Promise((resolve) => { settleInitialCoi = resolve; });
  Object.defineProperty(first.window.navigator, 'serviceWorker', {
    value: { controller: {} },
    configurable: true,
  });
  first.bind({ now: () => clock });

  // Even if clients.claim() set a controller mid-activation on a first visit,
  // coiHoldReloads must NOT run before coiWillReload settles!
  first.document.getElementById('runButton').click();
  assert.equal(holds, 0);

  // Once coiWillReload settles false (initial bootstrap complete), workflow start holds SW update reloads.
  settleInitialCoi(false);
  await waitMs(10);
  first.document.getElementById('runButton').click();
  first.progressManager.begin('Segmenting brain · 42%');
  first.progressManager.setProgress(0.42, 'Segmenting brain · 42%');
  first.progressManager.setCancellable(true);
  // Let the 250 ms click-reconciliation window expire so checkpoint reflects live DOM progress.
  await waitMs(280);

  assert.equal(holds, 1);
  const savedRaw = first.window.sessionStorage.getItem('neurodesk-memory-guard:/synthseg/');
  assert.ok(savedRaw);
  const saved = JSON.parse(savedRaw);
  assert.equal(saved.active, true);
  assert.equal(saved.detail, 'Segmenting brain · 42%');

  clock += 3000;
  const reloaded = createWorkspaceDom(t, url, { 'neurodesk-memory-guard:/synthseg/': savedRaw });
  reloaded.document.getElementById('statusText').textContent = 'Loading…';

  let statusMutations = 0;
  const statusText = reloaded.document.getElementById('statusText');
  const counter = new reloaded.window.MutationObserver(() => { statusMutations += 1; });
  counter.observe(statusText, { attributes: true, childList: true, characterData: true, subtree: true });
  t.after(() => counter.disconnect());

  reloaded.bind({ now: () => clock });
  await waitMs(40);

  assert.match(statusText.textContent, /reloaded mid-run \(likely low memory\)/);
  assert.ok(statusText.classList.contains('error'));
  assert.equal(reloaded.log.collapsed, false);
  assert.match(reloaded.log.getText(), /Segmenting brain · 42%/);
  assert.equal(reloaded.window.sessionStorage.getItem('neurodesk-memory-guard:/synthseg/'), null);

  // Verify the page is completely quiescent (no infinite observer loop) and timers run normally.
  const settledMutations = statusMutations;
  let timerRan = false;
  reloaded.window.setTimeout(() => { timerRan = true; }, 10);
  await waitMs(40);
  assert.equal(timerRan, true);
  assert.equal(statusMutations, settledMutations);

  // Late app boot resetting status to "Drag and drop files" must not erase the notice.
  statusText.classList.remove('error');
  statusText.textContent = 'Drag and drop files';
  await waitMs(20);
  assert.match(statusText.textContent, /reloaded mid-run \(likely low memory\)/);
  assert.ok(statusText.classList.contains('error'));

  // Tapping Standalone in the app bar keeps the notice visible.
  reloaded.document.querySelector('[data-neurodesk-shell-control="standalone"]').click();
  statusText.textContent = 'Ready';
  await waitMs(20);
  assert.match(statusText.textContent, /reloaded mid-run \(likely low memory\)/);

  // Starting a new workflow run releases the recovery guard cleanly.
  reloaded.document.getElementById('runButton').click();
  reloaded.progressManager.begin('Preparing image…');
  await waitMs(20);
  assert.equal(statusText.textContent, 'Preparing image…');
  assert.equal(statusText.classList.contains('error'), false);
});

test('idle hidden tabs and COI reloads do not trigger false memory warnings, while discarded tabs report discard', async (t) => {
  const url = 'https://webapps.neurodesk.org/ants/';

  // 1. Loaded but idle background tab without document.wasDiscarded -> silent idle start.
  const hiddenIdle = createWorkspaceDom(t, url, {
    'neurodesk-memory-guard:/ants/': { active: false, loaded: true, hidden: true, detail: '', updatedAt: 1000 },
  });
  hiddenIdle.bind({ now: () => 2000 });
  assert.equal(hiddenIdle.document.getElementById('statusText').textContent, 'Drag and drop files');

  // 2. Loaded background tab with document.wasDiscarded === true -> honest tab-discard notice,
  //    even when the idle tab sat discarded in the background past the 30-minute heuristic cutoff!
  const discarded = createWorkspaceDom(t, url, {
    'neurodesk-memory-guard:/ants/': { active: false, loaded: true, hidden: true, detail: '', updatedAt: 1000 },
  });
  Object.defineProperty(discarded.document, 'wasDiscarded', { value: true, configurable: true });
  discarded.bind({ now: () => 1000 + 31 * 60 * 1000 });
  assert.match(discarded.document.getElementById('statusText').textContent, /discarded this tab to free memory\. Load files again/);

  // 3a. COI reload marker recorded on window (after coi-serviceworker consumed coiReloadedBySelf) suppresses recovery.
  const coiReloadedWindow = createWorkspaceDom(t, url, {
    'neurodesk-memory-guard:/ants/': { active: true, loaded: true, hidden: false, detail: 'Registering…', updatedAt: 1000 },
  });
  coiReloadedWindow.window[Symbol.for('neurodesk.coiReloaded')] = 'reload';
  coiReloadedWindow.bind({ now: () => 2000 });
  assert.equal(coiReloadedWindow.document.getElementById('statusText').textContent, 'Drag and drop files');

  // 3b. COI reload marker still in sessionStorage also suppresses recovery.
  const coiReloadedStorage = createWorkspaceDom(t, url, {
    coiReloadedBySelf: 'coep',
    'neurodesk-memory-guard:/ants/': { active: true, loaded: true, hidden: false, detail: 'Registering…', updatedAt: 1000 },
  });
  coiReloadedStorage.bind({ now: () => 2000 });
  assert.equal(coiReloadedStorage.document.getElementById('statusText').textContent, 'Drag and drop files');

  // 3c. COI reload coordination clears checkpoint before reload.
  let resolveCoi;
  const coiPage = createWorkspaceDom(t, url);
  coiPage.window.crossOriginIsolated = false;
  coiPage.window.coiWillReload = new Promise((resolve) => { resolveCoi = resolve; });
  coiPage.bind({ now: () => 1000 });
  coiPage.document.getElementById('runButton').click();
  assert.ok(coiPage.window.sessionStorage.getItem('neurodesk-memory-guard:/ants/'));
  resolveCoi(true);
  await waitMs(20);
  assert.equal(coiPage.window.sessionStorage.getItem('neurodesk-memory-guard:/ants/'), null);

  // 4. Clean pagehide clears checkpoint; bfcache pageshow re-arms it.
  const navPage = createWorkspaceDom(t, url);
  navPage.bind({ now: () => 1000 });
  navPage.document.getElementById('runButton').click();
  navPage.progressManager.begin('Registering…');
  await waitMs(20);
  assert.ok(navPage.window.sessionStorage.getItem('neurodesk-memory-guard:/ants/'));
  navPage.window.dispatchEvent(new navPage.window.Event('pagehide'));
  assert.equal(navPage.window.sessionStorage.getItem('neurodesk-memory-guard:/ants/'), null);
  navPage.window.dispatchEvent(new navPage.window.Event('pageshow'));
  assert.ok(navPage.window.sessionStorage.getItem('neurodesk-memory-guard:/ants/'));
});

test('isRawMemoryErrorText leaves app prose about memory alone but catches forwarded engine errors', () => {
  const appProse = [
    'Partial: 1,200 streamlines from 5,000 of 9,000 seeds (out of memory).',
    'TRX saved, but the 3D preview ran out of memory. Use “Save TRX” to download it.',
    'Out of memory: raise the Seed/Stop FA thresholds or lower Density for the full set.',
    'The 3D view shows 1 in 4 streamlines to fit in memory; the saved TRX holds all of them.',
  ];
  for (const sample of appProse) {
    assert.equal(isRawMemoryErrorText(sample), false, sample);
  }
  const forwarded = [
    'RangeError: Out of memory',
    'Error: Out of memory',
    'Out of memory',
    'RuntimeError: Aborted(OOM)',
    'RangeError: Array buffer allocation failed',
    'Error: OrtRun() failed: std::bad_alloc',
    'U-Net GPU out of memory',
    'GPUOutOfMemoryError',
    'Processing worker stopped unexpectedly (often low device memory)',
  ];
  for (const sample of forwarded) {
    assert.equal(isRawMemoryErrorText(sample), true, sample);
  }
});

test('the monitor never rewrites an app status that explains a memory limit itself', async (t) => {
  const page = createWorkspaceDom(t, 'https://webapps.neurodesk.org/dwi2trx/');
  page.bind();
  const statusText = page.document.getElementById('statusText');
  page.document.getElementById('runButton').click();
  for (const [message, error] of [
    ['Partial: 1,200 streamlines from 5,000 of 9,000 seeds (out of memory).', false],
    ['TRX saved, but the 3D preview ran out of memory. Use “Save TRX” to download it.', true],
  ]) {
    statusText.textContent = message;
    statusText.classList.toggle('error', error);
    page.log.log(message, error ? 'error' : 'info');
    await waitMs(20);
    assert.equal(statusText.textContent, message);
    assert.equal(statusText.classList.contains('error'), error);
    assert.doesNotMatch(page.log.getText(), /Browser memory limit exceeded/);
  }
});

test('progress animation does not rewrite the session checkpoint every frame', async (t) => {
  const url = 'https://webapps.neurodesk.org/synthseg/';
  const page = createWorkspaceDom(t, url);
  page.bind({ now: () => 1000 });
  page.document.getElementById('runButton').click();
  page.progressManager.begin('Segmenting…');
  await waitMs(280);
  const key = 'neurodesk-memory-guard:/synthseg/';
  assert.equal(JSON.parse(page.window.sessionStorage.getItem(key)).active, true);

  const storage = Object.getPrototypeOf(page.window.sessionStorage);
  const originalSetItem = storage.setItem;
  let writes = 0;
  storage.setItem = function countedSetItem(...args) {
    writes += 1;
    return originalSetItem.apply(this, args);
  };
  t.after(() => { storage.setItem = originalSetItem; });
  const progress = page.document.getElementById('progress');
  for (let frame = 1; frame <= 30; frame += 1) {
    progress.value = frame / 100;
    await waitMs(1);
  }
  assert.equal(writes, 0);
  page.progressManager.setText('Segmenting · 50%');
  await waitMs(20);
  assert.equal(writes, 1);
  assert.equal(JSON.parse(page.window.sessionStorage.getItem(key)).detail, 'Segmenting · 50%');
});

test('app-owned crash recovery messages win whether written before or after monitor bind', async (t) => {
  const url = 'https://webapps.neurodesk.org/topofit/';
  const topofitNotice = 'The last parallel reconstruction did not finish; hemispheres now run one at a time (Advanced settings).';

  // Ordering A: TopoFit sets #statusText before bindMemoryCrashMonitor runs.
  const beforeBind = createWorkspaceDom(t, url, {
    'neurodesk-memory-guard:/topofit/': { active: true, loaded: true, hidden: false, detail: 'Fitting cortex…', updatedAt: 1000 },
  });
  beforeBind.document.getElementById('statusText').textContent = topofitNotice;
  beforeBind.bind({ now: () => 2000 });
  await waitMs(20);
  assert.equal(beforeBind.document.getElementById('statusText').textContent, topofitNotice);
  assert.equal(beforeBind.document.getElementById('statusText').classList.contains('error'), false);

  // Ordering B: TopoFit sets #statusText after bindMemoryCrashMonitor runs.
  const afterBind = createWorkspaceDom(t, url, {
    'neurodesk-memory-guard:/topofit/': { active: true, loaded: true, hidden: false, detail: 'Fitting cortex…', updatedAt: 1000 },
  });
  afterBind.bind({ now: () => 2000 });
  const statusText = afterBind.document.getElementById('statusText');
  assert.match(statusText.textContent, /reloaded mid-run/);
  statusText.classList.remove('error');
  statusText.textContent = topofitNotice;
  await waitMs(20);
  assert.equal(statusText.textContent, topofitNotice);
});

test('live OOM errors route through shared owners, respect ConsoleOutput line caps and React statusManaged', async (t) => {
  const page = createWorkspaceDom(t);
  page.bind();
  const statusText = page.document.getElementById('statusText');

  statusText.textContent = 'RangeError: Array buffer allocation failed';
  statusText.classList.add('error');
  page.log.log('RangeError: Array buffer allocation failed', 'error');
  await waitMs(20);

  assert.equal(
    statusText.textContent,
    'Out of browser memory on this device. Try a smaller input, close tabs, or use Standalone.',
  );
  const rawMatches = [...page.document.querySelectorAll('#technicalLog .nd-console-message')]
    .filter((node) => node.textContent.includes('RangeError: Array buffer allocation failed'));
  assert.equal(rawMatches.length, 1);

  // Deduplicating a worker-crash log entry keeps suspected wording rather than claiming confirmed OOM!
  const crashDedupPage = createWorkspaceDom(t);
  crashDedupPage.bind();
  crashDedupPage.log.log('Processing worker stopped unexpectedly (often low device memory)', 'error');
  crashDedupPage.document.getElementById('statusText').textContent = 'Processing worker stopped unexpectedly (often low device memory)';
  await waitMs(20);
  assert.doesNotMatch(crashDedupPage.log.getText(), /Browser memory limit exceeded/);
  assert.match(crashDedupPage.log.getText(), /Processing terminated unexpectedly/);

  // Raw footer (without ProgressManager): live OOM stays pinned over raw progress updates,
  // and finishing with "Done" or a specific app error INSIDE the 250 ms window is never overwritten!
  const rawFooterDom = new JSDOM(`<!doctype html><html><body>
    <header id="controls"><button id="runButton" class="nd-btn nd-btn-primary" type="button">Run</button></header>
    <div id="rawConsole" class="console-output"></div>
    <footer id="status">
      <span id="statusText" class="nd-status-text">Drag and drop files</span>
      <progress id="progress" max="1" value="0.2"></progress>
      <button id="cancelButton" class="nd-btn-cancel" type="button">×</button>
    </footer>
  </body></html>`, { url: 'https://webapps.neurodesk.org/niimath/', pretendToBeVisual: true });
  const rawMonitor = bindMemoryCrashMonitor(rawFooterDom.window.document);
  t.after(() => {
    rawMonitor?.destroy();
    rawFooterDom.window.close();
  });
  rawFooterDom.window.document.getElementById('runButton').click();
  const rawStatus = rawFooterDom.window.document.getElementById('statusText');
  rawStatus.textContent = 'Aborted(OOM)';
  await waitMs(20);
  assert.match(rawStatus.textContent, /Out of browser memory on this device/);
  assert.ok(rawStatus.classList.contains('error'));
  rawStatus.textContent = 'Processing 50%';
  await waitMs(20);
  assert.match(rawStatus.textContent, /Out of browser memory on this device/);
  assert.ok(rawStatus.classList.contains('error'));
  // End the run INSIDE the 250 ms grace window (< 60 ms elapsed since click):
  rawFooterDom.window.document.getElementById('cancelButton').hidden = true;
  rawFooterDom.window.document.getElementById('progress').value = 1;
  rawStatus.textContent = 'Done';
  await waitMs(20);
  assert.equal(rawStatus.textContent, 'Done');
  assert.equal(rawStatus.classList.contains('error'), false);
  await waitMs(260);
  assert.equal(rawStatus.textContent, 'Done');
  assert.equal(rawStatus.classList.contains('error'), false);

  // Clicking Run to retry while "Done" is still visible must keep the new 250 ms active checkpoint!
  rawFooterDom.window.document.getElementById('progress').value = 0;
  rawFooterDom.window.document.getElementById('runButton').click();
  const retryCheckpoint = JSON.parse(rawFooterDom.window.sessionStorage.getItem('neurodesk-memory-guard:/niimath/'));
  assert.equal(retryCheckpoint.active, true);

  // Specific non-memory error ending inside the 250 ms window (even while progress remains partial!) is preserved,
  // and a subsequent retry failing with "Failed" does NOT inherit an earlier run's console OOM!
  const rawConsole = rawFooterDom.window.document.getElementById('rawConsole');
  const rawLogger = new ConsoleOutput({ element: rawConsole, mirrorToConsole: false });
  rawFooterDom.window.document.getElementById('cancelButton').hidden = false;
  rawFooterDom.window.document.getElementById('progress').value = 0.3;
  rawFooterDom.window.document.getElementById('runButton').click();
  rawLogger.log('RangeError: Out of memory', 'error');
  rawStatus.textContent = 'Failed';
  await waitMs(20);
  assert.match(rawStatus.textContent, /Out of browser memory on this device/);
  // Leave progress at 0.3 (partial) while hiding Cancel and writing a specific non-memory error:
  rawFooterDom.window.document.getElementById('cancelButton').hidden = true;
  rawStatus.textContent = 'Error: Could not write output';
  rawStatus.classList.add('error');
  await waitMs(260);
  assert.equal(rawStatus.textContent, 'Error: Could not write output');
  assert.equal(rawStatus.classList.contains('error'), true);
  rawFooterDom.window.document.getElementById('progress').value = 0;

  // Retry fails with generic "Failed" and no new OOM line in console -> stays "Failed"!
  rawFooterDom.window.document.getElementById('runButton').click();
  rawLogger.log('Invalid NIfTI magic bytes', 'error');
  rawStatus.textContent = 'Failed';
  await waitMs(20);
  assert.equal(rawStatus.textContent, 'Failed');

  // Legacy ConsoleOutput (without <nd-console>) respects its configured maxLines cap, custom lineClass,
  // and shell-first fallback -> app-owner handoff (so Copy includes recovery lines logged before app init).
  const legacyPage = new JSDOM(`<!doctype html><html><body>
    <div class="console-container collapsed" data-disclosure><div id="consoleOutput" class="console-output"></div></div>
    <footer id="status"><span id="statusText" class="nd-status-text">Loading…</span></footer>
  </body></html>`, { url: 'https://webapps.neurodesk.org/musclemap/', pretendToBeVisual: true });
  legacyPage.window.sessionStorage.setItem('neurodesk-memory-guard:/musclemap/', JSON.stringify({
    active: true,
    loaded: true,
    hidden: false,
    detail: 'Segmenting whole body…',
    updatedAt: 1000,
  }));
  const legacyMonitor = bindMemoryCrashMonitor(legacyPage.window.document, { now: () => 2000 });
  t.after(() => {
    legacyMonitor?.destroy();
    legacyPage.window.close();
  });
  // Monitor ran BEFORE MuscleMap constructed its ConsoleOutput; now construct MuscleMap's custom ConsoleOutput!
  const legacyOut = legacyPage.window.document.getElementById('consoleOutput');
  const appConsole = new ConsoleOutput({
    element: legacyOut,
    lineClass: 'console-line',
    timeClass: 'console-time',
    messageClass: 'console-message',
    separator: ' ',
    levelOn: 'message',
    levelClass: (level) => (level === 'info' ? '' : level),
    maxLines: 2,
    mirrorToConsole: false,
  });
  assert.equal(ConsoleOutput.forElement(legacyOut), appConsole);
  assert.match(appConsole.getText(), /Segmenting whole body…/);

  appConsole.log('Line 2', 'info');
  assert.equal(legacyOut.children.length, 2);
  legacyPage.window.document.getElementById('statusText').textContent = 'Failed';
  appConsole.log('Error: WebAssembly.Memory(): could not allocate memory', 'error');
  await waitMs(20);
  assert.equal(legacyOut.children.length, 2);
  assert.match(appConsole.getText(), /Browser memory limit exceeded/);
  assert.match(legacyPage.window.document.getElementById('statusText').textContent, /Out of browser memory/);

  // Dual-channel console (<nd-console channels="analysis:Analysis,technical:Technical">)
  // routes lifecycle/memory diagnostics to Technical without polluting Analysis.
  const dualDom = new JSDOM(`<!doctype html><html><body>
    <main id="viewer"></main>
    <footer id="status"><span id="statusText" class="nd-status-text">RangeError: Out of memory</span></footer>
  </body></html>`, { url: 'https://webapps.neurodesk.org/samsrf/', pretendToBeVisual: true });
  const dualConsole = createConsole({
    id: 'dualLog',
    channels: 'analysis:Analysis,technical:Technical',
  }, dualDom.window.document);
  dualDom.window.document.getElementById('viewer').append(dualConsole);
  assert.equal(dualConsole.activeChannel, 'analysis');
  const dualMonitor = bindMemoryCrashMonitor(dualDom.window.document);
  t.after(() => {
    dualMonitor?.destroy();
    dualDom.window.close();
  });
  assert.equal(dualConsole.activeChannel, 'technical');
  assert.equal(dualConsole.getText('analysis'), '');
  assert.match(dualConsole.getText('technical'), /Browser memory limit exceeded/);

  // React-managed status (dicompare) receives CustomEvent without direct DOM mutation,
  // and recognizes [data-neurodesk-viewer-canvas] context loss + restoration.
  const reactDom = createWorkspaceDom(t, 'https://webapps.neurodesk.org/dicompare/', {
    'neurodesk-memory-guard:/dicompare/': { active: true, loaded: true, hidden: false, detail: 'Validating…', updatedAt: 1000 },
  });
  const dicompareCanvas = reactDom.document.createElement('canvas');
  dicompareCanvas.setAttribute('data-neurodesk-viewer-canvas', '');
  reactDom.document.body.append(dicompareCanvas);
  const notices = [];
  const restored = [];
  reactDom.window[Symbol.for('neurodesk.statusManaged')] = true;
  reactDom.window.addEventListener('neurodesk-memory-notice', (event) => notices.push(event.detail));
  reactDom.window.addEventListener('neurodesk-memory-restored', (event) => restored.push(event.detail));
  reactDom.bind({ now: () => 2000 });
  assert.equal(notices.length, 1);
  assert.equal(notices[0].kind, 'reload-active');
  assert.equal(reactDom.document.getElementById('statusText').textContent, 'Drag and drop files');

  dicompareCanvas.dispatchEvent(new reactDom.window.Event('webglcontextlost'));
  await waitMs(20);
  assert.equal(notices.length, 2);
  assert.equal(notices[1].kind, 'webgl');

  // Unmounting a lost viewer canvas without webglcontextrestored and mounting a replacement canvas
  // that subsequently loses WebGL must dispatch a fresh WebGL notice!
  dicompareCanvas.remove();
  const replacementCanvas = reactDom.document.createElement('canvas');
  replacementCanvas.setAttribute('data-neurodesk-viewer-canvas', '');
  reactDom.document.body.append(replacementCanvas);
  await waitMs(20);
  assert.equal(restored.length, 1);

  replacementCanvas.dispatchEvent(new reactDom.window.Event('webglcontextlost'));
  await waitMs(20);
  assert.equal(notices.length, 3);
  assert.equal(notices[2].kind, 'webgl');
  replacementCanvas.dispatchEvent(new reactDom.window.Event('webglcontextrestored'));
  await waitMs(20);
  assert.equal(restored.length, 2);
  assert.equal(restored[1].kind, 'webgl');
});

test('webglcontextlost and uncaught errors never disable active run cancellation, and restore only when all lost viewer canvases recover', async (t) => {
  const page = createWorkspaceDom(t);
  const secondViewerCanvas = page.document.createElement('canvas');
  secondViewerCanvas.id = 'gl2';
  page.document.querySelector('.nd-viewer-canvas-wrapper').append(secondViewerCanvas);
  const chartWrapper = page.document.createElement('div');
  chartWrapper.className = 'nd-chart';
  const chartCanvas = page.document.createElement('canvas');
  chartWrapper.append(chartCanvas);
  page.document.getElementById('viewer').append(chartWrapper);
  const runScript = page.document.createElement('script');
  runScript.type = 'application/json';
  runScript.id = 'neurodesk-run';
  runScript.textContent = JSON.stringify({ schemaVersion: 1, state: 'running', runId: 'r1' });
  page.document.body.append(runScript);

  page.bind();
  const statusText = page.document.getElementById('statusText');
  const progress = page.document.getElementById('progress');
  const cancel = page.document.getElementById('cancelButton');
  const viewerCanvas = page.document.getElementById('gl1');
  const outsideCanvas = page.document.getElementById('outsideCanvas');

  // Start an active cancellable run.
  page.document.getElementById('runButton').click();
  page.progressManager.begin('Converting…', { cancellable: true });
  page.progressManager.setProgress(0.5, 'Converting…');
  statusText.dataset.neurodeskState = 'running';
  await waitMs(20);

  // Losing WebGL on viewerCanvas during a run records the canvas as lost without overwriting active progress;
  // an uncaught OOM during a run surfaces the memory warning in #statusText.error while preserving progress, Cancel & run-state!
  viewerCanvas.dispatchEvent(new page.window.Event('webglcontextlost'));
  outsideCanvas.dispatchEvent(new page.window.Event('webglcontextlost'));
  await waitMs(20);
  assert.equal(statusText.textContent, 'Converting…');
  assert.equal(cancel.hidden, false);

  const rejection = new page.window.Event('unhandledrejection');
  rejection.reason = new RangeError('Out of memory');
  page.window.dispatchEvent(rejection);
  await waitMs(20);
  assert.equal(cancel.hidden, false);
  assert.equal(cancel.disabled, false);
  assert.equal(progress.value, 0.5);
  assert.equal(statusText.dataset.neurodeskState, 'running');
  assert.equal(JSON.parse(runScript.textContent).state, 'running');
  assert.match(statusText.textContent, /Out of browser memory on this device/);
  assert.ok(statusText.classList.contains('error'));
  assert.match(page.log.getText(), /Browser memory limit exceeded/);

  // Subsequent progress ticks keep moving the bar and leave Cancel active WITHOUT erasing the OOM notice!
  page.progressManager.setProgress(0.75, 'Converting 75%…');
  await waitMs(20);
  assert.equal(progress.value, 0.75);
  assert.equal(cancel.hidden, false);
  assert.match(statusText.textContent, /Out of browser memory on this device/);
  assert.ok(statusText.classList.contains('error'));

  // ProgressManager.reset() clears .error cleanly (e.g. Clear action in DCM2NIIX).
  page.progressManager.reset('Drag and drop files');
  assert.equal(statusText.textContent, 'Drag and drop files');
  assert.equal(statusText.classList.contains('error'), false);

  // When a short (< 250 ms) run finishes ("Done") while viewerCanvas is STILL lost from mid-run,
  // expiring the 250 ms click grace period immediately surfaces the still-lost WebGL context!
  page.progressManager.end('Done');
  statusText.dataset.neurodeskState = 'succeeded';
  await waitMs(280);
  assert.match(statusText.textContent, /Viewer graphics context lost/);
  assert.ok(statusText.classList.contains('error'));

  // Non-viewer canvases (outside #viewer or inside .nd-chart) are ignored when idle.
  outsideCanvas.dispatchEvent(new page.window.Event('webglcontextlost'));
  chartCanvas.dispatchEvent(new page.window.Event('webglcontextlost'));

  // Restore viewerCanvas first so status returns to Ready, then verify a class-only reveal (.hidden)
  // on a second viewer canvas that lost WebGL while hidden immediately surfaces the warning!
  viewerCanvas.dispatchEvent(new page.window.Event('webglcontextrestored'));
  await waitMs(20);
  assert.equal(statusText.textContent, 'Ready');

  secondViewerCanvas.classList.add('hidden');
  secondViewerCanvas.dispatchEvent(new page.window.Event('webglcontextlost'));
  await waitMs(20);
  assert.equal(statusText.textContent, 'Ready');

  secondViewerCanvas.classList.remove('hidden');
  await waitMs(20);
  assert.match(statusText.textContent, /Viewer graphics context lost/);
  assert.ok(statusText.classList.contains('error'));

  viewerCanvas.dispatchEvent(new page.window.Event('webglcontextlost'));
  await waitMs(20);

  outsideCanvas.dispatchEvent(new page.window.Event('webglcontextrestored'));
  chartCanvas.dispatchEvent(new page.window.Event('webglcontextrestored'));
  secondViewerCanvas.dispatchEvent(new page.window.Event('webglcontextrestored'));
  await waitMs(20);
  assert.match(statusText.textContent, /Viewer graphics context lost/);
  assert.ok(statusText.classList.contains('error'));

  // Once the other viewer canvas also restores, the warning clears!
  viewerCanvas.dispatchEvent(new page.window.Event('webglcontextrestored'));
  await waitMs(20);
  assert.equal(statusText.textContent, 'Ready');
  assert.equal(statusText.classList.contains('error'), false);
});
