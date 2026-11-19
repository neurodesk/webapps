import { createAgentPrompts } from '../ui/agentPrompt.js';
import { createToolInputs } from './tool-inputs.js';
import { registerWebMcpTools, webMcpTools } from './tools.js';

// The shell loads this module apart from the app bundle, so the page's automation is reached through the
// global the app's registerAppAutomation sets, whichever of the two runs first.
function pageAutomation(view) {
  if (view.neurodeskAutomation) return Promise.resolve(view.neurodeskAutomation);
  return new Promise(resolve => view.addEventListener('neurodesk-automation', () => resolve(view.neurodeskAutomation), { once: true }));
}

// The examples the page's own selectors offer, so an agent loads what the person could, and those the
// build published beside the contract, for a page that mounts its selector only in some views.
function pageExamples(doc) {
  let published;
  return async () => {
    published ??= Promise.resolve()
      .then(() => doc.defaultView.fetch(new URL('examples.json', doc.baseURI)))
      .then(response => (response.ok ? response.json() : []))
      .catch(() => []);
    const examples = new Map();
    for (const selector of doc.querySelectorAll('nd-example-selector')) {
      for (const example of selector.examples ?? []) if (!examples.has(example.id)) examples.set(example.id, example);
    }
    for (const example of await published) if (!examples.has(example.id)) examples.set(example.id, example);
    return [...examples.values()];
  };
}

/**
 * Registers the page's WebMCP tools with the browser's model context once the app has registered its
 * automation. The shell imports this module only when the browser exposes a model context.
 */
export async function exposeWebMcp(modelContext, doc = globalThis.document) {
  const view = doc.defaultView;
  // The examination starts before the app registers, so the person's first actions are seen too.
  const inputs = createToolInputs({ doc, automation: {
    running: () => view.neurodeskAutomation?.running() ?? false,
    adopt: (role, files) => view.neurodeskAutomation.adopt(role, files),
  } });
  const automation = await pageAutomation(view);
  const contract = await automation.dispatch('describe');
  const prompts = createAgentPrompts(doc);
  const tools = webMcpTools({
    contract,
    dispatch: automation.dispatch,
    inputs,
    examples: pageExamples(doc),
    askUser: prompts.ask,
    requestFiles: prompts.requestFiles,
    confirmFiles: prompts.confirmFiles,
    confirmFetch: prompts.confirmFetch,
  });
  return registerWebMcpTools(modelContext, tools);
}
