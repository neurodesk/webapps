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
          await awaitPipelineStep(executor, { step: 'inference', terminal: 'complete' }, () => app.runSegmentation({ discardEdits: true }), signal);
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
      // sct_analyze_lesion on mask files: no inference.
      'lesion-metrics': async ({ inputs, signal, progress }) => {
        const executor = app.inferenceExecutor;
        if (executor.isRunning()) throw new Error('SCT is already processing an image.');
        const image = inputs.image?.[0] || null;
        const request = {
          lesionData: await inputs.lesion[0].arrayBuffer(),
          cordData: inputs.cord?.[0] ? await inputs.cord[0].arrayBuffer() : null,
          imageData: image ? await image.arrayBuffer() : null,
          imageName: image ? image.name.replace(/\.nii(\.gz)?$/i, '') : null,
        };
        signal.throwIfAborted();
        const previousProgress = executor.setProgress;
        executor.setProgress = (value, message) => {
          previousProgress.call(executor, value, message);
          progress({ value, message });
        };
        try {
          await awaitPipelineStep(executor, { step: 'lesion_metrics' }, () => {
            app.beginAbortableStep('lesion_metrics', 'Measuring lesions…');
            return executor.runLesionMetrics(request);
          }, signal);
          const result = executor.getResult('lesion_metrics');
          if (result?.kind !== 'metrics') throw new Error('Lesion analysis produced no table.');
          return {
            artifacts: [{ role: 'metrics', id: 'lesion_metrics', file: result.file }],
            measurements: { lesion_metrics: { summary: result.summary, rows: result.rows } },
            provenance: {
              appVersion: VERSION,
              method: 'sct_analyze_lesion (SCT 7.3) browser port',
              equivalentCommand: `sct_analyze_lesion -m ${inputs.lesion[0].name}${inputs.cord?.[0] ? ` -s ${inputs.cord[0].name}` : ''}${image ? ` -i ${image.name}` : ''}`,
            },
          };
        } finally {
          executor.setProgress = previousProgress;
        }
      },
      // sct_process_segmentation on mask files: no image and no inference.
      morphometry: async ({ inputs, parameters, signal, progress }) => {
        const executor = app.inferenceExecutor;
        if (executor.isRunning()) throw new Error('SCT is already processing an image.');
        const mask = inputs.segmentation[0];
        const discs = inputs.discs?.[0] || null;
        const request = {
          maskData: await mask.arrayBuffer(),
          maskName: mask.name,
          maskLabel: parameters.maskLabel ?? null,
          filename: mask.name,
          discData: discs ? await discs.arrayBuffer() : null,
          discName: discs?.name || null,
          discFilename: discs?.name || null,
          options: {
            aggregate: parameters.aggregate,
            slices: parameters.slices,
            levels: parameters.levels,
            angleCorrection: parameters.angleCorrection,
          },
        };
        signal.throwIfAborted();
        const previousProgress = executor.setProgress;
        executor.setProgress = (value, message) => {
          previousProgress.call(executor, value, message);
          progress({ value, message });
        };
        try {
          await awaitPipelineStep(executor, { step: 'morphometry' }, () => {
            app.beginAbortableStep('morphometry', 'Measuring morphometry…');
            app.setStepRunning('morphometry');
            return executor.runMorphometry(request);
          }, signal);
          const result = executor.getResult('morphometry');
          if (result?.kind !== 'metrics') throw new Error('Morphometry produced no table.');
          return {
            artifacts: [{ role: 'metrics', id: 'morphometry', file: result.file }],
            measurements: { morphometry: { summary: result.summary, rows: result.rows } },
            provenance: {
              appVersion: VERSION,
              method: 'sct_process_segmentation (SCT 7.3) browser port',
              equivalentCommand: result.summary.command,
              settings: executor.lastMorphometrySettings,
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
