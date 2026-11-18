import { createAgentPrompts } from '../ui/agentPrompt.js';
import { registerWebMcpTools, webMcpTools } from './tools.js';

// The shell loads this module apart from the app bundle, so the page's automation is reached through the
// global the app's registerAppAutomation sets, whichever of the two runs first.
function pageAutomation(view) {
  if (view.neurodeskAutomation) return Promise.resolve(view.neurodeskAutomation);
  return new Promise(resolve => view.addEventListener('neurodesk-automation', () => resolve(view.neurodeskAutomation), { once: true }));
}

// The examples the page's own selectors offer, so an agent loads exactly what the person could.
function pageExamples(doc) {
  const examples = new Map();
  for (const selector of doc.querySelectorAll('nd-example-selector')) {
    for (const example of selector.examples ?? []) if (!examples.has(example.id)) examples.set(example.id, example);
  }
  return [...examples.values()];
}

/**
 * Registers the page's WebMCP tools with the browser's model context once the app has registered its
 * automation. The shell imports this module only when the browser exposes a model context.
 */
export async function exposeWebMcp(modelContext, doc = globalThis.document) {
  const automation = await pageAutomation(doc.defaultView);
  const contract = await automation.dispatch('describe');
  const prompts = createAgentPrompts(doc);
  const tools = webMcpTools({
    contract,
    dispatch: automation.dispatch,
    inputs: { adopt: automation.adopt, held: automation.held },
    examples: () => pageExamples(doc),
    askUser: prompts.ask,
    requestFiles: prompts.requestFiles,
  });
  return registerWebMcpTools(modelContext, tools);
}
