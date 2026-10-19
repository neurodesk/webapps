import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAppsRegistry } from '../lib/apps-registry.mjs';

// These existing workflows have separate hardware-GPU validation, recorded in
// standalone-validation.md. New apps default to the full hosted-CI workflow.
// Adding an exception requires an explicit review of its hardware test evidence.
// An app whose registry entry declares ci.hardware_gpu and that computes in the
// browser belongs here too, unless cpuWorkflowApps records that its workflow
// completes on the runners' CPU fallbacks; test/standalone.test.mjs checks it.
export const hardwareWorkflowApps = new Set([
  'vesselboost', 'spinalcordtoolbox', 'calmar', 'seedseg', 'deface',
  'browserqc', 'synthsr', 'synthseg', 'syncro', 'dwi2trx', 'edgereg',
  'greedy', 'ants', 'brain2print', 'topofit', 'fireants', 'fastprep',
]);
// Apps whose browser tests need a hardware GPU but whose offline workflow
// completed on every hosted runner without one (MindGrab on its CPU module,
// SynthSR on WASM), with the runs recorded in standalone-validation.md.
export const cpuWorkflowApps = new Set(['fastprep']);
export function ciWorkflowApps(registry) {
  return registry.apps.map(app => app.id).filter(id => !hardwareWorkflowApps.has(id));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(ciWorkflowApps(await loadAppsRegistry()).join(','));
}
