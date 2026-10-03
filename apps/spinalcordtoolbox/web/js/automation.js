import { awaitPipelineStep, createDicomConverter, createNiivueAdapter, registerAppAutomation, summarizeLabels } from '@neurodesk/webapp-components/automation';
import { readNifti } from '@neurodesk/webapp-components/file-io';
import { getPrimaryModelAsset, getTaskById, getTaskLabels, getTaskModelUrl } from './app/sct-tasks.js';
import { VERSION } from './app/config.js';

export function registerSctAutomation(app) {
  const automation = registerAppAutomation({
    app: 'spinalcordtoolbox',
    contractUrl: 'vendor/automation.json',
    convertDicom: createDicomConverter({ moduleUrl: new URL('dcm2niix/index.js', document.baseURI).href }),
    operations: {
      segment: async ({ inputs, parameters, signal, progress }) => {
        const executor = app.inferenceExecutor;
        if (executor.isRunning()) throw new Error('SCT is already processing an image.');
        const previousProgress = executor.setProgress;
        executor.setProgress = (value, message) => {
          previousProgress.call(executor, value, message);
          progress({ value, message });
        };
        try {
          await awaitPipelineStep(executor, { step: 'load' }, () => app.onFileLoaded(inputs.image[0]), signal);
          document.getElementById('modelSelect').value = parameters.task;
          app.onTaskSelectionChanged(parameters.task);
          if (parameters.threshold !== undefined) document.getElementById('thresholdInput').value = String(parameters.threshold);
          if (parameters.minimumComponentSize !== undefined) document.getElementById('minSizeInput').value = String(parameters.minimumComponentSize);
          document.getElementById('ttaToggle').checked = parameters.testTimeAugmentation;
          await awaitPipelineStep(executor, { step: 'inference', terminal: 'complete' }, () => app.runSegmentation(), signal);
          const artifacts = [];
          const measurements = {};
          for (const [stage, result] of Object.entries(executor.getResults())) {
            if (stage === 'input' || !result.file) continue;
            if (result.kind === 'metrics') {
              artifacts.push({ role: 'metrics', id: stage, file: result.file });
              measurements[stage] = { summary: result.summary, rows: result.rows };
            } else {
              artifacts.push({ role: 'segmentation', id: stage, file: result.file });
              const labels = getTaskLabels(app.getOverlayLabelTaskId(stage));
              measurements[stage] = summarizeLabels(await readNifti(await result.file.arrayBuffer()), {
                I: labels.map(label => label.index), labels: labels.map(label => label.name),
              });
            }
            signal.throwIfAborted();
          }
          const task = getTaskById(parameters.task);
          const asset = getPrimaryModelAsset(task);
          return {
            artifacts,
            measurements,
            provenance: {
              appVersion: VERSION,
              task: task.id,
              model: asset.filename,
              modelUrl: getTaskModelUrl(task),
              declaredModelSha256: asset.checksum.replace(/^sha256:/, ''),
              sourceVersion: asset.sourceVersion,
              executionProvider: 'wasm',
              settings: executor.lastRunSettings,
            },
          };
        } finally {
          executor.setProgress = previousProgress;
        }
      },
    },
  });
  // No viewer is registered when WebGL2 is unavailable; processing still runs.
  if (app.nv) automation.registerViewer('main', createNiivueAdapter(app.nv));
  return automation;
}
