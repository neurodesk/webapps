import { awaitPipelineStep, createDicomConverter, createNiivueAdapter, registerAppAutomation } from '@neurodesk/webapp-components/automation';
import { readNifti } from '@neurodesk/webapp-components/file-io';
import { PIPELINE_DEFAULTS, MASK_PREP_DEFAULTS, VERSION, QSM_RS_VERSION } from './app/config.js';

export function registerQsmAutomation(app) {
  const automation = registerAppAutomation({
    app: 'qsmbly',
    contractUrl: 'vendor/automation.json',
    convertDicom: createDicomConverter({ moduleUrl: new URL('dcm2niix/index.js', document.baseURI).href }),
    operations: {
      reconstruct: async ({ inputs, parameters, signal, progress }) => {
        const executor = app.pipelineExecutor;
        if (executor.isRunning()) throw new Error('QSMbly is already processing images.');
        if (inputs.magnitude.length !== inputs.phase.length) throw new Error('Provide one magnitude and phase image per echo, in matching order.');
        if (!parameters.echoTimesMs || parameters.echoTimesMs.length !== inputs.phase.length) throw new Error('Provide one echo time in milliseconds per magnitude/phase pair.');
        if (parameters.echoTimesMs.some((value, index, times) => index > 0 && value <= times[index - 1])) throw new Error('Echo times must be strictly increasing in input order.');
        if (!parameters.fieldStrength) throw new Error('Provide the acquired magnetic field strength in tesla.');
        const cancel = () => app.cancelPipeline();
        signal.addEventListener('abort', cancel, { once: true });
        const previousProgress = app.automationProgress;
        app.automationProgress = progress;
        try {
          app.clearAllResults();
          executor.lastRunSettings = null;
          const files = app.fileIOController;
          files.clearAllFiles();
          files.buckets.magnitude = inputs.magnitude.map(file => ({ file, name: file.name }));
          files.buckets.phase = inputs.phase.map(file => ({ file, name: file.name }));
          files.maskFile = inputs.mask.map(file => ({ file, name: file.name }));
          files.populateEchoTimeInputs(parameters.echoTimesMs);
          files.updateFileList('mask', files.maskFile);
          document.getElementById('magField').value = String(parameters.fieldStrength);
          app._onBucketsChanged();
          app.pipelineSettings = {
            ...structuredClone(PIPELINE_DEFAULTS),
            unwrapping_algorithm: parameters.unwrap,
            bf_algorithm: parameters.backgroundRemoval,
            dipole_inversion: parameters.inversion,
          };
          app.maskPrepSettings = { ...MASK_PREP_DEFAULTS, source: parameters.maskSource, biasCorrection: false, prepared: false };
          document.getElementById('maskInputSource').value = parameters.maskSource;
          document.getElementById('applyBiasCorrection').checked = false;
          app.syncSidebarFromSettings();
          await app.visualizeMagnitude();
          signal.throwIfAborted();
          if (!inputs.mask.length) {
            await app.prepareMaskInput();
            signal.throwIfAborted();
            if (!app.maskPrepSettings.prepared) throw new Error('QSM mask preparation did not complete.');
            await app.generateRobustMask();
            signal.throwIfAborted();
            if (!app.maskController.currentMaskData?.some(value => value > 0)) throw new Error('QSM masking did not produce a nonempty mask.');
          }
          await awaitPipelineStep(executor, {
            terminal: 'complete', completionCallback: 'onPipelineComplete', errorCallback: 'onPipelineError',
          }, () => app.runRomeoQSM({ throwOnError: true }), signal);
          const final = executor.getResult('final')?.file;
          if (!final) throw new Error('QSMbly did not return a completed susceptibility map.');
          const artifacts = Object.entries(executor.getResults()).map(([id, result]) => ({
            id: `stage-${id}`, role: id === 'final' ? 'qsm' : 'intermediate', file: result.file,
          }));
          const mask = inputs.mask[0] || new File([app.maskController.createMaskNifti(app.maskController.currentMaskData)], 'brain_mask.nii', { type: 'application/x-nifti' });
          artifacts.push({ role: 'mask', file: mask });
          const volume = await readNifti(await final.arrayBuffer());
          let minimum = Infinity;
          let maximum = -Infinity;
          for (const value of volume.data) {
            if (!Number.isFinite(value)) throw new Error('QSM output contains non-finite susceptibility values.');
            minimum = Math.min(minimum, value);
            maximum = Math.max(maximum, value);
          }
          return {
            artifacts,
            summary: { dimensions: volume.dims, susceptibility: { unit: 'ppm', minimum, maximum } },
            provenance: {
              appVersion: VERSION, qsmCoreVersion: QSM_RS_VERSION,
              executionProvider: 'wasm', settings: executor.getLastRunSettings(),
              echoTimesMs: parameters.echoTimesMs, fieldStrengthTesla: parameters.fieldStrength,
              mask: inputs.mask.length ? 'supplied' : `${parameters.maskSource}:robust`,
            },
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
