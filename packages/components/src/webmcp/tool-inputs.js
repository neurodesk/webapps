// The automation contract's hidden input (automation/app-automation.js) and the agent's own file prompt
// (ui/agentPrompt.js) are not inputs the person loads the app through.
const TRANSFER = 'neurodesk-input-transfer';
const PROMPT = '#neurodeskAgentPrompt';
const describe = files => files.map(file => ({ name: file.name, bytes: file.size }));

/**
 * The files the WebMCP tools run on, and what the person has loaded into the page.
 *
 * The held files belong to one examination. Whenever the person changes what the app shows (a file
 * input or a drop, an example picked in the page, a handoff, the app clearing its examination) a new
 * examination starts with nothing held, so a run can never use files from the examination before. A
 * load an operation makes while a run is going is the run's own and changes nothing. Loading an
 * example replaces every held role, and an example that finishes downloading after the examination
 * changed is discarded.
 *
 * The person's own loads are kept per classified input (`data-neurodesk-input`), read as the change
 * event arrives because many apps clear the input once they have read it. An app that clears its
 * examination at the start of handling a load (in the same task) keeps that load.
 */
export function createToolInputs({ doc, automation }) {
  const view = doc.defaultView;
  let examination = { held: new Map() };
  let pageFiles = new WeakMap();
  let pageExample = null;
  // The examination a person's load opened, until the task that delivered it ends.
  let openedThisTask = null;

  const classified = () => [...doc.querySelectorAll('input[type="file"][data-neurodesk-input]')]
    .filter(input => input.id !== TRANSFER && !input.closest(PROMPT));
  const key = (input, index) => input.id || `input-${index + 1}`;
  const label = input => input.getAttribute('aria-label') || input.labels?.[0]?.textContent.trim() || input.dataset.neurodeskInput;
  const filesOf = input => pageFiles.get(input) ?? [];
  // Files the person chose before this module loaded; after that, only loads it saw count.
  for (const input of classified()) if (input.files?.length) pageFiles.set(input, [...input.files]);

  function moveOn({ forgetPage }) {
    examination = { held: new Map() };
    if (forgetPage) {
      pageFiles = new WeakMap();
      pageExample = null;
    }
    const opened = examination;
    openedThisTask = opened;
    view.setTimeout(() => {
      if (openedThisTask === opened) openedThisTask = null;
    });
  }

  // A trusted event is the person's own; an untrusted one while a run is going is the run feeding the app.
  const byPerson = event => event.isTrusted || !automation.running?.();

  function loaded(event, files) {
    const input = event.target;
    if (!classified().includes(input)) return;
    pageFiles.set(input, files);
    if (byPerson(event)) {
      pageExample = null;
      moveOn({ forgetPage: false });
    }
  }
  doc.addEventListener('change', event => loaded(event, [...(event.target.files ?? [])]), true);
  doc.addEventListener('nd-files', event => {
    if (event.detail?.files?.[Symbol.iterator]) loaded(event, [...event.detail.files]);
  });
  view.addEventListener('drop', event => {
    if (event.isTrusted && event.dataTransfer?.types?.includes('Files') && !event.target?.closest?.(PROMPT)) moveOn({ forgetPage: true });
  }, true);
  doc.addEventListener('nd-example-status', event => {
    if (event.detail?.state === 'loading') moveOn({ forgetPage: true });
    if (event.detail?.state === 'ready') pageExample = event.detail.exampleId ?? null;
  });
  doc.addEventListener('nd-handoff', () => moveOn({ forgetPage: true }));
  view.addEventListener('neurodesk-automation-reset', () => {
    if (openedThisTask !== examination) moveOn({ forgetPage: true });
  });

  return {
    held: () => Object.fromEntries([...examination.held].map(([role, files]) => [role, describe(files)])),
    page: () => classified().map((input, index) => ({ input: key(input, index), kind: input.dataset.neurodeskInput, label: label(input), files: describe(filesOf(input)) }))
      .filter(entry => entry.files.length),
    /** The example the person loaded with the page's own example selector, if that is what the page shows. */
    pageExample: () => pageExample,
    /** The current examination, to hand back to `replace` once an asynchronous load finishes. */
    examination: () => examination,
    /** Holds `files` (role to files) as the whole held set, if the person has not moved on since `from`. */
    replace(from, files) {
      if (from !== examination) {
        throw Object.assign(new Error('The person changed what the page shows while this loaded, so nothing is held. Load it again if they still want it.'), { code: 'EXAMINATION_CHANGED' });
      }
      examination.held = new Map(files);
    },
    /** Holds files for one role, beside the roles already held. */
    hold(role, files) {
      examination.held.set(role, files);
    },
    usePage(role, inputKey) {
      const input = classified().find((candidate, index) => key(candidate, index) === inputKey);
      const files = input ? filesOf(input) : [];
      if (!files.length) throw new Error(`No files are loaded in the page input ${inputKey}`);
      examination.held.set(role, files);
      return files;
    },
    /** Hands the held files to the app's automation for the next run, which takes them. */
    async stage() {
      for (const [role, files] of examination.held) await automation.adopt(role, files);
    },
  };
}
