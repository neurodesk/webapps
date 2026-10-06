import { createDicomConverter, createNiivueAdapter, registerAppAutomation } from '@neurodesk/webapp-components/automation';

export function registerMuscleMapAutomation(app) {
  const automation = registerAppAutomation({
    app: 'musclemap',
    contractUrl: 'vendor/automation.json',
    convertDicom: createDicomConverter({ moduleUrl: new URL('dcm2niix/index.js', document.baseURI).href }),
    operations: {
      segment: async ({ inputs, parameters, signal, progress }) => {
        if (app.inferenceExecutor.isRunning()) throw new Error('MuscleMap is already processing an image.');
        const cancel = () => app.cancelSegmentation();
        signal.addEventListener('abort', cancel, { once: true });
        const previousProgress = app.automationProgress;
        app.automationProgress = progress;
        try {
          signal.throwIfAborted();
          app.clearResults();
          app.fileIOController.setFiles(inputs.images);
          for (const entry of app.fileIOController.getEntries()) {
            entry.role = 'anatomical';
            entry.runSegmentation = true;
            entry.labelSpaceId = null;
            entry.labelEncoding = null;
          }
          app.fileIOController.updateFileListUI();
          await app.inputReady;
          await app.onFileLoaded(inputs.images[0]);
          await app.inferenceExecutor.initialize();
          signal.throwIfAborted();
          const fields = {
            modelSelect: parameters.model,
            overlapSelect: parameters.overlap,
            chunkSizeSelect: parameters.chunkSize,
            sourceChunkSizeSelect: parameters.sourceChunkSize,
          };
          for (const [id, value] of Object.entries(fields)) document.getElementById(id).value = String(value);
          document.getElementById('webgpuToggle').checked = parameters.useWebGPU;
          document.getElementById('imfToggle').checked = false;
          app.updateAboutModel();
          app.syncImfControls();
          const segmentations = await app.runSegmentation({ throwOnError: true, signal });
          if (!segmentations?.length) throw new Error('MuscleMap did not return completed segmentations.');
          const artifacts = [];
          const measurements = [];
          for (const source of segmentations) {
            signal.throwIfAborted();
            document.getElementById('metricsSegmentationSelect').value = source.id;
            await app.calculateMetrics({ throwOnError: true, signal });
            if (!app._pendingMetrics) throw new Error(`MuscleMap did not return metrics for ${source.file.name}.`);
            const metrics = structuredClone(app._pendingMetrics);
            const filename = source.file.name.replace(/\.nii(?:\.gz)?$/i, '_metrics.json');
            artifacts.push(
              { role: 'segmentation', file: source.file },
              { role: 'metrics', file: new File([`${JSON.stringify(metrics, null, 2)}\n`], filename, { type: 'application/json' }) },
            );
            measurements.push({ filename: source.file.name, ...metrics });
          }
          return {
            artifacts,
            measurements,
            provenance: { method: 'MuscleMap', segmentations: segmentations.map(source => ({ filename: source.file.name, ...source.provenance })) },
          };
        } finally {
          signal.removeEventListener('abort', cancel);
          app.automationProgress = previousProgress;
        }
      },
    },
  });
  automation.registerViewer('main', createNiivueAdapter(app.nv));
  return automation;
}
