// Clear, concise status-bar and technical-log guidance when a browser tab hits
// memory limits on a phone or other memory-constrained device: whether a
// WebAssembly, JavaScript, ONNX Runtime or WebGPU allocation fails in-page, a
// running worker terminates unexpectedly, a viewer canvas loses its WebGL
// context, or a mobile browser reloads an active page without firing pagehide.
import { ConsoleOutput } from './ConsoleOutput.js';

const STORAGE_PREFIX = 'neurodesk-memory-guard:';
const GUARD_ATTR = 'data-nd-memory-guard';
const MAX_CRASH_AGE_MS = 30 * 60 * 1000;
const HEARTBEAT_MS = 15 * 1000;
const PROGRESS_MANAGER_KEY = Symbol.for('neurodesk.progressManager');
const STATUS_MANAGED_KEY = Symbol.for('neurodesk.statusManaged');
const COI_RELOADED_KEY = Symbol.for('neurodesk.coiReloaded');

// Remote compute servers (NeSVoR, Cryo-EM, SCT server mode) report their own
// GPU failures; never misattribute a server's CUDA error to the user's device.
const REMOTE_MEMORY_ERROR = /\bcuda out of memory\b/i;

// Messages an app already wrote in plain language with specific parameters or
// limits (SynthSeg's voxel-size recommendation, input-limits byte caps, GPU
// buffer MiB checks, BISON's deviceMemory check, DWI2TRX's fit message,
// TopoFit's sequential fallback, or our own formatted notices).
const ALREADY_EXPLAINED = new RegExp([
  String.raw`\buse Standalone\b`,
  String.raw`\bUse [\d.]+ mm voxels\b`,
  String.raw`\bUse standalone\b`,
  String.raw`\bbrowser limit [\d.]+\s*[KMGT]?B\b`,
  String.raw`\bneeds a [\d,]+ MiB GPU buffer\b`,
  String.raw`\breports \d+ GB of memory\b`,
  String.raw`\bToo large for in-browser\b`,
  String.raw`\bhemispheres now run one at a time\b`,
].join('|'), 'i');

const WEBGL_LOST = /\bwebgl context (?:was )?lost\b/i;

const WORKER_CRASH = new RegExp([
  String.raw`\bworker stopped unexpectedly \(often low(?: device)? memory\)`,
  String.raw`\bcould not be deserialized \(often low(?: device)? memory\)`,
].join('|'), 'i');

const RAW_MEMORY_ERROR = new RegExp([
  String.raw`\bout of memory\b`,
  String.raw`\bout-of-memory\b`,
  String.raw`\bgpuoutofmemoryerror\b`,
  String.raw`\barray buffer allocation failed\b`,
  String.raw`\binvalid (?:array buffer|typed array) length\b`,
  String.raw`\bcould not allocate memory\b`,
  String.raw`\bcannot allocate wasm memory\b`,
  String.raw`\b(?:cannot|unable to) (?:enlarge|grow) (?:instance )?memory\b`,
  String.raw`\babort(?:ed)?\(\s*oom\b`,
  String.raw`\b(?:std::)?bad_alloc\b`,
  String.raw`\bfailed to allocate memory\b`,
  String.raw`\ballocate memory for requested buffer\b`,
  String.raw`\bmemory allocation of \d+ bytes failed\b`,
  String.raw`\bwasm memory\b.*\b(?:limit|exceed|allocat|fail)`,
  String.raw`\bgpu out of memory\b`,
].join('|'), 'i');

// Initial or idle status messages that boot code writes before the user acts;
// none of these should overwrite a post-crash recovery notice.
const IDLE_STATUS = new RegExp([
  String.raw`^$`,
  String.raw`^drag and drop files$`,
  String.raw`^loading(?:…|\.{3})?$`,
  String.raw`^starting(?:…|\.{3})?$`,
  String.raw`^ready(?:\b|\s*·)`,
  String.raw`^initializing(?:\s+worker)?(?:…|\.{3})?$`,
  String.raw`^worker ready$`,
  String.raw`^preparing analysis engine\b`,
].join('|'), 'i');

const GENERIC_FAILURE_STATUS = /^(?:failed|error|worker error|error:\s*worker error)$/i;

const ACTIVE_STATUS_VERB = new RegExp(
  String.raw`^(?:loading|preparing|running|processing|segmenting|registering|fitting|converting|denoising|reconstructing|computing|estimating|analyzing|analysing|extracting|unwrapping|downloading|cropping|resampling|stitching|deconvolving|detecting|encoding|building|aligning|tracking|generating|meshing|warping|normalizing|reading|decoding)\b`,
  'i',
);

const ACTION_BUTTON_SELECTOR = '.nd-btn-primary, .btn-primary, #runButton, #processButton, #applyBtn';
const NON_WORKFLOW_CLICK_SELECTOR = '.nd-app-bar, dialog, .modal-overlay, .nd-modal-overlay, .nd-console-container, .console-container, nd-console';
const CONSOLE_OUTPUT_SELECTOR = 'nd-console .nd-console-output, .nd-console-output, .console-output, #consoleOutput';
const VIEWER_CANVAS_SELECTOR = '#gl1, #viewer canvas, [data-neurodesk-viewer-canvas], .nd-viewer-canvas-wrapper canvas, .viewer-canvas-wrapper canvas, .nvslide-pane-main canvas';
const NON_VIEWER_CANVAS_CONTAINER = '.nd-viewer-report, .nd-chart, .nd-chart-figure';

function cleanText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function errorText(value) {
  if (!value) return '';
  if (typeof value === 'string') return cleanText(value);
  const constructorName = value.constructor?.name;
  if (typeof value.message === 'string' && value.message.trim()) {
    const prefix = value.name || (constructorName && constructorName !== 'Object' ? constructorName : '');
    return prefix && !value.message.includes(prefix)
      ? cleanText(`${prefix}: ${value.message}`)
      : cleanText(value.message);
  }
  if (constructorName === 'GPUOutOfMemoryError') return 'GPUOutOfMemoryError';
  if (value.error) return errorText(value.error);
  if (value.reason) return errorText(value.reason);
  return cleanText(value);
}

/**
 * True when `value` is a raw browser, WebAssembly, ONNX Runtime, WebGPU, WebGL
 * or unexpected-worker-crash failure that needs plain-language explanation.
 */
export function isMemoryErrorMessage(value) {
  const text = errorText(value);
  if (!text) return false;
  if (REMOTE_MEMORY_ERROR.test(text)) return false;
  if (ALREADY_EXPLAINED.test(text)) return false;
  return WEBGL_LOST.test(text) || WORKER_CRASH.test(text) || RAW_MEMORY_ERROR.test(text);
}

/**
 * Format a memory error, unexpected worker crash or interrupted-page reload
 * into a concise status-bar message (<= 90 chars for narrow phone viewports)
 * and a detailed technical-log entry. Returns `null` for other errors.
 */
export function formatMemoryError(value, options = {}) {
  const raw = errorText(value);
  const explicitKind = options.kind;
  if (!explicitKind && !isMemoryErrorMessage(raw)) return null;
  const kind = explicitKind
    || (WEBGL_LOST.test(raw) ? 'webgl' : WORKER_CRASH.test(raw) ? 'worker-crash' : 'oom');

  if (kind === 'reload-active') {
    const step = cleanText(options.detail);
    const context = step && !IDLE_STATUS.test(step) ? ` (${step})` : '';
    const log = `Error: This page reloaded before processing finished${context}, which commonly happens on phones when browser memory runs out. Try a smaller or cropped input, close other tabs or apps, or open Standalone in the top bar to run on a computer.`;
    return {
      kind,
      raw,
      status: 'Page reloaded mid-run (likely low memory). Try smaller data or use Standalone.',
      log,
      dedupLog: log,
    };
  }

  if (kind === 'reload-discarded') {
    const log = 'Error: The browser discarded and reloaded this inactive tab (often to reclaim system memory), clearing your loaded session. Load your files again, close other tabs, or open Standalone in the top bar to run on a computer.';
    return {
      kind,
      raw,
      status: 'Browser discarded this inactive tab (often to free memory). Reload or use Standalone.',
      log,
      dedupLog: log,
    };
  }

  if (kind === 'reload-loaded') {
    const log = 'Error: This page reloaded unexpectedly without a normal navigation, clearing your loaded session (often caused by low device memory on mobile browsers). Close other tabs or apps, or open Standalone in the top bar to run on a computer.';
    return {
      kind,
      raw,
      status: 'Page reloaded unexpectedly (possible low memory). Close tabs or use Standalone.',
      log,
      dedupLog: log,
    };
  }

  if (kind === 'webgl') {
    return {
      kind,
      raw,
      status: 'Viewer graphics context lost (often low memory). Reload page or use Standalone.',
      log: `Error: The viewer WebGL graphics context was lost (${raw || 'WebGL context lost'}), often due to GPU memory pressure on mobile devices. Reload the page, close other tabs or apps, or open Standalone in the top bar to run on a computer.`,
      dedupLog: 'Error: The viewer WebGL graphics context was lost, often due to GPU memory pressure on mobile devices. Reload the page, close other tabs or apps, or open Standalone in the top bar to run on a computer.',
    };
  }

  if (kind === 'worker-crash') {
    return {
      kind,
      raw,
      status: 'Processing stopped unexpectedly (often low memory). Try smaller data or use Standalone.',
      log: `Error: Processing terminated unexpectedly${raw ? ` (${raw})` : ''}, which commonly happens on phones when WebAssembly or browser memory is exhausted. Try a smaller or cropped input, close other tabs or apps, or open Standalone in the top bar to run on a computer.`,
      dedupLog: 'Error: Processing terminated unexpectedly, which commonly happens on phones when WebAssembly or browser memory is exhausted. Try a smaller or cropped input, close other tabs or apps, or open Standalone in the top bar to run on a computer.',
    };
  }

  return {
    kind: 'oom',
    raw,
    status: 'Out of browser memory on this device. Try a smaller input, close tabs, or use Standalone.',
    log: `Error: Browser memory limit exceeded${raw ? ` (${raw})` : ''}. Mobile and browser tabs cap memory per page; try a smaller or cropped input, close other tabs or apps, or open Standalone in the top bar to run on a computer.`,
    dedupLog: 'Error: Browser memory limit exceeded on this device. Mobile and browser tabs cap memory per page; try a smaller or cropped input, close other tabs or apps, or open Standalone in the top bar to run on a computer.',
  };
}

function findStatusElement(doc) {
  return doc.querySelector('#statusText, #statusMsg, footer#status .nd-status-text, #status .nd-status-text');
}

function storageKey(view) {
  const pathname = view?.location?.pathname || '/';
  return `${STORAGE_PREFIX}${pathname}`;
}

function readCheckpoint(view, key) {
  try {
    const coiReloaded = Boolean(view?.[COI_RELOADED_KEY] || view?.sessionStorage?.getItem('coiReloadedBySelf'));
    const raw = view?.sessionStorage?.getItem(key);
    view?.sessionStorage?.removeItem(key);
    if (coiReloaded) return null;
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeCheckpoint(view, key, record) {
  try {
    if (view?.sessionStorage?.getItem('coiReloadedBySelf')) return;
    view?.sessionStorage?.setItem(key, JSON.stringify(record));
  } catch {
    // Private browsing or disabled storage leaves in-page error handling active.
  }
}

function clearCheckpoint(view, key) {
  try {
    view?.sessionStorage?.removeItem(key);
  } catch {
    // Ignore storage removal failures during teardown.
  }
}

function consoleContainsText(doc, needle) {
  if (!needle) return false;
  for (const output of doc.querySelectorAll(CONSOLE_OUTPUT_SELECTOR)) {
    if ((output.textContent || '').includes(needle)) return true;
  }
  return false;
}

function appendConsoleError(doc, message, { avoidDuplicateSubstring = '', fallbackMessage = '' } = {}) {
  if (avoidDuplicateSubstring && consoleContainsText(doc, avoidDuplicateSubstring)) {
    message = fallbackMessage || message;
  }
  if (consoleContainsText(doc, message)) return true;
  const ndConsole = doc.querySelector('nd-console');
  if (ndConsole && typeof ndConsole.log === 'function') {
    const channel = Array.isArray(ndConsole.channels) && ndConsole.channels.includes('technical')
      ? 'technical'
      : undefined;
    ndConsole.log(message, 'error', channel);
    return true;
  }
  const output = doc.querySelector(CONSOLE_OUTPUT_SELECTOR);
  if (!output) return false;
  ConsoleOutput.forElement(output).log(message, 'error');
  return true;
}

function writeStatusError(doc, view, text) {
  const manager = doc[PROGRESS_MANAGER_KEY];
  if (manager && typeof manager.setError === 'function') {
    manager.setError(text);
    return true;
  }
  const statusEl = findStatusElement(doc);
  if (!statusEl) return false;
  if (statusEl.textContent !== text) statusEl.textContent = text;
  if (!statusEl.classList.contains('error')) statusEl.classList.add('error');
  return true;
}

/**
 * Monitor a hosted Neurodesk webapp for interrupted-tab reloads and raw
 * out-of-memory errors, routing clear guidance through the page's status and
 * technical-log owners without interfering with active run controls.
 */
export function bindMemoryCrashMonitor(doc = globalThis.document, options = {}) {
  const root = doc?.documentElement;
  if (!root || root.hasAttribute(GUARD_ATTR)) return null;
  root.setAttribute(GUARD_ATTR, '');

  const view = doc.defaultView || globalThis.window;
  const now = options.now || (() => Date.now());
  const maxAgeMs = options.maxAgeMs ?? MAX_CRASH_AGE_MS;
  const key = storageKey(view);

  let applying = false;
  let interacted = false;
  let loaded = false;
  let immediateActiveDetail = '';
  let recoveredFailure = null;
  let activeRunFailure = null;
  let monitorErrorStatus = '';
  let pendingConsoleMessage = '';
  const lostCanvases = new Set();
  const seenConsoleTails = new WeakMap();
  let lostCanvasObserver = null;
  let webglNoticeDispatched = false;
  let coiInitialSettled = !view?.coiWillReload?.then;
  let cleanedUp = false;
  let unloading = false;
  let reconcileTimer = null;
  let heartbeatTimer = null;

  if (view?.coiWillReload?.then) {
    view.coiWillReload.then((reloading) => {
      if (reloading) onCleanUnload();
      else coiInitialSettled = true;
    }).catch(() => {
      coiInitialSettled = true;
    });
  }

  function applyFailure(formatted, { preserveRawSubstring = '', respectExistingNonIdle = false } = {}) {
    if (!formatted) return;
    if (view?.[STATUS_MANAGED_KEY] && typeof view.CustomEvent === 'function') {
      recoveredFailure = null;
      pendingConsoleMessage = '';
      view.dispatchEvent(new view.CustomEvent('neurodesk-memory-notice', { detail: formatted }));
      return;
    }
    applying = true;
    try {
      const statusEl = findStatusElement(doc);
      if (statusEl) {
        const current = cleanText(statusEl.textContent);
        if (respectExistingNonIdle && current && current !== formatted.status && !IDLE_STATUS.test(current)) {
          recoveredFailure = null;
        } else {
          writeStatusError(doc, view, formatted.status);
          monitorErrorStatus = formatted.status;
        }
      }
      const logged = appendConsoleError(doc, formatted.log, {
        avoidDuplicateSubstring: preserveRawSubstring,
        fallbackMessage: formatted.dedupLog,
      });
      pendingConsoleMessage = logged ? '' : formatted.log;
    } finally {
      applying = false;
    }
  }

  function flushPendingRecovery() {
    if (applying) return;
    if (view?.[STATUS_MANAGED_KEY] && typeof view.CustomEvent === 'function' && (recoveredFailure || pendingConsoleMessage)) {
      if (recoveredFailure) view.dispatchEvent(new view.CustomEvent('neurodesk-memory-notice', { detail: recoveredFailure }));
      recoveredFailure = null;
      pendingConsoleMessage = '';
      return;
    }
    if (pendingConsoleMessage) {
      if (appendConsoleError(doc, pendingConsoleMessage)) pendingConsoleMessage = '';
    }
    if (!recoveredFailure) return;
    const statusEl = findStatusElement(doc);
    if (!statusEl) return;
    const current = cleanText(statusEl.textContent);
    if (current === recoveredFailure.status) {
      if (!statusEl.classList.contains('error')) {
        applying = true;
        try { statusEl.classList.add('error'); } finally { applying = false; }
      }
      return;
    }
    // Let app-owned recovery or error messages (such as TopoFit's sequential
    // hemisphere notice) stand rather than overwriting them.
    if (current && !IDLE_STATUS.test(current)) {
      recoveredFailure = null;
      return;
    }
    applying = true;
    try {
      writeStatusError(doc, view, recoveredFailure.status);
      monitorErrorStatus = recoveredFailure.status;
    } finally {
      applying = false;
    }
  }

  // 1. Check whether the previous tab instance reloaded without pagehide /
  //    beforeunload while running a job, in the foreground with loaded data, or
  //    via browser tab discard (`document.wasDiscarded`).
  const previous = readCheckpoint(view, key);
  if (previous && typeof previous === 'object') {
    const age = now() - Number(previous.updatedAt || 0);
    const fresh = Number.isFinite(age) && age >= 0 && age <= maxAgeMs;
    const wasActive = previous.active === true;
    const wasDiscarded = previous.loaded === true && doc.wasDiscarded === true;
    const wasForegroundLoaded = previous.loaded === true && !previous.hidden;
    if (fresh && (wasActive || wasDiscarded || wasForegroundLoaded)) {
      const kind = wasActive ? 'reload-active' : wasDiscarded ? 'reload-discarded' : 'reload-loaded';
      recoveredFailure = formatMemoryError('', { kind, detail: previous.detail });
      applyFailure(recoveredFailure, { respectExistingNonIdle: true });
    }
  }

  function markConsoleTailsSeen() {
    for (const output of doc.querySelectorAll(CONSOLE_OUTPUT_SELECTOR)) {
      const marker = output.lastElementChild || output.textContent || '';
      if (marker) seenConsoleTails.set(output, marker);
    }
  }

  function inspectLiveErrors() {
    if (applying || view?.[STATUS_MANAGED_KEY]) return;
    const statusEl = findStatusElement(doc);
    if (!statusEl) return;
    const current = cleanText(statusEl.textContent);
    if (isMemoryErrorMessage(current)) {
      immediateActiveDetail = '';
      const active = currentSessionState().active;
      recoveredFailure = null;
      const formatted = formatMemoryError(current);
      activeRunFailure = active ? formatted : null;
      applyFailure(formatted, { preserveRawSubstring: current });
      markConsoleTailsSeen();
      return;
    }
    if (GENERIC_FAILURE_STATUS.test(current)) {
      for (const output of doc.querySelectorAll(CONSOLE_OUTPUT_SELECTOR)) {
        const marker = output.lastElementChild || output.textContent || '';
        if (!marker || seenConsoleTails.get(output) === marker) continue;
        const last = output.lastElementChild?.textContent || output.textContent || '';
        if (isMemoryErrorMessage(last)) {
          immediateActiveDetail = '';
          const active = currentSessionState().active;
          recoveredFailure = null;
          const formatted = formatMemoryError(last);
          activeRunFailure = active ? formatted : null;
          applyFailure(formatted, { preserveRawSubstring: cleanText(last) });
          markConsoleTailsSeen();
          return;
        }
      }
    }
  }

  function currentSessionState() {
    const statusEl = findStatusElement(doc);
    const text = cleanText(statusEl?.textContent);
    const runState = statusEl?.dataset?.neurodeskState || '';
    const exampleLoading = doc.querySelector('[data-neurodesk-examples]')?.dataset?.exampleState === 'loading';
    const progress = doc.querySelector('footer#status progress, #status progress, #progress');
    const cancel = doc.querySelector('footer#status .nd-btn-cancel, #cancelButton, #cancelBtn');
    const cancelVisible = Boolean(cancel && !cancel.hidden && !cancel.disabled);
    const indeterminate = Boolean(progress && progress.tagName === 'PROGRESS' && !progress.hasAttribute('value'));
    const midProgress = Boolean(
      progress
      && progress.tagName === 'PROGRESS'
      && Number(progress.value) > 0
      && Number(progress.value) < Number(progress.max || 1),
    );
    const verbActive = Boolean(interacted && !statusEl?.classList.contains('error') && ACTIVE_STATUS_VERB.test(text));
    const domActive = Boolean(
      exampleLoading
      || runState === 'loading'
      || runState === 'running'
      || (interacted && (cancelVisible || indeterminate || midProgress || verbActive)),
    );
    const terminalStatus = runState === 'succeeded'
      || runState === 'failed'
      || runState === 'cancelled'
      || /^(?:done|complete|completed|finished|cancelled|canceled|failed|error\b)/i.test(text);
    // Once real DOM active indicators take over or a terminal status appears, end the 250 ms click bridge immediately.
    if (immediateActiveDetail && (domActive || terminalStatus)) {
      immediateActiveDetail = '';
    }
    const active = Boolean(immediateActiveDetail || domActive);
    if (runState === 'ready' || runState === 'succeeded' || (interacted && active)) loaded = true;
    const detail = cleanText(immediateActiveDetail || (!IDLE_STATUS.test(text) ? text : '')).slice(0, 80);
    return {
      active,
      domActive,
      loaded,
      hidden: doc.visibilityState === 'hidden',
      detail: active ? detail : '',
      updatedAt: now(),
    };
  }

  function syncHeartbeat(state) {
    const shouldBeat = !unloading && (state.active || (state.loaded && !state.hidden));
    if (shouldBeat && !heartbeatTimer && view?.setInterval) {
      heartbeatTimer = view.setInterval(() => {
        if (cleanedUp || unloading) return;
        const next = currentSessionState();
        if (next.active || next.loaded) writeCheckpoint(view, key, next);
      }, HEARTBEAT_MS);
      heartbeatTimer?.unref?.();
    } else if (!shouldBeat && heartbeatTimer && view?.clearInterval) {
      view.clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function syncCheckpoint() {
    if (cleanedUp || unloading) return;
    const state = currentSessionState();
    if (state.active || state.loaded) writeCheckpoint(view, key, state);
    else clearCheckpoint(view, key);
    syncHeartbeat(state);
  }

  function markWorkflowStart(detail) {
    interacted = true;
    recoveredFailure = null;
    activeRunFailure = null;
    monitorErrorStatus = '';
    markConsoleTailsSeen();
    pruneDisconnectedLostCanvases();
    // Hold background service-worker update reloads only after the initial COI
    // bootstrap has settled as not reloading; even if clients.claim() sets a
    // controller mid-activation on a first visit, holding before coiWillReload
    // settles would suppress the initial COOP/COEP isolation reload.
    if (coiInitialSettled && view?.navigator?.serviceWorker?.controller) view?.coiHoldReloads?.();
    immediateActiveDetail = cleanText(detail).slice(0, 80);
    syncCheckpoint();
    if (reconcileTimer && view?.clearTimeout) view.clearTimeout(reconcileTimer);
    if (view?.setTimeout) {
      reconcileTimer = view.setTimeout(() => {
        immediateActiveDetail = '';
        reconcileTimer = null;
        flushActiveRunFailure();
        reconcileStatusErrorClass();
        reconcileLostCanvases();
        syncCheckpoint();
      }, 250);
      reconcileTimer?.unref?.();
    } else {
      immediateActiveDetail = '';
    }
  }

  function onChange(event) {
    const target = event.target;
    if (!target || typeof target.matches !== 'function') return;
    if (target.matches('input[type="file"]')) {
      if (target.files?.length) {
        loaded = true;
        markWorkflowStart('loading input files');
      }
      return;
    }
    if (target.matches('select[data-neurodesk-example]')) {
      if (target.value) {
        loaded = true;
        markWorkflowStart('loading example');
      }
      return;
    }
    if (!target.closest(NON_WORKFLOW_CLICK_SELECTOR)) {
      interacted = true;
      recoveredFailure = null;
    }
  }

  function onDrop(event) {
    if (!event.dataTransfer?.types?.includes('Files')) return;
    loaded = true;
    markWorkflowStart('loading dropped files');
  }

  function onClick(event) {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    if (target.closest(NON_WORKFLOW_CLICK_SELECTOR)) return;
    const actionButton = target.closest(ACTION_BUTTON_SELECTOR);
    if (actionButton && !actionButton.disabled) {
      markWorkflowStart(actionButton.textContent || 'processing');
      return;
    }
    const control = target.closest('button, input, select, label.nd-file');
    if (control) {
      interacted = true;
      recoveredFailure = null;
    }
  }

  function reconcileStatusErrorClass() {
    if (applying || !monitorErrorStatus || view?.[STATUS_MANAGED_KEY]) return;
    const statusEl = findStatusElement(doc);
    if (!statusEl) return;
    const current = cleanText(statusEl.textContent);
    if (current === monitorErrorStatus) return;
    // Raw footers that write a completion or ready label directly into textContent
    // without ProgressManager should not inherit the monitor's .error class.
    const looksLikeError = GENERIC_FAILURE_STATUS.test(current)
      || /^(?:error\b|.*failed\b)/i.test(current)
      || isMemoryErrorMessage(current);
    monitorErrorStatus = '';
    if (!looksLikeError && statusEl.classList.contains('error')) {
      applying = true;
      try {
        statusEl.classList.remove('error');
      } finally {
        applying = false;
      }
    }
  }

  function flushActiveRunFailure() {
    if (!activeRunFailure || applying || view?.[STATUS_MANAGED_KEY]) return;
    if (!currentSessionState().active) {
      const finishedFailure = activeRunFailure;
      activeRunFailure = null;
      const statusEl = findStatusElement(doc);
      const current = cleanText(statusEl?.textContent);
      if (statusEl && GENERIC_FAILURE_STATUS.test(current)) {
        applying = true;
        try {
          writeStatusError(doc, view, finishedFailure.status);
          monitorErrorStatus = finishedFailure.status;
        } finally {
          applying = false;
        }
      }
      return;
    }
    const statusEl = findStatusElement(doc);
    if (!statusEl) return;
    const current = cleanText(statusEl.textContent);
    if (current !== activeRunFailure.status && !ALREADY_EXPLAINED.test(current) && !isMemoryErrorMessage(current)) {
      applying = true;
      try {
        writeStatusError(doc, view, activeRunFailure.status);
        monitorErrorStatus = activeRunFailure.status;
      } finally {
        applying = false;
      }
    }
  }

  function onRuntimeError(event) {
    const candidate = event?.error ?? event?.reason ?? event?.message ?? event;
    if (!isMemoryErrorMessage(candidate)) return;
    const raw = errorText(candidate);
    const active = currentSessionState().active;
    recoveredFailure = null;
    immediateActiveDetail = '';
    const formatted = formatMemoryError(raw);
    activeRunFailure = active ? formatted : null;
    // Surface the OOM explanation in #statusText.error and the technical log;
    // writeStatusError leaves <progress>, Cancel and #neurodesk-run untouched.
    applyFailure(formatted, { preserveRawSubstring: raw });
    syncCheckpoint();
  }

  function isViewerCanvas(canvas) {
    if (!canvas || canvas.tagName !== 'CANVAS' || typeof canvas.matches !== 'function') return false;
    if (!canvas.matches(VIEWER_CANVAS_SELECTOR)) return false;
    if (typeof canvas.closest === 'function' && canvas.closest(NON_VIEWER_CANVAS_CONTAINER)) return false;
    return true;
  }

  function syncLostCanvasVisibilityObserver() {
    if (lostCanvases.size > 0) {
      if (!lostCanvasObserver && view?.MutationObserver && doc.body) {
        lostCanvasObserver = new view.MutationObserver(() => {
          if (applying) return;
          reconcileLostCanvases();
        });
        lostCanvasObserver.observe(doc.body, {
          subtree: true,
          attributes: true,
          attributeFilter: ['class', 'style', 'hidden'],
        });
      }
    } else if (lostCanvasObserver) {
      lostCanvasObserver.disconnect();
      lostCanvasObserver = null;
    }
  }

  function pruneDisconnectedLostCanvases() {
    for (const entry of [...lostCanvases]) {
      if (!entry.isConnected) lostCanvases.delete(entry);
    }
    syncLostCanvasVisibilityObserver();
  }

  function hasVisibleLostCanvas() {
    pruneDisconnectedLostCanvases();
    for (const entry of lostCanvases) {
      if (typeof entry.checkVisibility !== 'function' || entry.checkVisibility()) return true;
    }
    return false;
  }

  function reconcileLostCanvases() {
    if (applying || !hasVisibleLostCanvas()) return;
    if (currentSessionState().active) return;
    const formatted = formatMemoryError('WebGL context lost', { kind: 'webgl' });
    if (view?.[STATUS_MANAGED_KEY]) {
      if (!webglNoticeDispatched) {
        webglNoticeDispatched = true;
        applyFailure(formatted);
      }
      return;
    }
    const statusEl = findStatusElement(doc);
    if (!statusEl || statusEl.classList.contains('error')) return;
    recoveredFailure = null;
    applyFailure(formatted);
    syncCheckpoint();
  }

  function onWebglContextLost(event) {
    const canvas = event?.target;
    if (!isViewerCanvas(canvas)) return;
    const check = () => {
      if (cleanedUp || !canvas.isConnected) return;
      pruneDisconnectedLostCanvases();
      lostCanvases.add(canvas);
      syncLostCanvasVisibilityObserver();
      const formatted = formatMemoryError('WebGL context lost', { kind: 'webgl' });
      if (currentSessionState().active) {
        appendConsoleError(doc, formatted.log);
        return;
      }
      reconcileLostCanvases();
    };
    if (typeof queueMicrotask === 'function') queueMicrotask(check);
    else check();
  }

  function onWebglContextRestored(event) {
    const canvas = event?.target;
    pruneDisconnectedLostCanvases();
    if (!canvas || !lostCanvases.delete(canvas)) return;
    syncLostCanvasVisibilityObserver();
    if (lostCanvases.size > 0) return;
    webglNoticeDispatched = false;
    monitorErrorStatus = '';
    if (view?.[STATUS_MANAGED_KEY] && typeof view.CustomEvent === 'function') {
      view.dispatchEvent(new view.CustomEvent('neurodesk-memory-restored', { detail: { kind: 'webgl' } }));
      return;
    }
    const statusEl = findStatusElement(doc);
    const expected = formatMemoryError('WebGL context lost', { kind: 'webgl' }).status;
    if (statusEl && cleanText(statusEl.textContent) === expected) {
      applying = true;
      try {
        statusEl.classList.remove('error');
        statusEl.textContent = loaded ? 'Ready' : 'Drag and drop files';
      } finally {
        applying = false;
      }
    }
  }

  function onVisibilityChange() {
    reconcileLostCanvases();
    syncCheckpoint();
  }

  function onCleanUnload() {
    unloading = true;
    if (reconcileTimer && view?.clearTimeout) view.clearTimeout(reconcileTimer);
    if (heartbeatTimer && view?.clearInterval) view.clearInterval(heartbeatTimer);
    reconcileTimer = null;
    heartbeatTimer = null;
    clearCheckpoint(view, key);
  }

  function onPageShow() {
    if (cleanedUp || !unloading) return;
    unloading = false;
    syncCheckpoint();
  }

  const observer = view?.MutationObserver
    ? new view.MutationObserver(() => {
      if (applying) return;
      flushPendingRecovery();
      flushActiveRunFailure();
      reconcileStatusErrorClass();
      inspectLiveErrors();
      reconcileLostCanvases();
      syncCheckpoint();
    })
    : null;

  if (observer && doc.body) {
    observer.observe(doc.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['value', 'hidden', 'disabled', 'data-neurodesk-state', 'data-example-state'],
    });
  }

  doc.addEventListener('change', onChange, true);
  doc.addEventListener('drop', onDrop, true);
  doc.addEventListener('click', onClick, true);
  doc.addEventListener('webglcontextlost', onWebglContextLost, true);
  doc.addEventListener('webglcontextrestored', onWebglContextRestored, true);
  doc.addEventListener('visibilitychange', onVisibilityChange);
  view?.addEventListener?.('error', onRuntimeError);
  view?.addEventListener?.('unhandledrejection', onRuntimeError);
  view?.addEventListener?.('pagehide', onCleanUnload);
  view?.addEventListener?.('beforeunload', onCleanUnload);
  view?.addEventListener?.('pageshow', onPageShow);

  flushPendingRecovery();
  inspectLiveErrors();
  markConsoleTailsSeen();
  syncCheckpoint();

  return Object.freeze({
    destroy() {
      cleanedUp = true;
      onCleanUnload();
      observer?.disconnect();
      lostCanvasObserver?.disconnect();
      lostCanvasObserver = null;
      doc.removeEventListener('change', onChange, true);
      doc.removeEventListener('drop', onDrop, true);
      doc.removeEventListener('click', onClick, true);
      doc.removeEventListener('webglcontextlost', onWebglContextLost, true);
      doc.removeEventListener('webglcontextrestored', onWebglContextRestored, true);
      doc.removeEventListener('visibilitychange', onVisibilityChange);
      view?.removeEventListener?.('error', onRuntimeError);
      view?.removeEventListener?.('unhandledrejection', onRuntimeError);
      view?.removeEventListener?.('pagehide', onCleanUnload);
      view?.removeEventListener?.('beforeunload', onCleanUnload);
      view?.removeEventListener?.('pageshow', onPageShow);
      root.removeAttribute(GUARD_ATTR);
    },
  });
}
