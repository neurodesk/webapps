import { awaitPipelineStep, createDicomConverter, createNiivueAdapter, registerAppAutomation, summarizeLabels } from '@neurodesk/webapp-components/automation';
import { readNifti } from '@neurodesk/webapp-components/file-io';
import { VERSION, FOLDS } from './app/config.js';
import { resolveModels } from '../vendor/seedseg/src/assets.js';
import { segmentRequest } from './app/request.js';

export function registerSeedSegAutomation(app) {
  const automation = registerAppAutomation({
    app: 'seedseg',
    contractUrl: 'vendor/automation.json',
    convertDicom: createDicomConverter({ moduleUrl: new URL('dcm2niix/index.jpeg.js', document.baseURI).href }),
    operations: {
      segment: async ({ inputs, parameters, signal, progress }) => {
        const executor = app.inferenceExecutor;
        if (executor.isRunning()) throw new Error('SeedSeg is already processing an image.');
        const request = segmentRequest(parameters);
        const selected = resolveModels(request.pipeline === 'legacy-v1' ? request.models : request.folds, request);
        const previousProgress = executor.setProgress;
        executor.setProgress = (value, message) => {
          previousProgress.call(executor, value, message);
          progress({ value, message });
        };
        try {
          await app.fileIOController.setFile(inputs.image[0]);
          signal.throwIfAborted();
          document.getElementById('legacyModel').checked = request.pipeline === 'legacy-v1';
          document.getElementById('legacyModel').dispatchEvent(new Event('change'));
          FOLDS.forEach(fold => { document.getElementById(`fold${fold}`).checked = request.folds.includes(Number(fold)); });
          document.getElementById('mirrorTTA').checked = request.mirror;
          document.getElementById('probThreshold').value = String(parameters.threshold);
          document.getElementById('nMarkers').value = String(parameters.markers);
          await awaitPipelineStep(executor, { terminal: 'complete' }, () => app.runSegmentation({ legacyModels: request.models, model: request.model, backend: parameters.backend }), signal);
          const artifacts = [];
          for (const [stage, result] of Object.entries(executor.getResults())) {
            if (stage === 'input' || !result.file) continue;
            artifacts.push({ id: stage, role: ['consensus', 'markers'].includes(stage) ? 'markers' : 'probability', file: result.file });
          }
          const mask = executor.getResult(request.pipeline === 'legacy-v1' ? 'consensus' : 'markers')?.file;
          if (!mask) throw new Error('SeedSeg did not return its marker mask.');
          if (executor.report.detections) artifacts.push({ id: 'detections', role: 'detections',
            file: new File([JSON.stringify(executor.report.detections, null, 2) + '\n'], 'detections.json', { type: 'application/json' }) });
          return {
            artifacts,
            measurements: { ...summarizeLabels(await readNifti(await mask.arrayBuffer()), {
              I: request.pipeline === 'legacy-v1' ? [0, 1] : Array.from({ length: parameters.markers + 1 }, (_, i) => i),
              labels: request.pipeline === 'legacy-v1' ? ['Background', 'Fiducial marker'] : ['Background', ...Array.from({ length: parameters.markers }, (_, i) => `Marker ${i + 1}`)],
            }), detections: executor.report.detections },
            provenance: {
              appVersion: VERSION, pipeline: request.pipeline,
              models: selected.map(({ id, filename, url, sha256 }) => ({ id, name: filename, url, sha256 })),
              executionProvider: executor.report.executionProvider, onnxRuntime: executor.report.onnxRuntime,
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
