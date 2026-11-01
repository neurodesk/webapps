import { createNiftiFromData, parseNiftiVolume } from '@neurodesk/webapp-components/file-io/nifti';
import { INFERENCE_DEFAULTS, NNUNET, resolveModels, validateSelection } from './assets.js';
import { runLegacyInference } from './legacy-pipeline.js';
import * as P from './nnunet.js';

export async function runInference(inputData, options) {
  const settings = { ...INFERENCE_DEFAULTS, ...options };
  if (options.pipeline === undefined && options.selectedModels !== undefined) settings.pipeline = 'legacy-v1';
  const {
    pipeline,
    model,
    selectedModels,
    mirror,
    threshold,
    nMarkers,
    Tensor,
    createSession,
    qsm,
    loadModel,
    decompress,
    events = {},
  } = settings;
  validateSelection(settings);
  const models = resolveModels(pipeline === 'legacy-v1' ? selectedModels : settings.folds, settings);
  if (pipeline === 'legacy-v1') return runLegacyInference(inputData, settings);
  const started = performance.now();
  const log = events.log ?? (() => {});
  const progress = events.progress ?? (() => {});
  const stages = {};
  const timing = { folds: [] };
  const {
    imageData,
    dims: niiDims,
    voxelSize,
    affine,
    headerBytes,
  } = parseNiftiVolume(inputData, { decompress });
  const [nx, ny, nz] = niiDims;
  const dims = [...niiDims].reverse();
  const spacing = [...voxelSize].reverse();
  log(`nnU-Net v2: ${nx} x ${ny} x ${nz}, spacing ${voxelSize.join(' x ')} mm`);
  progress(0.04, 'Bias field correction...');
  const corrected = new Float32Array(
    qsm.makehomogeneous_wasm(new Float64Array(imageData), nx, ny, nz, ...voxelSize, 7.0, 15),
  );
  const box = P.nonzeroBBox(corrected, dims);
  const cropped = P.cropBox(corrected, dims, box);
  P.zscoreInPlace(cropped.data);
  const workDims = P.newShape(cropped.dims, spacing, NNUNET.spacing_zyx);
  if (workDims.some((n) => n < 1)) throw new Error('Input spacing produces an empty nnU-Net grid.');
  const resampled = workDims.some((n, i) => n !== cropped.dims[i]);
  if (resampled)
    log(
      `Off-protocol spacing: linear resampling ${cropped.dims.join(' x ')} to ${workDims.join(' x ')}; training uses ${NNUNET.spacing_zyx.join(' x ')} mm (zyx).`,
    );
  const work = resampled ? P.resampleLinear(cropped.data, cropped.dims, workDims) : cropped.data;
  const patch = NNUNET.patch_size;
  const padded = P.padToPatch(work, workDims, patch);
  const gaussian = P.gaussianMap(patch, NNUNET.gaussian.sigma_scale, NNUNET.gaussian.value_scaling_factor);
  const count = padded.data.length;
  const ensemble = new Float32Array(count);
  const mirrorAxes = mirror ? NNUNET.mirror_axes : [];

  for (let index = 0; index < models.length; index++) {
    const asset = models[index];
    const base = 0.08 + (index * 0.85) / models.length;
    const span = 0.85 / models.length;
    const bytes = await loadModel(asset, asset.filename, base, span * 0.3);
    // A session owns one network at a time; browser adapters retry a complete fold on WASM.
    const execute = async (session) => {
      const runNet = async (data) => {
        const input = new Tensor('float32', data, [1, 1, ...patch]);
        let outputs;
        try {
          outputs = await session.run({ [NNUNET.input]: input });
          const output = outputs[NNUNET.output];
          const values = output.location && output.location !== 'cpu' ? await output.getData() : output.data;
          return new Float32Array(values);
        } finally {
          input.dispose?.();
          for (const output of Object.values(outputs ?? {})) output.dispose?.();
        }
      };
      return P.slidingWindowLogits(padded.data, padded.dims, patch, runNet, {
        gaussian,
        mirrorAxes,
        step: NNUNET.tile_step_size,
        onTile: (tile, total) =>
          progress(
            base + span * (0.3 + (0.7 * tile) / total),
            `Network ${Number(asset.fold) + 1}: patch ${tile}/${total}`,
          ),
      });
    };
    const foldStarted = performance.now();
    let result;
    let backend = 'cpu';
    if (options.runSession) {
      ({ result, backend } = await options.runSession(bytes, execute));
    } else {
      const session = await createSession(bytes);
      try {
        result = await execute(session);
      } finally {
        await session.release();
      }
    }
    const probability = P.softmaxClass(result.logits, result.C, count, NNUNET.marker_class);
    for (let i = 0; i < count; i++) ensemble[i] += probability[i] / models.length;
    timing.folds.push({ fold: asset.fold, backend, seconds: (performance.now() - foldStarted) / 1000 });
  }
  let probability = P.unpad(ensemble, padded.dims, workDims, padded.lo);
  if (resampled) probability = P.resampleLinear(probability, workDims, cropped.dims);
  probability = P.uncropBox(probability, dims, box);
  progress(0.95, 'Selecting markers...');
  const { markerMap, ...detections } = P.detect(
    probability,
    dims,
    nMarkers,
    threshold,
    voxelSize.reduce((a, b) => a * b, 1),
  );
  for (const marker of [...detections.markers, ...detections.others]) {
    marker.centroidWorldMm = affine
      .slice(0, 3)
      .map(
        (row) =>
          row[0] * marker.centroidVox[0] +
          row[1] * marker.centroidVox[1] +
          row[2] * marker.centroidVox[2] +
          row[3],
      );
  }
  for (const [stage, data, description] of [
    ['probability', probability, `Marker probability (mean of ${models.length} networks)`],
    ['markers', markerMap, `Top ${nMarkers} markers (value = rank)`],
  ]) {
    const niftiData = createNiftiFromData(data, headerBytes);
    stages[stage] = { niftiData, description };
    events.stageData?.(stage, niftiData, description);
  }
  timing.total = (performance.now() - started) / 1000;
  const summary = {
    ...detections,
    folds: models.map((asset) => asset.fold),
    mirror,
    backend: [...new Set(timing.folds.map((fold) => fold.backend))].join('+'),
    timing,
  };
  events.detections?.(summary);
  log(
    `Detected ${detections.markers.length}/${nMarkers} markers (${detections.nCandidates} candidates)${detections.countFlag ? '; review the image' : ''}`,
  );
  progress(1, 'Complete');
  return {
    pipeline,
    model,
    stages,
    markerVoxels: markerMap.reduce((n, value) => n + (value > 0 ? 1 : 0), 0),
    dims: niiDims,
    detections: summary,
    models: models.map(({ id, sha256 }) => ({ id, sha256 })),
  };
}
