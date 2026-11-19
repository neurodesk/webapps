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
const IGNORED_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Tab']);
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', ' ']);
const INTERACTIONS = ['pointerup', 'keydown', 'input', 'change', 'paste', 'drop'];
const RUNS_KEPT = 64;
// takeHandoff (handoff/index.js) leaves what it received here as well, for a tracker that starts later.
export const RECEIVED_HANDOFF = Symbol.for('neurodesk.handoff');
const describe = files => files.map(file => ({ name: file.name, bytes: file.size }));
const changed = () => Object.assign(new Error('The person used the page while this was pending, so nothing is held. Ask again if they still want it.'), { code: 'EXAMINATION_CHANGED' });

/**
 * What the WebMCP tools hold for one examination, and what the person has loaded into the page.
 *
 * An examination lasts while the person leaves the workspace alone. Any trusted interaction in it
 * (a control, the viewer, a file chooser, a drop, typing; not the agent's dialogs, the shared bar or
 * scrolling) starts a new one, as do an example picked in the page, a handoff and the app's
 * `automation.reset()`. A new examination holds no files, the runs the tools started before it are
 * stale, and a prompt or download that answers afterwards commits nothing. No list of app events
 * decides this, so an app cannot change what the page shows without ending the examination.
 *
 * The page's own loads are recorded per classified input (`data-neurodesk-input`) as each change or
 * `nd-files` event arrives, and files dropped or handed to the page that reach no input are kept as
 * received entries. An entry is current while the person has done nothing else in the page since it
 * was loaded; a pick made while a run is going is not recorded, since the busy app may ignore it.
 * `pageMayHoldOtherInputs` turns true once the person has done something whose effect the tracker
 * cannot see.
 *
 * @param {{ doc: Document, automation: { running(): boolean, adopt(role: string, files: File[]): Promise<unknown> }, isPerson?: (event: Event) => boolean }} options
 */
export function createToolInputs({ doc, automation, isPerson = event => event.isTrusted }) {
  const view = doc.defaultView;
  let examination = { id: 0, held: new Map() };
  const runs = new Map();
  // Each entry is stamped with the epoch it was loaded in; anything that may change the page moves the epoch on.
  let epoch = 0;
  let unseen = false;
  const pageFiles = new WeakMap();
  const received = new Map();
  let pageExample = null;
  let loads = 0;

  const classified = () => [...doc.querySelectorAll('input[type="file"][data-neurodesk-input]')]
    .filter(input => input.id !== TRANSFER && !input.closest(PROMPT));
  const isClassified = node => node?.matches?.('input[type="file"][data-neurodesk-input]') && node.id !== TRANSFER;
  const key = (input, index) => input.id || `input-${index + 1}`;
  const label = input => input.getAttribute('aria-label') || input.labels?.[0]?.textContent.trim() || input.dataset.neurodeskInput;
  const running = () => Boolean(automation.running?.());

  function begin() {
    examination = { id: examination.id + 1, held: new Map() };
  }

  function record(input, files) {
    pageFiles.set(input, { files, at: epoch });
    received.clear();
    loads += 1;
  }

  function receive(name, entryLabel, files) {
    received.set(name, { label: entryLabel, files, at: epoch });
  }

  // Files the page held before this module loaded count as loaded now.
  for (const input of classified()) if (input.files?.length) record(input, [...input.files]);
  const handedOff = view[RECEIVED_HANDOFF];
  if (handedOff?.files?.length) receive('handoff', `Sent from ${handedOff.source?.title ?? 'another app'}`, handedOff.files);

  function unseenChange() {
    begin();
    epoch += 1;
    unseen = true;
  }

  function personDrop(event) {
    begin();
    epoch += 1;
    if (running()) {
      unseen = true;
      return;
    }
    // The shell or the app may deliver the drop through a classified input, which records it instead.
    const at = epoch;
    const before = loads;
    filesFromDataTransferItems(event.dataTransfer.items).then(files => {
      if (epoch === at && loads === before && files.length) receive('drop', 'Files dropped on the page', files);
    }).catch(() => {
      if (epoch === at) unseen = true;
    });
  }

  function interaction(event) {
    if (!isPerson(event)) return;
    const path = event.composedPath().filter(node => node instanceof view.Element);
    if (path.some(node => node.matches(OUTSIDE))) return;
    const [target] = path;
    // Inside a shadow root the tracker sees neither the inputs nor their change events.
    if (target && target.getRootNode() !== doc) return unseenChange();
    if (event.type === 'keydown') {
      if (IGNORED_KEYS.has(event.key)) return;
      if (SCROLL_KEYS.has(event.key) && (!target || target === doc.body)) return;
    }
    if (event.type === 'drop') {
      if (event.dataTransfer?.types?.includes('Files')) return personDrop(event);
      return unseenChange();
    }
    // A control's change follows the keydown or pointerup already seen, and can come later, on blur.
    if (event.type === 'change' && !target?.matches('input[type="file"]')) return;
    if (target?.matches('input[type="file"]') && (event.type === 'change' || event.type === 'input')) {
      if (event.type === 'input') return;
      if (!isClassified(target)) return unseenChange();
      if (running()) return unseenChange();
      begin();
      return record(target, [...(target.files ?? [])]);
    }
    if (path.some(node => node.matches(LOADERS) || (node.localName === 'label' && node.control?.type === 'file'))) return begin();
    unseenChange();
  }
  for (const type of INTERACTIONS) view.addEventListener(type, interaction, true);

  // Loads no person made: an app filling its own inputs, the shell delivering a drop or a handoff, a run.
  doc.addEventListener('change', event => {
    if (!isPerson(event) && isClassified(event.target) && !event.target.closest(PROMPT)) record(event.target, [...(event.target.files ?? [])]);
  }, true);
  doc.addEventListener('nd-files', event => {
    if (isClassified(event.target) && event.detail?.files?.[Symbol.iterator]) record(event.target, [...event.detail.files]);
  });
  doc.addEventListener('nd-example-status', event => {
    if (event.detail?.state === 'loading') {
      begin();
      epoch += 1;
      pageExample = null;
    }
    if (event.detail?.state === 'ready') pageExample = { id: event.detail.exampleId ?? null, at: epoch };
  });
  doc.addEventListener('nd-handoff', event => {
    begin();
    epoch += 1;
    const files = event.detail?.files;
    if (files?.length) receive('handoff', `Sent from ${event.detail.source?.title ?? 'another app'}`, files);
  });
  view.addEventListener('neurodesk-automation-reset', begin);

  const entries = () => [
    ...classified().map((input, index) => ({ input: key(input, index), kind: input.dataset.neurodeskInput, label: label(input), ...pageFiles.get(input) })),
    ...[...received].map(([name, entry]) => ({ input: `received:${name}`, ...entry })),
  ].filter(entry => entry.files?.length);

  return {
    /** The current examination, to hand back once an asynchronous step finishes. */
    examination: () => examination,
    held: () => Object.fromEntries([...examination.held].map(([role, files]) => [role, describe(files)])),
    page: () => entries().map(({ files, at, ...entry }) => ({ ...entry, files: describe(files), current: at === epoch })),
    /** Whether the person has done something in the page whose effect the tracker cannot list. */
    pageMayHoldOtherInputs: () => unseen,
    /** The example the person loaded with the page's own example selector, while nothing has changed since. */
    pageExample: () => (pageExample?.at === epoch ? pageExample.id : null),
    /** The files a page entry lists, its label, and whether the person has used the page since they were loaded. */
    pageEntry(inputKey) {
      const entry = entries().find(candidate => candidate.input === inputKey);
      if (!entry) throw new Error(`No files are loaded in the page input ${inputKey}`);
      return { label: entry.label, files: entry.files, current: entry.at === epoch };
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
    /** Hands the held files to the app's automation for the next run, which takes them. */
    async stage(from) {
      if (from !== examination) throw changed();
      for (const [role, files] of examination.held) await automation.adopt(role, files);
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
