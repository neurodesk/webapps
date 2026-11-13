import { prepare } from '@neurodesk/calmar/pipeline';
import { createDicomConverter, createNiivueAdapter, registerAppAutomation, summarizeLabels } from '@neurodesk/webapp-components/automation';
import { readNifti } from '@neurodesk/webapp-components/file-io';
import { loadAtlasFromManifest, decodeNiftiBuffer } from './modules/atlas-loader.js';
import { affineFromHeader } from './modules/resample.js';
import { getSpatialMetadata } from './modules/spatial-file.js';
import { serializeOverlapCsv } from './modules/overlap-export.js';
import { runCurrent } from './modules/current-task.js';
import { VERSION } from './app/config.js';

// `adopt` loads the inputs a run is about: replacing the structural image stops
// whatever ran on the previous one, so it happens before this run's status begins.
async function runOperation(app, context, work, adopt) {
  const { signal, progress } = context;
  if (app._pipelineRunning || app.executor.isRunning()) throw new Error('CALMaR is already processing an analysis.');
  let owner;
  let status = null;
  const cancel = () => {
    if (!owner || !app.isCurrent(owner) || (status && !app.ownsStatus(status))) return;
    app.invalidatePipeline('automation cancelled');
  };
  signal.addEventListener('abort', cancel, { once: true });
  const previousProgress = app.automationProgress;
  app.automationProgress = progress;
  // Once the run has begun its status it owns the status bar until something
  // else takes it; before that it has written nothing that could be stale.
  try {
    signal.throwIfAborted();
    app.clearResults({ full: true });
    owner = app.owner('pipeline', 'mask');
    const adopting = adopt?.(context);
    owner.renew();
    await adopting;
    owner();
    signal.throwIfAborted();
    status = app.beginStatus('Running analysis…');
    const result = await runCurrent(owner, work(context, owner));
    owner();
    signal.throwIfAborted();
    app.endStatus(result.summary?.requiresReview ? 'Review and confirm the lesion mask' : 'Complete');
    return result;
  } catch (error) {
    const owned = app.isCurrent(owner) && (status ? app.ownsStatus(status) : !app.superseded(error));
    if (!signal.aborted && owned) app.failStatus(error.message);
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
    if (app.automationProgress === progress) app.automationProgress = previousProgress;
  }
}

export function registerCalmarAutomation(app) {
  const automation = registerAppAutomation({
    app: 'calmar',
    contractUrl: 'vendor/automation.json',
    convertDicom: createDicomConverter({ moduleUrl: new URL('dcm2niix/index.jpeg.js', document.baseURI).href }),
    operations: {
      'map-lesion': context => runOperation(app, context, function* ({ inputs, parameters, signal, progress }, owner) {
        app.handleAtlasSelectionChange(parameters.atlas);
        document.getElementById('atlasSelect').value = parameters.atlas;
        const manifest = yield app.ensureManifest();
        const option = app.getAtlasOption();
        progress({ value: 0.05, message: 'Checking lesion geometry' });
        const atlas = yield loadAtlasFromManifest(option.overlapAtlasAssetId, { manifest });
        const lesion = yield decodeNiftiBuffer(yield inputs.lesion[0].arrayBuffer());
        const affine = affineFromHeader(lesion.header);
        const atlasAffine = affineFromHeader(atlas.header);
        if (lesion.dims.some((dimension, axis) => dimension !== atlas.dims[axis]) || affine.some((row, axis) => row.some((value, column) => !Number.isFinite(value) || Math.abs(value - atlasAffine[axis][column]) > 1e-3))) {
          throw new Error(`The supplied lesion must match the ${option.overlapAtlasAssetId} dimensions and affine. Register it to that atlas grid first.`);
        }
        signal.throwIfAborted();
        yield app.setLesion(inputs.lesion[0]);
        app._applyThresholdDefaults({ value: parameters.topPercent, symmetric: parameters.symmetric, minClusterVoxels: parameters.minimumClusterSize });
        progress({ value: 0.2, message: 'Computing atlas overlap' });
        yield app.runAtlasOverlap();
        signal.throwIfAborted();
        if (!app.overlapResult) throw new Error('CALMaR did not return atlas overlap measurements.');
        yield app.runFcNetworkMap();
        signal.throwIfAborted();
        if (!app.networkMapFile) throw new Error('No supported connectivity map was produced for this lesion and atlas.');
        progress({ value: 0.95, message: 'Thresholding network map' });
        app.applyNetworkThreshold();
        const csv = serializeOverlapCsv(app.getDisplayOverlapSummary(), { networkSizes: app.overlapResult.networkSizes });
        const map = yield readNifti(yield app.networkMapFile.arrayBuffer());
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
            threshold: summarizeLabels(yield readNifti(yield app.thresholdedMaskFile.arrayBuffer()), { I: [0, 1], labels: ['Background', 'Retained network'] }),
          },
          provenance: {
            appVersion: VERSION, atlas: option.overlapAtlasAssetId,
            connectome: { id: connectome.id, sourceVersion: connectome.sourceVersion, declaredSha256: connectome.checksum },
            lesionSource: 'explicitly supplied atlas-space lesion',
            spatial: getSpatialMetadata(app.networkMapFile),
          },
        };
      }),
      'prepare-lesion': context => runOperation(app, context, function* ({ signal, progress }, owner) {
        progress({ value: 0.05, message: 'Extracting brain' });
        const prepared = yield prepare(null, {
          extractBrain: () => runCurrent(owner, (function* () {
            yield app.runBrainExtraction(owner);
            signal.throwIfAborted();
          })()),
          prealign: () => runCurrent(owner, (function* () {
            yield app.prealignToMni160({ skipIfAligned: true, assertCurrent: owner });
            signal.throwIfAborted();
          })()),
          segment: () => runCurrent(owner, (function* () {
            yield app.runLesionSegmentation(owner);
            signal.throwIfAborted();
          })()),
          projectCandidate: () => runCurrent(owner, (function* () {
            const review = app.startLesionMaskReview({ seedFile: app.autoLesionSeedFile });
            owner.renew();
            return yield review;
          })())
        });
        const candidate = prepared.candidate;
        if (!candidate || app.lesionMaskConfirmed) throw new Error('CALMaR did not return an unconfirmed lesion candidate for review.');
        const brainMask = app.nativeBrainmaskFile || app.brainmaskFile;
        const manifest = yield app.ensureManifest();
        return {
          artifacts: [{ role: 'candidate', file: candidate }, { role: 'brainMask', file: brainMask }],
          summary: { requiresReview: true, lesionConfirmed: false, message: 'Review and edit this candidate lesion before confirmation, registration and network mapping.' },
          measurements: summarizeLabels(yield readNifti(yield candidate.arrayBuffer()), { I: [0, 1], labels: ['Background', 'Unconfirmed lesion candidate'] }),
          provenance: {
            appVersion: VERSION, executionProvider: 'wasm',
            models: manifest.modelAssets.filter(asset => ['lnm-synthstrip', 'lnm-stroke-lesion'].includes(asset.id)).map(asset => ({ id: asset.id, sourceVersion: asset.sourceVersion, declaredSha256: asset.checksum })),
            spatial: getSpatialMetadata(candidate),
          },
        };
      }, ({ inputs }) => app.setStructural(inputs.structural[0])),
    },
  });
  automation.registerViewer('main', createNiivueAdapter(app.nv));
  return automation;
}
