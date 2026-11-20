/**
 * What one example gives the WebMCP tools: its files under the automation contract's input roles, the
 * operation that runs it and its run parameters, or why no operation can take it. An example's own file
 * roles serve the page's example selector; where they differ from the contract's, examples.json maps
 * them in the example's `automation` field:
 *
 *   "automation": { "roles": { "echo": "echoes" }, "files": { "PA.bval": null }, "reason": "Why files are left out" }
 *   "automation": { "parameters": { "mp2rage": [6, 0.8, 2.7, 4, 5, 35, 72, 0.0067, 0.96] } }
 *   "automation": { "unavailable": "Why no operation can take this example" }
 *
 * `files` (by file name) overrides `roles`; null leaves a file out, which needs a `reason`. The run
 * parameters are the contract-named keys of the example's `parameters`, which the page's own loader may
 * read too, and `automation.parameters`, which translates the rest.
 *
 * @param {{ files: { role: string, name: string }[], parameters?: object, automation?: { roles?: Record<string, string|null>, files?: Record<string, string|null>, reason?: string, unavailable?: string, parameters?: object } }} example
 * @param {Record<string, { inputs: object, parameters: object }>} operations The contract's operations.
 * @param {string} [defaultOperation] Tried first.
 */
export function exampleInputs(example, operations, defaultOperation) {
  const fileRoles = new Set(Object.values(operations).flatMap(operation => Object.entries(operation.inputs)
    .filter(([, field]) => field.source === 'files').map(([role]) => role)));
  const { roles = {}, files: byName = {}, reason, unavailable, parameters: translated = {} } = example.automation ?? {};
  if (unavailable) return { unavailable };
  const files = [];
  for (const file of example.files) {
    const role = Object.hasOwn(byName, file.name) ? byName[file.name] : Object.hasOwn(roles, file.role) ? roles[file.role] : file.role;
    if (role === null) continue;
    if (!fileRoles.has(role)) return { unavailable: `Its ${file.role} file ${file.name} matches no input of this application.`, undeclared: role };
    files.push({ ...file, role });
  }
  if (!files.length) return { unavailable: reason ?? 'It leaves every file out.' };
  const held = new Set(files.map(file => file.role));
  const takes = name => Object.entries(operations[name].inputs).every(([role, field]) => field.source !== 'files' || field.minimum === 0 || held.has(role));
  const operation = [defaultOperation, ...Object.keys(operations)].find(name => name !== undefined && Object.hasOwn(operations, name) && takes(name));
  if (!operation) return { unavailable: `No operation takes its ${[...held].join(' and ')} files alone.` };
  const own = Object.entries(example.parameters ?? {}).filter(([name]) => Object.hasOwn(operations[operation].parameters, name));
  const parameters = { ...Object.fromEntries(own), ...translated };
  return { files, operation, ...(Object.keys(parameters).length && { parameters }), ...(files.length < example.files.length && { omitted: reason }) };
}
