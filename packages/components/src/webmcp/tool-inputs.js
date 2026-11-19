import { filesFromDataTransferItems } from '../file-io/detectFiles.js';

// The automation contract's hidden input (automation/app-automation.js) and the agent's own dialogs are
// not inputs the person loads the app through.
const TRANSFER = 'neurodesk-input-transfer';
const PROMPT = '#neurodeskAgentPrompt';
// The agent's dialogs, the shared application bar and the shell's own About, Cite and Privacy dialogs
// are not the workspace: using them changes nothing the tools hold.
const OUTSIDE = `${PROMPT}, .nd-app-bar, .nd-app-utility-bar, dialog.nd-app-dialog`;
// Opening a file chooser or the example selector loads nothing until it answers with a change or an
// example status event.
const LOADERS = 'input[type="file"], .nd-file, nd-file-field, nd-example-selector';
// A wheel turned over one of these changes what it shows; anywhere else it scrolls the page.
const WHEEL_TARGETS = 'canvas, input, select, textarea, [contenteditable=""], [contenteditable="true"]';
const IGNORED_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Tab']);
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', ' ']);
const INTERACTIONS = ['pointerdown', 'pointerup', 'wheel', 'keydown', 'input', 'change', 'paste', 'drop'];
const CLASSIFIED = 'input[type="file"][data-neurodesk-input]';
const RUNS_KEPT = 64;
// takeHandoff (handoff/index.js) leaves what it received here as well, for a tracker that starts later.
export const RECEIVED_HANDOFF = Symbol.for('neurodesk.handoff');
const describe = files => files.map(file => ({ name: file.name, bytes: file.size }));
const changed = () => Object.assign(new Error('The person used the page while this was pending, so nothing is held. Ask again if they still want it.'), { code: 'EXAMINATION_CHANGED' });
const isElement = node => node?.nodeType === 1;
const isClassified = node => isElement(node) && node.matches(CLASSIFIED) && node.id !== TRANSFER && !node.closest(PROMPT);

/**
 * What one trusted event does to the examination, or null when it does not count. This is the one
 * place that decides which of the person's interactions start a new examination:
 *
 *   'pick'    a pick in a classified file input, which the tracker records as a page entry
 *   'drop'    files dropped on the page
 *   'loader'  opening a file chooser or the example selector, which loads nothing until it answers
 *   'unseen'  anything else in the workspace: a control, the viewer, typing, a drag, a wheel turned
 *             over the viewer or a control, any action inside a shadow root or a same-origin frame
 *
 * Not counted: the agent's dialogs, the shared application bar and the shell's own dialogs, page
 * scrolling (a wheel elsewhere, a scroll key with nothing focused), modifier keys and Tab, pointer
 * movement without a press, and focus changes. A cross-origin frame's events never reach the page.
 */
export function interactionEffect(event, doc) {
  const path = event.composedPath().filter(isElement);
  if (path.some(node => node.matches(OUTSIDE))) return null;
  const [target] = path;
  // Inside a shadow root or a frame the tracker cannot list what the action changed.
  const inPage = !target || target.getRootNode() === doc;
  const owner = target?.ownerDocument ?? doc;
  const scroller = !target || target === owner.body || target === owner.documentElement;
  if (event.type === 'keydown') {
    if (IGNORED_KEYS.has(event.key)) return null;
    if (SCROLL_KEYS.has(event.key) && scroller) return null;
  }
  if (event.type === 'wheel' && !path.some(node => node.matches(WHEEL_TARGETS))) return null;
  if (event.type === 'drop') return event.dataTransfer?.types?.includes('Files') && inPage ? 'drop' : 'unseen';
  if (target?.matches('input[type="file"]') && (event.type === 'change' || event.type === 'input')) {
    // A file chooser fires input and then change; change does not leave a shadow root, input does.
    if (inPage && event.type === 'input') return null;
    return isClassified(target) && owner === doc ? 'pick' : 'unseen';
  }
  // A control's change follows the keydown or pointerup already seen, and can come later, on blur.
  if (event.type === 'change') return null;
  if (inPage && path.some(node => node.matches(LOADERS) || (node.localName === 'label' && node.control?.type === 'file'))) return 'loader';
  return 'unseen';
}

/**
 * What the WebMCP tools hold for one examination, and the files the page received.
 *
 * An examination lasts while the person leaves the workspace alone: interactionEffect decides which
 * of their actions start a new one, and so do an example picked in the page, a handoff and the app's
 * `automation.reset()`. A new examination holds no files, the runs the tools started before it are
 * stale, and a prompt or download that answers afterwards commits nothing. No list of app events
 * decides this, so an app cannot change what the page shows without ending the examination.
 *
 * The page's entries record what its classified inputs (`data-neurodesk-input`, in the light DOM or an
 * open shadow root) received as each change, input or `nd-files` event arrived, and files dropped or
 * handed to the page that reach no input. They say what the page was given, not what it shows now:
 * the app may have refused a file or loaded another through its own code, so the tools ask the person
 * before using an entry. A run or viewer load the tools start clears them (`toolLoaded`).
 * `pageMayHoldOtherInputs` turns true once the person has done something whose effect the tracker
 * cannot see.
 *
 * @param {{ doc: Document, automation: { running(): boolean, adopt(role: string, files: File[]): Promise<unknown> }, isPerson?: (event: Event) => boolean }} options
 */
export function createToolInputs({ doc, automation, isPerson = event => event.isTrusted }) {
  const view = doc.defaultView;
  let examination = { id: 0, held: new Map() };
  const runs = new Map();
  let unseen = false;
  let pageFiles = new WeakMap();
  // Classified inputs inside shadow roots, which a query of the document does not find.
  const shadowInputs = new Set();
  const received = new Map();
  let pageExample = null;
  let loads = 0;

  const classified = () => [
    ...[...doc.querySelectorAll(CLASSIFIED)].filter(isClassified),
    ...[...shadowInputs].filter(input => input.isConnected),
  ];
  const key = (input, index) => input.id || `input-${index + 1}`;
  const label = input => input.getAttribute('aria-label') || input.labels?.[0]?.textContent.trim() || input.dataset.neurodeskInput;
  const running = () => Boolean(automation.running?.());

  function begin() {
    examination = { id: examination.id + 1, held: new Map() };
    pageExample = null;
  }

  function record(input, files) {
    if (input.getRootNode() !== doc) shadowInputs.add(input);
    pageFiles.set(input, files);
    received.clear();
    loads += 1;
  }

  // Files the page held before this module loaded count as received now.
  for (const input of classified()) if (input.files?.length) record(input, [...input.files]);
  const handedOff = view[RECEIVED_HANDOFF];
  if (handedOff?.files?.length) received.set('handoff', { label: `Sent from ${handedOff.source?.title ?? 'another app'}`, files: handedOff.files });

  function unseenChange() {
    begin();
    unseen = true;
  }

  function personDrop(event) {
    begin();
    if (running()) {
      unseen = true;
      return;
    }
    // The shell or the app may deliver the drop through a classified input, which records it instead.
    const at = examination;
    const before = loads;
    filesFromDataTransferItems(event.dataTransfer.items).then(files => {
      if (examination === at && loads === before && files.length) received.set('drop', { label: 'Files dropped on the page', files });
    }).catch(() => {
      if (examination === at) unseen = true;
    });
  }

  function interaction(event) {
    if (!isPerson(event)) return;
    const effect = interactionEffect(event, doc);
    if (effect === 'loader') begin();
    else if (effect === 'drop') personDrop(event);
    else if (effect === 'unseen') unseenChange();
    else if (effect === 'pick') {
      const [target] = event.composedPath();
      // A pick made while a run is going may be ignored by the busy app.
      if (running()) return unseenChange();
      begin();
      record(target, [...(target.files ?? [])]);
    }
  }

  // Same-origin frames are part of the workspace; the browser hides a cross-origin frame's events.
  const watched = new WeakSet();
  function watch(win) {
    if (watched.has(win)) return;
    watched.add(win);
    for (const type of INTERACTIONS) win.addEventListener(type, interaction, true);
  }
  function watchFrames(frameDoc) {
    if (watched.has(frameDoc)) return;
    watched.add(frameDoc);
    frameDoc.addEventListener('load', event => {
      if (event.target?.localName === 'iframe') watchFrame(event.target);
    }, true);
    for (const frame of frameDoc.querySelectorAll('iframe')) watchFrame(frame);
  }
  function watchFrame(frame) {
    let frameDoc;
    try {
      frameDoc = frame.contentWindow?.document;
    } catch {
      return;
    }
    if (!frameDoc) return;
    watch(frame.contentWindow);
    watchFrames(frameDoc);
  }
  watch(view);
  watchFrames(doc);

  // Loads no person made: an app filling its own inputs, the shell delivering a drop or a handoff, a run.
  doc.addEventListener('change', event => {
    if (!isPerson(event) && isClassified(event.target)) record(event.target, [...(event.target.files ?? [])]);
  }, true);
  doc.addEventListener('input', event => {
    const [target] = event.composedPath();
    if (!isPerson(event) && isClassified(target) && target.getRootNode() !== doc) record(target, [...(target.files ?? [])]);
  }, true);
  doc.addEventListener('nd-files', event => {
    if (isClassified(event.target) && event.detail?.files?.[Symbol.iterator]) record(event.target, [...event.detail.files]);
  });
  doc.addEventListener('nd-example-status', event => {
    if (event.detail?.state === 'loading') begin();
    if (event.detail?.state === 'ready') pageExample = event.detail.exampleId ?? null;
  });
  doc.addEventListener('nd-handoff', event => {
    begin();
    const files = event.detail?.files;
    if (files?.length) received.set('handoff', { label: `Sent from ${event.detail.source?.title ?? 'another app'}`, files });
  });
  view.addEventListener('neurodesk-automation-reset', begin);

  const entries = () => [
    ...classified().map((input, index) => ({ input: key(input, index), kind: input.dataset.neurodeskInput, label: label(input), files: pageFiles.get(input) })),
    ...[...received].map(([name, entry]) => ({ input: `received:${name}`, ...entry })),
  ].filter(entry => entry.files?.length);

  return {
    /** The current examination, to hand back once an asynchronous step finishes. */
    examination: () => examination,
    held: () => Object.fromEntries([...examination.held].map(([role, files]) => [role, describe(files)])),
    page: () => entries().map(({ files, ...entry }) => ({ ...entry, files: describe(files) })),
    /** Whether the person has done something in the page whose effect the tracker cannot list. */
    pageMayHoldOtherInputs: () => unseen,
    /** The example the person picked with the page's own example selector, until anything changes the page. */
    pageExample: () => pageExample,
    /** The files a page entry lists and its label. */
    pageEntry(inputKey) {
      const entry = entries().find(candidate => candidate.input === inputKey);
      if (!entry) throw new Error(`No files are loaded in the page input ${inputKey}`);
      return { label: entry.label, files: entry.files };
    },
    /** Forgets the page's entries and example: a run or viewer load the tools start may change what the page shows. */
    toolLoaded() {
      pageFiles = new WeakMap();
      received.clear();
      pageExample = null;
    },
    /** Holds `files` for one role, beside the roles already held, if the examination is still `from`. */
    hold(from, role, files) {
      if (from !== examination) throw changed();
      examination.held.set(role, files);
    },
    /** Holds `files` (role to files) as the whole held set, if the examination is still `from`. */
    replace(from, files) {
      if (from !== examination) throw changed();
      examination.held = new Map(files);
    },
    /** Hands the held files for every file role to the app's automation for the next run, which takes them; a role the tools do not hold gets none. */
    async stage(from, roles = [...examination.held.keys()]) {
      if (from !== examination) throw changed();
      for (const role of roles) {
        await automation.adopt(role, examination.held.get(role) ?? []);
        if (from !== examination) throw changed();
      }
    },
    /** Records that a run the tools started belongs to the examination `from`. */
    claim(from, runId) {
      runs.set(runId, from.id);
      if (runs.size > RUNS_KEPT) runs.delete(runs.keys().next().value);
    },
    /** 'current' for a run the tools started in this examination, 'stale' for one before it, else 'unknown'. */
    runOf(runId) {
      if (!runs.has(runId)) return 'unknown';
      return runs.get(runId) === examination.id ? 'current' : 'stale';
    },
  };
}
