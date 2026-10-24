// The NeuroFlow core, vendored as WebAssembly, checks workflows against the tool
// catalog. DOM-independent: tests pass the .wasm bytes, the page passes its URL.
import init, { validate_workflow_with_tools_json } from "../vendor/neuroflow/neuroflow_wasm.js";
import { workflowIssues } from "./model.js";

export async function createValidator(tools, wasm) {
  await init({ module_or_path: wasm });
  const catalog = JSON.stringify(tools);
  return doc => {
    try {
      const core = JSON.parse(validate_workflow_with_tools_json(JSON.stringify(doc), catalog));
      const issues = [...(core.issues ?? []), ...workflowIssues(doc, tools)];
      return { ...core, issues, ok: core.ok && !issues.some(issue => issue.severity === "error") };
    } catch (error) {
      return { ok: false, issues: [{ severity: "error", message: String(error?.message ?? error), path: "" }] };
    }
  };
}

/** The registry index under `base`, then every tool it lists. */
export async function loadCatalog(base, fetcher = fetch) {
  const get = async path => {
    const response = await fetcher(new URL(path, base));
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
    return response.json();
  };
  const index = await get("neuroflow-registry.json");
  return { index, tools: await Promise.all(index.tools.map(get)) };
}
