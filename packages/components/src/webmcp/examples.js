/**
 * What one example gives the WebMCP tools: its files under the automation contract's input roles, or why
 * no operation can take it. An example's own file roles serve the page's example selector; where they
 * differ from the contract's, examples.json maps them in the example's `automation` field:
 *
 *   "automation": { "roles": { "echo": "echoes" }, "files": { "PA.bval": null }, "reason": "Why files are left out" }
 *   "automation": { "unavailable": "Why no operation can take this example" }
 *
 * `files` (by file name) overrides `roles`; null leaves a file out, which needs a `reason`.
 *
 * @param {{ files: { role: string, name: string }[], automation?: { roles?: Record<string, string|null>, files?: Record<string, string|null>, reason?: string, unavailable?: string } }} example
 * @param {Set<string>|Map<string, unknown>} fileRoles The contract's file input roles.
 */
export function exampleInputs(example, fileRoles) {
  const { roles = {}, files: byName = {}, reason, unavailable } = example.automation ?? {};
  if (unavailable) return { unavailable };
  const files = [];
  for (const file of example.files) {
    const role = Object.hasOwn(byName, file.name) ? byName[file.name] : Object.hasOwn(roles, file.role) ? roles[file.role] : file.role;
    if (role === null) continue;
    if (!fileRoles.has(role)) return { unavailable: `Its ${file.role} file ${file.name} matches no input of this application.`, undeclared: role };
    files.push({ ...file, role });
  }
  if (!files.length) return { unavailable: reason ?? 'It leaves every file out.' };
  return { files, ...(files.length < example.files.length && { omitted: reason }) };
}
