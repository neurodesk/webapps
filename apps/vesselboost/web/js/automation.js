import { runSteps } from '../vendor/vesselboost/src/options.js';
import { awaitPipelineStep, createDicomConverter, createNiivueAdapter, registerAppAutomation } from '@neurodesk/webapp-components/automation';
import { readNifti } from '@neurodesk/webapp-components/file-io';
import { summarizeLabels } from '@neurodesk/webapp-components/automation';
import { MODEL_BASE_URL, MODELS, VERSION } from './app/config.js';

export function registerVesselBoostAutomation(app) {
  const automation = registerAppAutomation({
    app: 'vesselboost',
    contractUrl: 'vendor/automation.json',
    convertDicom: createDicomConverter({ moduleUrl: new URL('dcm2niix/index.js', document.baseURI).href }),
    operations: {
      segment: async ({ inputs, parameters, signal, progress }) => {
        const executor = app.inferenceExecutor;
        if (executor.isRunning()) throw new Error('VesselBoost is already processing an image.');
        const originalProgress = executor.setProgress;
        executor.setProgress = (fraction, message) => {
          originalProgress.call(executor, fraction, message);
          progress({ value: fraction, message });
        };
        const step = (name, action) => awaitPipelineStep(executor, { step: name, terminal: name === 'inference' ? 'complete' : 'step' }, action, signal);
        try {
          await step('load', () => app.onFileLoaded(inputs.image[0]));
          for (const [id, value] of Object.entries({
            downsampleFactor: parameters.downsample,
            modelSelect: parameters.model,
            overlapSelect: parameters.overlap,
            thresholdInput: parameters.threshold,
            minSizeInput: parameters.minimumComponentSize,
            denoiseMethodSelect: parameters.denoise,
            betMethodSelect: parameters.brainExtraction,
            betFiInput: parameters.brainThreshold,
          })) document.getElementById(id).value = String(value);
          await runSteps(async type => {
            const actions = {
              downsample: ['downsample', () => app.runDownsample()],
              'skip-downsample': ['downsample', () => app.skipDownsample()],
              'run-n4': ['n4', () => app.runN4()],
              'skip-n4': ['n4', () => app.skipN4()],
              'run-denoise': ['denoise', () => app.runDenoise()],
              'skip-denoise': ['denoise', () => app.skipDenoise()],
              'run-inference': ['inference', () => app.runSegmentation()],
              'run-bet': ['bet', () => app.runBET()],
              'apply-brain-mask': ['apply-brain-mask', () => app.applyBrainMask()],
            };
            const [name, action] = actions[type];
            await step(name, action);
          }, parameters);
          const segmentation = executor.getResult('segmentation')?.file;
          if (!segmentation) throw new Error('VesselBoost did not return a completed vessel segmentation.');
          const artifacts = [{ role: 'vessels', file: segmentation }];
          for (const stage of ['downsample', 'n4', 'nlm', 'bet']) {
            const file = executor.getResult(stage)?.file;
            if (file) artifacts.push({ role: 'preprocessed', file });
          }
          const mask = executor.getResult('brainmask')?.file;
          if (mask) artifacts.push({ role: 'brain-mask', file: mask });
          const model = MODELS.find(model => model.id === parameters.model);
          return {
            artifacts,
            measurements: summarizeLabels(await readNifti(await segmentation.arrayBuffer()), { I: [0, 1], labels: ['Background', 'Vessels'] }),
            provenance: {
              appVersion: VERSION,
              model: model.name,
              modelUrl: `${MODEL_BASE_URL}/${model.name}`,
              executionProvider: 'wasm',
              processing: executor.currentStepParams,
              spatial: executor.getResult('segmentation').spatial,
            },
          };
        } finally {
          executor.setProgress = originalProgress;
        }
      },
    },
  });
  automation.registerViewer('main', createNiivueAdapter(app.nv));
  return automation;
}
