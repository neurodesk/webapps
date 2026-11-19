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
// The person's actions the tools observe. site/theme.js, the first script of every page, listens for
// these on window in the capture phase and hands each to the tools, so no listener of the page or the
// shell runs before it; a page without it gets the same listeners when the tools start.
export const INTERACTIONS = ['pointerdown', 'pointerup', 'wheel', 'keydown', 'input', 'change', 'paste', 'dragenter', 'dragover', 'drop'];
export const PERSON_INPUT = Symbol.for('neurodesk.personInput');
// Events the page's own code sends, which interactionEffect also judges.
const PAGE_EVENTS = ['nd-files', 'nd-example-status', 'nd-handoff'];
const CLASSIFIED = 'input[type="file"][data-neurodesk-input]';
const RUNS_KEPT = 64;
// takeHandoff (handoff/index.js) leaves what it received here as well, for a tracker that starts later.
export const RECEIVED_HANDOFF = Symbol.for('neurodesk.handoff');
const describe = files => files.map(file => ({ name: file.name, bytes: file.size }));
const changed = () => Object.assign(new Error('The person used the page while this was pending, so nothing is held. Ask again if they still want it.'), { code: 'EXAMINATION_CHANGED' });
const isElement = node => node?.nodeType === 1;
const isClassified = node => isElement(node) && node.matches(CLASSIFIED) && node.id !== TRANSFER && !node.closest(PROMPT);

/**
 * What one event does to the agent's examination. This is the one place that decides it. Nothing the
 * tools disclose depends on telling an 'end' from a 'touch': after either, the agent gets files, a
 * report or an output only from what the person allowed in a dialog that named them.
 *
 *   'end'     a convenience that spares the person a dialog with no point: the examination is over, its
 *             held files are released and its runs become stale. A pick in any file input, files
 *             dropped on the page, the page's example selector starting a load, a handoff and the app's
 *             `automation.reset()`. Once the person has touched the examination, also a remove or
 *             clear the app reports with `nd-files`.
 *   'touch'   the person used the workspace: a press, typing, a paste, a drag over the page, a wheel
 *             turned over the viewer or a control, any action inside a shadow root or a same-origin
 *             frame, and a watched frame navigating. The held files and the latest run wait until the
 *             person lets the agent continue with them.
 *   'loader'  a touch that opens a file chooser or the example selector, whose result the tracker sees
 *             when it answers.
 *   null      not counted: the agent's dialogs, the shared application bar and the shell's own
 *             dialogs, page scrolling (a wheel elsewhere, a scroll key with nothing focused), modifier
 *             keys and Tab, pointer movement without a press, and focus changes. A cross-origin frame's
 *             events never reach the page.
 *
 * `person` says the person sent the event (a trusted event) and `touched` that the examination is touched.
 */
export function interactionEffect(event, doc, { person = event.isTrusted, touched = false } = {}) {
  const path = event.composedPath().filter(isElement);
  // The agent's own file dialog reports its files with nd-files too.
  if (path.some(node => node.matches(OUTSIDE))) return null;
  if (event.type === 'nd-example-status') return event.detail?.state === 'loading' ? 'end' : null;
  if (event.type === 'nd-handoff' || event.type === 'neurodesk-automation-reset') return 'end';
  if (event.type === 'nd-files') return touched ? 'end' : null;
  if (!person) return null;
  const [target] = path;
  const inPage = !target || target.getRootNode() === doc;
  const owner = target?.ownerDocument ?? doc;
  const scroller = !target || target === owner.body || target === owner.documentElement;
  if (event.type === 'keydown') {
    if (IGNORED_KEYS.has(event.key)) return null;
    if (SCROLL_KEYS.has(event.key) && scroller) return null;
  }
  if (event.type === 'wheel' && !path.some(node => node.matches(WHEEL_TARGETS))) return null;
  if (event.type === 'drop') return event.dataTransfer?.types?.includes('Files') ? 'end' : 'touch';
  if (target?.matches('input[type="file"]') && (event.type === 'change' || event.type === 'input')) {
    // A file chooser fires input and then change; change does not leave a shadow root, input does.
    return inPage && event.type === 'input' ? null : 'end';
  }
  // A control's change follows the keydown or pointerup already seen, and can come later, on blur.
  if (event.type === 'change') return null;
  if (inPage && path.some(node => node.matches(LOADERS) || (node.localName === 'label' && node.control?.type === 'file'))) return 'loader';
  return 'touch';
}

/**
 * What the WebMCP tools hold for one examination, and the files the page received.
 *
 * interactionEffect decides what each of the person's actions and each page event does. A touch keeps
 * the held files and the latest run, but the tools use them again only once the person allows it
 * (`touched`, `resumable`, `resume`); an end starts a new examination that holds no files, in which the
 * earlier runs are stale. Every counted event also starts a new turn: a tool call belongs to the turn
 * it began in (webmcp/tools.js), and the turn's signal aborts its prompts, fetches and waits.
 *
 * Each run the tools start is recorded with the files it ran on (`claim`) and, once it ends, with the
 * snapshot it ended with (`settle`): after a touch the agent gets that record, which the dialog named,
 * never what the page answers later.
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
  let examination = { id: 1, held: new Map(), touched: false };
  // runId → { examination, operation, startedAt, inputs: [{ role, name, bytes }], settled: snapshot | null }
  let turn = { examination, controller: new AbortController() };
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

  function nextTurn() {
    turn.controller.abort();
    turn = { examination, controller: new AbortController() };
    pageExample = null;
  }

  function touch() {
    examination.touched = true;
    nextTurn();
  }

  function end() {
    examination = { id: examination.id + 1, held: new Map(), touched: false };
    nextTurn();
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

  function personDrop(event) {
    // The shell or the app may deliver the drop through a classified input, which records it instead.
    const at = examination;
    const before = loads;
    filesFromDataTransferItems(event.dataTransfer.items).then(files => {
      if (examination === at && loads === before && files.length) received.set('drop', { label: 'Files dropped on the page', files });
    }).catch(() => {
      if (examination === at) unseen = true;
    });
  }

  // What the page received from an event, recorded after the examination took the event's effect.
  function recordLoad(event, person, effect) {
    const [target] = event.composedPath();
    if (event.type === 'nd-files') {
      if (isClassified(event.target) && event.detail?.files?.[Symbol.iterator]) record(event.target, [...event.detail.files]);
    } else if (event.type === 'nd-example-status') {
      if (event.detail?.state === 'ready') pageExample = event.detail.exampleId ?? null;
    } else if (event.type === 'nd-handoff') {
      const files = event.detail?.files;
      if (files?.length) received.set('handoff', { label: `Sent from ${event.detail.source?.title ?? 'another app'}`, files });
    } else if (!person) {
      // Loads no person made: an app filling its own inputs, the shell delivering a drop or a handoff, a run.
      if (event.type === 'change' && isClassified(target)) record(target, [...(target.files ?? [])]);
      if (event.type === 'input' && isClassified(target) && target.getRootNode() !== doc) record(target, [...(target.files ?? [])]);
    } else if (effect === 'end' && event.type === 'drop') {
      const inPage = !isElement(target) || target.getRootNode() === doc;
      if (inPage && !running()) personDrop(event);
      else unseen = true;
    } else if (effect === 'end') {
      // A pick made while a run is going may be ignored by the busy app.
      if (isClassified(target) && target.ownerDocument === doc && !running()) record(target, [...(target.files ?? [])]);
      else unseen = true;
    } else if (effect === 'touch') {
      unseen = true;
    }
  }

  function observe(event) {
    const person = isPerson(event);
    const effect = interactionEffect(event, doc, { person, touched: examination.touched });
    if (effect === 'end') end();
    else if (effect) touch();
    recordLoad(event, person, effect);
  }

  // Every composed event of the page, from inside shadow roots too, passes window first. The shell's
  // first script listens there before anything else (PERSON_INPUT); without it the tools do.
  const hub = view[PERSON_INPUT];
  if (hub) hub.add(observe);
  else for (const type of INTERACTIONS) view.addEventListener(type, observe, true);

  // Same-origin frames are part of the workspace, at any depth and inside open shadow roots; the
  // browser hides a cross-origin frame's events. Their windows get the same listeners. A frame's new
  // document is watched from the first animation frame after it exists, and the navigation itself
  // touches the examination, so the person cannot act in it unseen. A shadow root attached to an
  // element that is neither inserted later nor a custom element defined later is not found.
  const documents = new WeakSet();
  const trees = new WeakSet();
  const followed = new WeakSet();
  function watchDocument(target, frame = null) {
    if (documents.has(target)) return;
    documents.add(target);
    const targetView = target.defaultView;
    if (frame && targetView) {
      for (const type of INTERACTIONS) targetView.addEventListener(type, observe, true);
      targetView.addEventListener('pagehide', () => {
        // A frame being removed, or leaving the empty document it starts with, is no navigation of the person's.
        if (frame.isConnected && target.URL !== 'about:blank') touch();
        follow(frame);
      });
    }
    watchTree(target);
  }
  // Watches each document the frame shows from the animation frame after it appears until it has loaded.
  function follow(frame) {
    if (followed.has(frame)) return;
    followed.add(frame);
    const step = () => {
      let frameDoc;
      try {
        frameDoc = frame.contentDocument;
      } catch {
        frameDoc = null;
      }
      if (frameDoc) watchDocument(frameDoc, frame);
      if (!frame.isConnected || !frameDoc || frameDoc.readyState === 'complete') followed.delete(frame);
      else if (view.requestAnimationFrame) view.requestAnimationFrame(step);
      else view.setTimeout(step, 16);
    };
    step();
  }
  function watchTree(root) {
    if (trees.has(root)) return;
    trees.add(root);
    const rootView = root.defaultView ?? root.ownerDocument.defaultView;
    root.addEventListener('load', event => {
      if (event.target?.localName === 'iframe') watchFrame(event.target);
    }, true);
    new rootView.MutationObserver(mutations => {
      for (const mutation of mutations) for (const node of mutation.addedNodes) if (isElement(node)) scan(node);
    }).observe(root, { childList: true, subtree: true });
    scan(root);
  }
  function scan(node) {
    for (const element of [...(isElement(node) ? [node] : []), ...node.querySelectorAll('*')]) {
      if (element.localName === 'iframe') watchFrame(element);
      if (element.shadowRoot) watchTree(element.shadowRoot);
      else if (element.localName.includes('-')) {
        const registry = element.ownerDocument.defaultView?.customElements;
        if (registry && !registry.get(element.localName)) {
          registry.whenDefined(element.localName).then(() => {
            if (element.shadowRoot) watchTree(element.shadowRoot);
          });
        }
      }
    }
  }
  function watchFrame(frame) {
    follow(frame);
  }
  watchDocument(doc);
  for (const type of PAGE_EVENTS) doc.addEventListener(type, observe);
  view.addEventListener('neurodesk-automation-reset', observe);

  const entries = () => [
    ...classified().map((input, index) => ({ input: key(input, index), kind: input.dataset.neurodeskInput, label: label(input), files: pageFiles.get(input) })),
    ...[...received].map(([name, entry]) => ({ input: `received:${name}`, ...entry })),
  ].filter(entry => entry.files?.length);

  const bound = from => {
    if (from !== turn) throw changed();
  };

  return {
    /** The current turn, which every counted event replaces: a call hands it back to show it is still current. */
    turn: () => turn,
    /** Whether the person has used the workspace since the agent last held files or the person let it continue. */
    touched: () => examination.touched,
    held: () => Object.fromEntries([...examination.held].map(([role, files]) => [role, describe(files)])),
    /** What letting the agent continue would hand back: the held files by role, and the examination's latest run with the files it ran on. */
    resumable() {
      const files = [...examination.held].flatMap(([role, held]) => held.map(file => ({ role, name: file.name, bytes: file.size })));
      const latest = [...runs].reverse().find(([, run]) => run.examination === examination.id);
      if (!latest) return { files, run: null };
      const [runId, { operation, startedAt, inputs }] = latest;
      return { files, run: { runId, operation, startedAt, inputs: structuredClone(inputs) } };
    },
    /** The person let the agent continue with what `resumable` named: the held files and the latest run serve its calls again; the examination's earlier runs stay withheld. */
    resume(from) {
      bound(from);
      const latest = [...runs].reverse().find(([, run]) => run.examination === examination.id);
      for (const [runId, run] of runs) if (run.examination === examination.id && runId !== latest?.[0]) run.examination = 0;
      examination.touched = false;
    },
    /** The person declined to let the agent continue: the examination ends. */
    release(from) {
      bound(from);
      end();
    },
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
    /** Holds `files` for one role, beside the roles already held, if the turn is still `from`. */
    hold(from, role, files) {
      bound(from);
      examination.held.set(role, files);
    },
    /** Holds `files` (role to files) as the whole held set, if the turn is still `from`. */
    replace(from, files) {
      bound(from);
      examination.held = new Map(files);
    },
    /** Hands the held files for every file role to the app's automation for the next run, which takes them; a role the tools do not hold gets none. */
    async stage(from, roles = [...examination.held.keys()]) {
      bound(from);
      for (const role of roles) {
        await automation.adopt(role, examination.held.get(role) ?? []);
        bound(from);
      }
    },
    /** Records that a run the tools started, of `operation` on the files held in the turn `from`, belongs to that turn's examination. */
    claim(from, runId, operation) {
      const files = [...from.examination.held].flatMap(([role, held]) => held.map(file => ({ role, name: file.name, bytes: file.size })));
      runs.set(runId, { examination: from.examination.id, operation, startedAt: Date.now(), inputs: files, settled: null });
      if (runs.size > RUNS_KEPT) runs.delete(runs.keys().next().value);
    },
    /** Records the snapshot a run the tools started ended with, the first time the tools see it ended. */
    settle(snapshot) {
      const run = runs.get(snapshot.runId);
      if (run && !run.settled) run.settled = structuredClone(snapshot);
    },
    /** The snapshot a run ended with, as first recorded, or null while it has not been seen to end. */
    settled(runId) {
      const snapshot = runs.get(runId)?.settled;
      return snapshot ? structuredClone(snapshot) : null;
    },
    /** 'current' for a run the tools started in this examination, 'stale' for one before it, else 'unknown'. */
    runOf(runId) {
      if (!runs.has(runId)) return 'unknown';
      return runs.get(runId).examination === examination.id ? 'current' : 'stale';
    },
  };
}
