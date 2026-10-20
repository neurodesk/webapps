import { filesFromDataTransferItems } from '../file-io/detectFiles.js';

// Kinds that go to an input of their own when the page has one; anything else
// is the session's main input. Recognised by extension only.
const AUXILIARY_KINDS = [
  ['gradients', /(^|\.)(bvals?|bvecs?)$/i],
  ['model', /\.(onnx|basis)$/i],
  ['protocol', /\.(toml|txt)$/i],
];
const AUXILIARY = new Set([...AUXILIARY_KINDS.map(([kind]) => kind), 'metadata']);
// An app that handles drops itself marks the region; NiiVue canvases elsewhere are taken over.
const OWNED = '[data-drop-target], .nd-file, .file-upload-zone, .file-drop, .upload-zone';
const UNDO_MS = 8000;
const HIDE_MS = 150;
const SCAN_FILE = /\.(nii(?:\.gz)?|mgz|mgh)$/i;

// The automation contract's hidden input (automation/app-automation.js) takes runs, not people's files.
const AUTOMATION_INPUT = 'neurodesk-input-transfer';
const usable = input => input.id !== AUTOMATION_INPUT && !input.disabled && !input.hasAttribute('webkitdirectory') && !input.closest('[inert], dialog:not([open])');

/** The classified file inputs that can take files now. */
export function classifiedInputs(scope) {
  return [...(scope?.querySelectorAll('input[type="file"][data-neurodesk-input]') ?? [])].filter(usable);
}

/**
 * The input a session starts from: the first classified file input that is not
 * auxiliary (a model, parameters, gradients or metadata), else the first one.
 */
export function primaryInput(scope) {
  const inputs = classifiedInputs(scope);
  return inputs.find(input => !AUXILIARY.has(input.dataset.neurodeskInput)) ?? inputs[0] ?? null;
}

/**
 * Pair dropped files with inputs: a file of an auxiliary kind goes to the first
 * input of that kind. Individual scans fill empty image slots in order;
 * DICOM slices and other files stay together at the primary input.
 */
export function routeFiles(files, inputs, primary, occupied = new Set()) {
  const plan = new Map();
  const images = primary?.dataset.neurodeskInput === 'image'
    ? inputs.filter(input => input.dataset.neurodeskInput === 'image')
    : [];
  const empty = images.filter(input => !occupied.has(input) && !input.files?.length);
  let replacement = 0;
  for (const file of files) {
    const kind = AUXILIARY_KINDS.find(([, pattern]) => pattern.test(file.name))?.[0];
    let input = (kind && inputs.find(candidate => candidate.dataset.neurodeskInput === kind)) || primary;
    if (!kind && images.length > 1 && SCAN_FILE.test(file.name)) {
      input = empty.shift() ?? images[replacement++ % images.length];
    }
    if (input) plan.set(input, [...(plan.get(input) ?? []), file]);
  }
  return [...plan];
}

/**
 * Put files on a file input and let the app's own change handler load them.
 * `replace` first fires `nd-replace` on the input, so an app whose input adds
 * to a file list (marked `data-appends`) can clear it. Such an app fires
 * `nd-files` (detail.files) on the input whenever its list changes otherwise.
 */
export function deliverFiles(input, files, { replace = false } = {}) {
  if (replace) input.dispatchEvent(new CustomEvent('nd-replace', { bubbles: true }));
  const transfer = new DataTransfer();
  for (const file of files) transfer.items.add(file);
  input.files = transfer.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * Make the whole window a drop target. App drop handlers run first; a drop none
 * of them took (and any drop on a NiiVue canvas outside an app-owned region)
 * replaces the session through the app's normal inputs, with Undo in the
 * status bar to bring the previous inputs back.
 */
export function bindPageDrop(doc = globalThis.document) {
  // The shell and the example selector both install it; their module copies differ, so mark the document.
  const root = doc.documentElement;
  if (root.hasAttribute('data-nd-page-drop')) return null;
  root.setAttribute('data-nd-page-drop', '');
  const view = doc.defaultView;
  let previous = new WeakMap();
  const occupied = new WeakSet();
  const replacing = new WeakSet();
  let generation = 0;
  const overlay = doc.createElement('div');
  overlay.className = 'nd-drop-overlay';
  overlay.hidden = true;
  overlay.innerHTML = '<p>Drop to open</p>';
  doc.body.append(overlay);
  let undoTimer;
  let hideTimer;

  const carriesFiles = event => event.dataTransfer?.types?.includes('Files');
  // NiiVue loads canvas drops itself, behind the app; capture takes those first. A viewer in a
  // shadow root (FreeBrowse) retargets its canvas's events to the host, so read the composed path.
  const path = event => event.composedPath?.() ?? [event.target];
  const unownedCanvas = event => path(event)[0] instanceof view.HTMLCanvasElement
    && !path(event).some(node => node instanceof view.Element && node.matches(OWNED));
  // Capture handles unowned canvases; bubble handles whatever no app handler took.
  const ours = event => (event.eventPhase === view.Event.CAPTURING_PHASE ? unownedCanvas(event) : !event.defaultPrevented && !unownedCanvas(event));

  // dragover repeats while the pointer is in the window, so the overlay hides once it stops.
  function show() {
    overlay.hidden = false;
    view.clearTimeout(hideTimer);
    hideTimer = view.setTimeout(() => { overlay.hidden = true; }, HIDE_MS);
  }

  function over(event) {
    if (!carriesFiles(event)) return;
    if (!ours(event)) {
      // A bubbling dragover some app handler took means that region owns the drop.
      if (event.defaultPrevented && !unownedCanvas(event)) overlay.hidden = true;
      return;
    }
    // Look the input up once per drag; dragover repeats every few milliseconds.
    if (overlay.hidden && !primaryInput(doc)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    show();
  }

  function replace(input, files) {
    replacing.add(input);
    deliverFiles(input, files, { replace: true });
    replacing.delete(input);
  }

  function withdrawUndo() {
    doc.querySelector('.nd-status-undo')?.remove();
    view.clearTimeout(undoTimer);
  }

  function supersede() {
    generation += 1;
    withdrawUndo();
  }

  function offerUndo(snapshot) {
    withdrawUndo();
    const status = doc.querySelector('footer#status, #status');
    if (!status || !snapshot.length) return;
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'nd-status-undo';
    button.textContent = 'Undo';
    button.addEventListener('click', () => {
      supersede();
      for (const [input, files] of snapshot) replace(input, files);
    });
    status.append(button);
    undoTimer = view.setTimeout(() => button.remove(), UNDO_MS);
  }

  function drop(event) {
    if (!carriesFiles(event) || !ours(event)) return;
    // Even without an input to take them, a dropped file must not navigate away from the session.
    event.preventDefault();
    const primary = primaryInput(doc);
    if (!primary) return;
    event.stopPropagation();
    overlay.hidden = true;
    const current = ++generation;
    withdrawUndo();
    const inputs = [...doc.querySelectorAll('input[type="file"][data-neurodesk-input]')].filter(usable);
    filesFromDataTransferItems(event.dataTransfer.items).then(files => {
      if (current !== generation || !files.length || !primary.isConnected || !usable(primary)) return;
      const plan = routeFiles(files, inputs.filter(input => input.isConnected && usable(input)), primary,
        new Set(inputs.filter(input => occupied.has(input))));
      const snapshot = plan.filter(([input]) => previous.has(input)).map(([input]) => [input, previous.get(input)]);
      for (const [input, group] of plan) replace(input, group);
      offerUndo(snapshot);
    }).catch(error => {
      if (current !== generation) return;
      const text = doc.querySelector('#statusText');
      if (text) text.textContent = `Could not read the dropped files: ${error.message}`;
    });
  }

  // Remember each input's files so a later drop can be undone; an appending input keeps its whole list.
  function remember(event) {
    const input = event.target;
    if (!(input instanceof view.HTMLInputElement) || input.type !== 'file' || !input.files?.length) return;
    if (!replacing.has(input)) supersede();
    const kept = input.hasAttribute('data-appends') && !replacing.has(input) ? previous.get(input) ?? [] : [];
    previous.set(input, [...kept, ...input.files]);
    occupied.add(input);
  }

  // Native input owners report their loaded list; nd-file-field emits a different, promise-valued contract.
  function sync(event) {
    const input = event.target;
    if (!(input instanceof view.HTMLInputElement) || input.type !== 'file' || !input.hasAttribute('data-neurodesk-input')) return;
    const files = event.detail?.files;
    if (!files?.[Symbol.iterator]) return;
    previous.set(input, [...files]);
    if (previous.get(input).length) occupied.add(input);
    else occupied.delete(input);
  }

  // Discard earlier picks when an example starts; its input owners can report newly loaded files.
  function forget(event) {
    if (!['loading', 'ready'].includes(event.detail?.state)) return;
    supersede();
    if (event.detail.state === 'loading') previous = new WeakMap();
  }

  function startingDrop(event) {
    if (carriesFiles(event)) supersede();
  }

  const listeners = [
    [view, 'dragover', over, true],
    [view, 'dragover', over, false],
    [view, 'drop', startingDrop, true],
    [view, 'drop', drop, true],
    [view, 'drop', drop, false],
    [doc, 'change', remember, true],
    [doc, 'nd-files', sync, false],
    [doc, 'nd-example-status', forget, false],
  ];
  for (const [target, type, listener, capture] of listeners) target.addEventListener(type, listener, capture);
  return {
    destroy() {
      supersede();
      for (const [target, type, listener, capture] of listeners) target.removeEventListener(type, listener, capture);
      view.clearTimeout(undoTimer);
      view.clearTimeout(hideTimer);
      overlay.remove();
      root.removeAttribute('data-nd-page-drop');
    },
  };
}
