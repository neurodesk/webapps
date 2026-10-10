import { awaitPipelineStep, createDicomConverter, createNiivueAdapter, registerAppAutomation, summarizeLabels } from '@neurodesk/webapp-components/automation';
import { readNifti } from '@neurodesk/webapp-components/file-io';
import { MODELS, MODEL_BASE_URL, VERSION } from './app/config.js';
import { MODEL_ASSETS } from '../vendor/seedseg/src/assets.js';

export function registerSeedSegAutomation(app) {
  const automation = registerAppAutomation({
    app: 'seedseg',
    contractUrl: 'vendor/automation.json',
    convertDicom: createDicomConverter({ moduleUrl: new URL('dcm2niix/index.js', document.baseURI).href }),
    operations: {
      segment: async ({ inputs, parameters, signal, progress }) => {
        const executor = app.inferenceExecutor;
        if (executor.isRunning()) throw new Error('SeedSeg is already processing an image.');
        if (!parameters.models.length || new Set(parameters.models).size !== parameters.models.length) {
          throw new Error('Select one or more distinct SeedSeg models.');
        }
        const previousProgress = executor.setProgress;
        executor.setProgress = (value, message) => {
          previousProgress.call(executor, value, message);
          progress({ value, message });
        };
        try {
          await app.fileIOController.setFile(inputs.image[0]);
          signal.throwIfAborted();
          MODELS.forEach((model, index) => { document.getElementById(`model${index}`).checked = parameters.models.includes(model.seed); });
          document.getElementById('probThreshold').value = String(parameters.threshold);
          document.getElementById('nMarkers').value = String(parameters.markers);
          await awaitPipelineStep(executor, { terminal: 'complete' }, () => app.runSegmentation(), signal);
          const artifacts = [];
          for (const [stage, result] of Object.entries(executor.getResults())) {
            if (stage === 'input' || !result.file) continue;
            artifacts.push({ id: stage, role: stage === 'consensus' ? 'markers' : 'probability', file: result.file });
          }
          const consensus = executor.getResult('consensus')?.file;
          if (!consensus) throw new Error('SeedSeg did not return its consensus marker mask.');
          return {
            artifacts,
            measurements: summarizeLabels(await readNifti(await consensus.arrayBuffer()), { I: [0, 1], labels: ['Background', 'Fiducial marker'] }),
            provenance: {
              appVersion: VERSION,
              models: MODELS.filter(model => parameters.models.includes(model.seed)).map(model => ({ name: model.name, url: `${MODEL_BASE_URL}/${model.name}`, sha256: MODEL_ASSETS.find(asset => asset.filename === model.name).sha256 })),
              executionProvider: 'wasm',
              settings: executor.lastRunSettings.settings,
            },
          };
        } finally {
          executor.setProgress = previousProgress;
        }
      },
    },
  });
  automation.registerViewer('main', createNiivueAdapter(app.nv));
  return automation;
}
