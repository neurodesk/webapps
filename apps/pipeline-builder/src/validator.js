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
      const checked = new Set((core.issues ?? []).filter(issue => issue.code === "constant-invalid").map(issue => issue.path));
      const builder = builderIssues(doc, tools).filter(issue => !(issue.code === "constant-invalid" && checked.has(issue.path)));
      const issues = [...(core.issues ?? []), ...builder];
      return { ...core, issues, ok: core.ok && !issues.some(issue => issue.severity === "error") };
    } catch (error) {
      return { ok: false, issues: [{ severity: "error", message: String(error?.message ?? error), path: "" }] };
    }
  };
}

// A builder check that throws must not hide the core's own issues.
function builderIssues(doc, tools) {
  try {
    return workflowIssues(doc, tools);
  } catch (error) {
    return [{ severity: "error", path: "", message: `Builder checks failed: ${String(error?.message ?? error)}` }];
  }
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
