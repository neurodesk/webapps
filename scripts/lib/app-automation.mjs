import { cp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseContract, contractJsonSchema } from '../../packages/desktop/src/contracts.js';
import { repoRoot } from './apps-registry.mjs';

export async function loadAppContract(app, version) {
  let source;
  try {
    source = await readFile(join(repoRoot, 'apps', app.id, 'automation.json'), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const contract = parseContract({ ...JSON.parse(source), appVersion: version });
  if (contract.app !== app.id) throw new Error(`Automation contract does not belong to ${app.id}`);
  return contract;
}

export async function publishAppContract({ app, version, distDir }) {
  const contract = await loadAppContract(app, version);
  if (!contract) return;
  await writeFile(join(distDir, 'automation.json'), `${JSON.stringify(contract, null, 2)}\n`);
  await writeFile(join(distDir, 'automation.schema.json'), `${JSON.stringify(contractJsonSchema(), null, 2)}\n`);
}

// A browser agent's tools offer these examples even where the page mounts its example selector late.
export async function publishAppExamples({ app, distDir }) {
  const source = join(repoRoot, 'apps', app.id, 'examples.json');
  if (existsSync(source)) await cp(source, join(distDir, 'examples.json'));
}
