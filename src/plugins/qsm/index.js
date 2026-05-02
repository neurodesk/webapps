import { definePlugin } from '../plugin.js';
import { qsmDefaults } from './qsmDefaults.js';
import { generateQsmxtCommand } from './qsmCommand.js';

export { qsmDefaults } from './qsmDefaults.js';
export { generateQsmxtCommand } from './qsmCommand.js';

export const qsmPlugin = definePlugin({
  id: 'qsm',
  name: 'QSMbly',
  description: 'QSMbly Rust/WASM QSM pipeline metadata, mask tooling, validation hooks, and qsmxt command preview.',
  sourceRepos: ['astewartau/qsmbly'],
  capabilities: ['rust-wasm-pipeline', 'multi-echo-inputs', 'mask-editing', 'dicompare-validation', 'command-preview'],
  pipelines: [
    {
      id: 'qsm-romeo',
      label: 'ROMEO QSM pipeline',
      inputModes: ['raw'],
      requiredInputs: ['magnitude', 'phase'],
      settingsSchema: qsmDefaults,
      commandPreview: (settings, context) => generateQsmxtCommand(settings, context?.maskOps || [], context),
      stages: [
        { id: 'combine', label: 'Phase combination', workerCommand: 'combine-phase', outputStages: ['combinedPhase'] },
        { id: 'unwrap', label: 'Phase unwrapping', workerCommand: 'unwrap', outputStages: ['unwrappedPhase'] },
        { id: 'fieldmap', label: 'Field map', workerCommand: 'field-map', outputStages: ['fieldMap'] },
        { id: 'background', label: 'Background removal', workerCommand: 'background-removal', outputStages: ['localField'] },
        { id: 'qsm', label: 'Dipole inversion', workerCommand: 'dipole-inversion', outputStages: ['qsm'] }
      ]
    },
    {
      id: 'qsm-total-field',
      label: 'Total field map pipeline',
      inputModes: ['totalField'],
      requiredInputs: ['totalField'],
      settingsSchema: qsmDefaults,
      commandPreview: (settings, context) => generateQsmxtCommand(settings, context?.maskOps || [], context),
      stages: [
        { id: 'background', label: 'Background removal', workerCommand: 'background-removal', outputStages: ['localField'] },
        { id: 'qsm', label: 'Dipole inversion', workerCommand: 'dipole-inversion', outputStages: ['qsm'] }
      ]
    },
    {
      id: 'qsm-local-field',
      label: 'Local field map pipeline',
      inputModes: ['localField'],
      requiredInputs: ['localField'],
      settingsSchema: qsmDefaults,
      commandPreview: (settings, context) => generateQsmxtCommand(settings, context?.maskOps || [], context),
      stages: [
        { id: 'qsm', label: 'Dipole inversion', workerCommand: 'dipole-inversion', outputStages: ['qsm'] }
      ]
    }
  ],
  workerSteps: {
    run: { requestType: 'run', outputStages: ['qsm', 'localField', 'fieldMap'] },
    validateDicom: { requestType: 'dicompare-validate', events: ['progress', 'validation-report'] }
  }
});
