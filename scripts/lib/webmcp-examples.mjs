import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { exampleInputs } from '../../packages/components/src/webmcp/examples.js';
import { repoRoot } from './apps-registry.mjs';

// How each example of one app reaches a browser agent's inputs_load_example, and what in examples.json
// would make an example silently disappear from app_describe.
export async function auditAppExamples(appId, root = repoRoot) {
  const contract = JSON.parse(await readFile(join(root, 'apps', appId, 'automation.json'), 'utf8'));
  const examples = JSON.parse(await readFile(join(root, 'apps', appId, 'examples.json'), 'utf8'));
  const fileRoles = new Set(Object.values(contract.operations).flatMap(operation => Object.entries(operation.inputs)
    .filter(([, field]) => field.source === 'files').map(([role]) => role)));
  const problems = [];
  const results = [];
  for (const example of examples.filter(item => !item.rotation)) {
    const { roles = {}, files = {}, reason, unavailable } = example.automation ?? {};
    const exampleRoles = new Set(example.files.map(file => file.role));
    const names = new Set(example.files.map(file => file.name));
    for (const role of Object.keys(roles)) if (!exampleRoles.has(role)) problems.push(`${example.id}: automation.roles names ${role}, which no file has`);
    for (const name of Object.keys(files)) if (!names.has(name)) problems.push(`${example.id}: automation.files names ${name}, which is not one of its files`);
    for (const target of [...Object.values(roles), ...Object.values(files)]) {
      if (target !== null && !fileRoles.has(target)) problems.push(`${example.id}: automation maps a file to ${target}, which is not a file input of the contract`);
    }
    if (unavailable !== undefined && (typeof unavailable !== 'string' || !unavailable.trim())) problems.push(`${example.id}: automation.unavailable must say why`);
    const outcome = exampleInputs(example, fileRoles);
    if (outcome.undeclared) problems.push(`${example.id}: file role ${outcome.undeclared} is not a file input of the contract; map it in automation.roles or say why it is unavailable`);
    if (outcome.files && outcome.files.length < example.files.length && !reason?.trim()) problems.push(`${example.id}: files are left out without automation.reason`);
    results.push({ id: example.id, ...(outcome.files ? { loads: outcome.files.length, of: example.files.length, ...(outcome.omitted && { omitted: outcome.omitted }) } : { unavailable: outcome.unavailable }) });
  }
  return { app: appId, examples: results, problems };
}
