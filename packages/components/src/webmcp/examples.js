/**
 * What one example gives the WebMCP tools: its files under the automation contract's input roles, or why
 * no operation can take it. An example's own file roles serve the page's example selector; where they
 * differ from the contract's, examples.json maps them in the example's `automation` field:
 *
 *   "automation": { "roles": { "echo": "echoes" }, "files": { "PA.bval": null }, "reason": "Why files are left out" }
 *   "automation": { "unavailable": "Why no operation can take this example" }
 *
 * `files` (by file name) overrides `roles`; null leaves a file out, which needs a `reason`. The run
 * parameters the example needs are the contract-named keys of its `parameters`, which the page's own
 * loader may read too, and `automation.parameters`.
 *
 * @param {{ files: { role: string, name: string }[], parameters?: object, automation?: { roles?: Record<string, string|null>, files?: Record<string, string|null>, reason?: string, unavailable?: string, parameters?: object } }} example
 * @param {Set<string>|Map<string, unknown>} fileRoles The contract's file input roles.
 * @param {Set<string>} parameterNames The contract's parameter names.
 */
export function exampleInputs(example, fileRoles, parameterNames = new Set()) {
  const { roles = {}, files: byName = {}, reason, unavailable, parameters: needed = {} } = example.automation ?? {};
  if (unavailable) return { unavailable };
  const files = [];
  for (const file of example.files) {
    const role = Object.hasOwn(byName, file.name) ? byName[file.name] : Object.hasOwn(roles, file.role) ? roles[file.role] : file.role;
    if (role === null) continue;
    if (!fileRoles.has(role)) return { unavailable: `Its ${file.role} file ${file.name} matches no input of this application.`, undeclared: role };
    files.push({ ...file, role });
  }
  if (!files.length) return { unavailable: reason ?? 'It leaves every file out.' };
  const own = Object.entries(example.parameters ?? {}).filter(([name]) => parameterNames.has(name));
  const parameters = { ...Object.fromEntries(own), ...needed };
  return { files, ...(Object.keys(parameters).length && { parameters }), ...(files.length < example.files.length && { omitted: reason }) };
}
