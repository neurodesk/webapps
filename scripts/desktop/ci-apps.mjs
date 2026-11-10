import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { catalogApps, findCatalog, loadAppsRegistry, repoRoot } from '../lib/apps-registry.mjs';

// These existing workflows have separate hardware-GPU validation, recorded in
// standalone-validation.md. New apps default to the full hosted-CI workflow.
// Adding an exception requires an explicit review of its hardware test evidence.
// An app whose registry entry declares ci.hardware_gpu and that computes in the
// browser belongs here too, unless cpuWorkflowApps records that its workflow
// completes on the runners' CPU fallbacks; test/standalone.test.mjs checks it.
export const hardwareWorkflowApps = new Set([
  'vesselboost', 'spinalcordtoolbox', 'calmar', 'seedseg', 'deface',
  'browserqc', 'synthsr', 'synthseg', 'syncro', 'dwi2trx', 'edgereg',
  'greedy', 'ants', 'brain2print', 'topofit', 'fireants', 'brainchop',
]);
// Apps whose browser tests need a hardware GPU but whose offline workflow
// completed on every hosted runner without one (MindGrab on its CPU module,
// SynthSR on WASM), with the runs recorded in standalone-validation.md.
export const cpuWorkflowApps = new Set(['fastprep', 'sdc']);
export function ciWorkflowApps(registry) {
  return registry.apps.map(app => app.id).filter(id => !hardwareWorkflowApps.has(id));
}
// A catalogue suite runs the workflows of the apps it is home to. A copy is the
// same build under another brand, so its workflow runs once, in its home suite.
export function catalogWorkflowApps(registry, catalog) {
  return ciWorkflowApps({ apps: registry.apps.filter(app => app.catalog === catalog.id) });
}
// A suite's model pack is tested by the workflows of every app it serves that reads a pinned model.
export function modelWorkflowApps(registry, catalog, sources) {
  return ciWorkflowApps({ apps: catalogApps(registry, catalog).filter(app => sources.apps[app.id]?.some(source => source.kind === 'model')) });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { catalog: { type: 'string' }, models: { type: 'boolean' } } });
  const registry = await loadAppsRegistry();
  if (values.catalog === undefined) {
    console.log(ciWorkflowApps(registry).join(','));
  } else {
    const catalog = findCatalog(registry, values.catalog);
    const sources = JSON.parse(await readFile(join(repoRoot, 'registry/offline-assets.sources.json'), 'utf8'));
    console.log((values.models ? modelWorkflowApps(registry, catalog, sources) : catalogWorkflowApps(registry, catalog)).join(','));
  }
}
