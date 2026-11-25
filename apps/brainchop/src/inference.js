import { mindgrab } from '@neurodesk/runtime-support/mindgrab';
import { findModel, stemFor, TISSUE_STAGES } from './models.js';

function assetBaseUrl() {
  return new URL('brainchop/', new URL(import.meta.env.BASE_URL, location.href)).href;
}

export async function runModel(sourceFile, modelId, { backend = 'auto', saveConform = false, signal, onLog = () => {} } = {}) {
  const model = findModel(modelId);
  if (!model) throw new Error('Unknown segmentation model.');
  signal?.throwIfAborted();
  const input = await sourceFile.arrayBuffer();
  signal?.throwIfAborted();
  const assetPath = assetBaseUrl();
  const stem = stemFor(sourceFile.name);
  const options = {
    model: model.coreModel,
    backend,
    saveConform,
    gzipOutput: false,
    assetPath,
    signal,
    onLog,
  };
  if (model.kind === 'tissues') {
    const result = await mindgrab.segmentTissues(input, options);
    const files = Object.fromEntries(
      TISSUE_STAGES.map(stage => [
        stage.id,
        new File([result.tissues[stage.id]], `${stem}_${stage.suffix}.nii`, { type: 'application/x-nifti' }),
      ]),
    );
    return {
      kind: 'tissues',
      model,
      files,
      backend: result.backend,
      elapsedMs: result.elapsedMs,
      coreVersion: mindgrab.version,
    };
  }
  const result = await mindgrab.segment(input, options);
  const file = new File([result.image], `${stem}_${model.id}.nii`, { type: 'application/x-nifti' });
  return {
    kind: 'labels',
    model,
    file,
    backend: result.backend,
    elapsedMs: result.elapsedMs,
    coreVersion: mindgrab.version,
  };
}
