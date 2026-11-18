// The automation contract's hidden input (automation/app-automation.js) and the agent's own file prompt
// (ui/agentPrompt.js) are not inputs the person loads the app through.
const TRANSFER = 'neurodesk-input-transfer';
const PROMPT = '#neurodeskAgentPrompt';
const describe = files => files.map(file => ({ name: file.name, bytes: file.size }));

/**
 * The files the WebMCP tools run on, per contract input role, and the files the person has loaded into
 * the app's own classified inputs (`data-neurodesk-input`), which an agent may take into a role.
 *
 * Held files stay for every run until an agent replaces them, so a rerun with other parameters asks for
 * nothing again. They are released when the app clears its examination (`neurodesk-automation-reset`)
 * or when the person loads files into one of the app's inputs while no run is going: the app has then
 * moved on, and so do the tools. An input's page files are forgotten as soon as it takes new ones.
 */
export function createToolInputs({ doc, automation }) {
  const view = doc.defaultView;
  const held = new Map();
  let pageFiles = new WeakMap();

  const classified = () => [...doc.querySelectorAll('input[type="file"][data-neurodesk-input]')]
    .filter(input => input.id !== TRANSFER && !input.closest(PROMPT));
  const key = (input, index) => input.id || `input-${index + 1}`;
  const label = input => input.getAttribute('aria-label') || input.labels?.[0]?.textContent.trim() || input.dataset.neurodeskInput;
  const filesOf = input => pageFiles.get(input) ?? [...(input.files ?? [])];

  function loaded(input, files) {
    if (!classified().includes(input)) return;
    pageFiles.set(input, files);
    // An operation may feed the app's inputs while it runs; only the person's own loads release held files.
    void automation.dispatch('snapshot').then(({ state }) => {
      if (state !== 'running') held.clear();
    });
  }
  doc.addEventListener('change', event => loaded(event.target, [...(event.target.files ?? [])]), true);
  doc.addEventListener('nd-files', event => {
    if (event.detail?.files?.[Symbol.iterator]) loaded(event.target, [...event.detail.files]);
  });
  view.addEventListener('neurodesk-automation-reset', () => {
    held.clear();
    pageFiles = new WeakMap();
  });

  return {
    held: () => Object.fromEntries([...held].map(([role, files]) => [role, describe(files)])),
    adopt(role, files) {
      held.set(role, files);
    },
    page: () => classified().map((input, index) => ({ input: key(input, index), kind: input.dataset.neurodeskInput, label: label(input), files: describe(filesOf(input)) }))
      .filter(entry => entry.files.length),
    usePage(role, inputKey) {
      const input = classified().find((candidate, index) => key(candidate, index) === inputKey);
      const files = input ? filesOf(input) : [];
      if (!files.length) throw new Error(`No files are loaded in the page input ${inputKey}`);
      held.set(role, files);
      return files;
    },
    /** Hands the held files to the app's automation for the next run, which takes them. */
    async stage() {
      for (const [role, files] of held) await automation.adopt(role, files);
    },
  };
}
