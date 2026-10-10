import { prepare } from '@neurodesk/calmar/pipeline';
import { createDicomConverter, createNiivueAdapter, registerAppAutomation, summarizeLabels } from '@neurodesk/webapp-components/automation';
import { readNifti } from '@neurodesk/webapp-components/file-io';
import { loadAtlasFromManifest, decodeNiftiBuffer } from './modules/atlas-loader.js';
import { affineFromHeader } from './modules/resample.js';
import { getSpatialMetadata } from './modules/spatial-file.js';
import { serializeOverlapCsv } from './modules/overlap-export.js';
import { VERSION } from './app/config.js';

async function runOperation(app, context, work) {
  const { signal, progress } = context;
  if (app._pipelineRunning || app.executor.isRunning()) throw new Error('CALMaR is already processing an analysis.');
  const cancel = () => {
    app.executor.cancel();
    app._rejectPendingWorkerWaits('Cancelled');
    app._pipelineRunning = false;
    app.progress.reset('Cancelled');
  };
  signal.addEventListener('abort', cancel, { once: true });
  const previousProgress = app.automationProgress;
  app.automationProgress = progress;
  try {
    signal.throwIfAborted();
    app.clearResults({ full: true });
    app.beginStatus('Running analysis…');
    const result = await work(context);
    signal.throwIfAborted();
    app.endStatus(result.summary?.requiresReview ? 'Review and confirm the lesion mask' : 'Complete');
    return result;
  } catch (error) {
    if (!signal.aborted) app.failStatus(error.message);
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
    app.automationProgress = previousProgress;
  }
}

export function registerCalmarAutomation(app) {
  const automation = registerAppAutomation({
    app: 'calmar',
    contractUrl: 'vendor/automation.json',
    convertDicom: createDicomConverter({ moduleUrl: new URL('dcm2niix/index.js', document.baseURI).href }),
    operations: {
      'map-lesion': context => runOperation(app, context, async ({ inputs, parameters, signal, progress }) => {
        app.handleAtlasSelectionChange(parameters.atlas);
        document.getElementById('atlasSelect').value = parameters.atlas;
        const manifest = await app.ensureManifest();
        const option = app.getAtlasOption();
        progress({ value: 0.05, message: 'Checking lesion geometry' });
        const atlas = await loadAtlasFromManifest(option.overlapAtlasAssetId, { manifest });
        const lesion = await decodeNiftiBuffer(await inputs.lesion[0].arrayBuffer());
        const affine = affineFromHeader(lesion.header);
        const atlasAffine = affineFromHeader(atlas.header);
        if (lesion.dims.some((dimension, axis) => dimension !== atlas.dims[axis]) || affine.some((row, axis) => row.some((value, column) => !Number.isFinite(value) || Math.abs(value - atlasAffine[axis][column]) > 1e-3))) {
          throw new Error(`The supplied lesion must match the ${option.overlapAtlasAssetId} dimensions and affine. Register it to that atlas grid first.`);
        }
        signal.throwIfAborted();
        await app.setLesion(inputs.lesion[0]);
        app._applyThresholdDefaults({ value: parameters.topPercent, symmetric: parameters.symmetric, minClusterVoxels: parameters.minimumClusterSize });
        progress({ value: 0.2, message: 'Computing atlas overlap' });
        await app.runAtlasOverlap();
        signal.throwIfAborted();
        if (!app.overlapResult) throw new Error('CALMaR did not return atlas overlap measurements.');
        await app.runFcNetworkMap();
        signal.throwIfAborted();
        if (!app.networkMapFile) throw new Error('No supported connectivity map was produced for this lesion and atlas.');
        progress({ value: 0.95, message: 'Thresholding network map' });
        app.applyNetworkThreshold();
        const csv = serializeOverlapCsv(app.getDisplayOverlapSummary(), { networkSizes: app.overlapResult.networkSizes });
        const map = await readNifti(await app.networkMapFile.arrayBuffer());
        if (!map.data.every(Number.isFinite)) throw new Error('CALMaR returned non-finite connectivity values.');
        const connectome = manifest.connectomeAssets.find(asset => asset.id === option.connectomeAssetId);
        return {
          artifacts: [
            { role: 'networkMap', file: app.networkMapFile },
            { role: 'thresholdMask', file: app.thresholdedMaskFile },
            { role: 'overlap', file: new File([csv], 'lnm-overlap.csv', { type: 'text/csv' }) },
          ],
          measurements: {
            directOverlap: app.getDisplayOverlapSummary(),
            affectedNetworks: app.affectedNetworkResult?.summary ?? null,
            threshold: summarizeLabels(await readNifti(await app.thresholdedMaskFile.arrayBuffer()), { I: [0, 1], labels: ['Background', 'Retained network'] }),
          },
          provenance: {
            appVersion: VERSION, atlas: option.overlapAtlasAssetId,
            connectome: { id: connectome.id, sourceVersion: connectome.sourceVersion, declaredSha256: connectome.checksum },
            lesionSource: 'explicitly supplied atlas-space lesion',
            spatial: getSpatialMetadata(app.networkMapFile),
          },
        };
      }),
      'prepare-lesion': context => runOperation(app, context, async ({ inputs, signal, progress }) => {
        await app.setStructural(inputs.structural[0]);
        signal.throwIfAborted();
        progress({ value: 0.05, message: 'Extracting brain' });
        const prepared = await prepare(null, {
          extractBrain: async () => {
            await app.runBrainExtraction();
            signal.throwIfAborted();
          },
          prealign: async () => {
            await app.prealignToMni160({ skipIfAligned: true });
            signal.throwIfAborted();
          },
          segment: async () => {
            await app.runLesionSegmentation();
            signal.throwIfAborted();
          },
          projectCandidate: () => app.startLesionMaskReview({ seedFile: app.autoLesionSeedFile })
        });
        const candidate = prepared.candidate;
        if (!candidate || app.lesionMaskConfirmed) throw new Error('CALMaR did not return an unconfirmed lesion candidate for review.');
        const brainMask = app.nativeBrainmaskFile || app.brainmaskFile;
        const manifest = await app.ensureManifest();
        return {
          artifacts: [{ role: 'candidate', file: candidate }, { role: 'brainMask', file: brainMask }],
          summary: { requiresReview: true, lesionConfirmed: false, message: 'Review and edit this candidate lesion before confirmation, registration and network mapping.' },
          measurements: summarizeLabels(await readNifti(await candidate.arrayBuffer()), { I: [0, 1], labels: ['Background', 'Unconfirmed lesion candidate'] }),
          provenance: {
            appVersion: VERSION, executionProvider: 'wasm',
            models: manifest.modelAssets.filter(asset => ['lnm-synthstrip', 'lnm-stroke-lesion'].includes(asset.id)).map(asset => ({ id: asset.id, sourceVersion: asset.sourceVersion, declaredSha256: asset.checksum })),
            spatial: getSpatialMetadata(candidate),
          },
        };
      }),
    },
  });
  automation.registerViewer('main', createNiivueAdapter(app.nv));
  return automation;
}
