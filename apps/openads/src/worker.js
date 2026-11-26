// OpenADS + StrokeView Web Worker: runs SynthStrip, ANTs MNI152 registration,
// DAGMNet DWI & PWI 16-pass segmentation, 4D PWI -> TTP mapping, JHU-ICBM atlas
// quantification, 29 Random Forest ONNX classifiers, exact TreeSHAP, and StrokeView
// 1,861-patient UMAP cohort projection entirely client-side.
import * as ort from 'onnxruntime-web/wasm';
import wasmURL from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import wasmModuleURL from 'onnxruntime-web/ort-wasm-simd-threaded.mjs?url';
import { fetchModel } from '@neurodesk/webapp-components/worker';
import { createRegistration, inflateNifti } from '@neurodesk/registration';
import { runSynthstrip } from '@neurodesk/synthstrip';
import { createBrowserSession } from '@neurodesk/synthstrip/browser';
import { SYNTHSTRIP_MODEL } from '@neurodesk/synthstrip/model';
import {
  assetIntegrity,
  loadNiftiBytes,
  loadNifti4DBytes,
  loadNifti4DRawBytes,
  reorientVolume4DToRAS,
  assertMatchingGeometry,
  extractFrame3D,
  writeNiftiFloat32,
  writeNiftiGz,
  maskVolume,
  percentileClipRescaleInMask,
  zscoreInMask,
  prepareDwiAdc,
  runDagmnetDwi,
  runDagmnetPwi,
  sliceTimeCorrection,
  computeTtpVolume,
  TTP_DEFAULTS,
  ATLAS_SPECS,
  VENTRICLES_SPEC,
  computeLesionVolumes,
  computeIcvMl,
  computeMismatch,
  computeAtlasOverlap,
  computeVentricleFeatures,
  computeQfvVectors,
  buildRfFeatureRequests,
  buildQfvCsv,
  buildLesionLoadCsv,
  buildRadiologicalReportText,
  decodeForestBinary,
  evaluateAtlasShap,
} from '@neurodesk/openads';

ort.env.wasm.wasmPaths = { wasm: wasmURL, mjs: wasmModuleURL };
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;

const progress = (value, message) => self.postMessage({ type: 'progress', value, message });
const log = (message) => self.postMessage({ type: 'log', message: String(message) });

const bytesCache = new Map();
const jsonCache = new Map();
const niftiCache = new Map();
const rfSessionCache = new Map();
let antsPromise = null;

async function fetchVerifiedBytes(relPath, onProgress) {
  if (bytesCache.has(relPath)) return bytesCache.get(relPath);
  const spec = assetIntegrity(relPath);
  const bytes = await fetchModel(spec, { onProgress });
  bytesCache.set(relPath, bytes);
  return bytes;
}

async function fetchVerifiedJson(relPath) {
  if (jsonCache.has(relPath)) return jsonCache.get(relPath);
  const bytes = await fetchVerifiedBytes(relPath);
  const parsed = JSON.parse(new TextDecoder().decode(bytes));
  jsonCache.set(relPath, parsed);
  return parsed;
}

async function fetchVerifiedNifti(relPath) {
  if (niftiCache.has(relPath)) return niftiCache.get(relPath);
  const bytes = await fetchVerifiedBytes(relPath);
  const vol = await loadNiftiBytes(bytes);
  niftiCache.set(relPath, vol);
  return vol;
}

function getAnts(assetBase) {
  if (!antsPromise) {
    const modUrl = new URL('registration/syncro-registration.mjs', assetBase).href;
    antsPromise = import(/* @vite-ignore */ modUrl).then(({ default: createModule }) =>
      createRegistration({ createModule, onLog: (msg) => log(`[ANTs] ${msg}`) }),
    );
  }
  return antsPromise;
}

function flatToMat4(flat) {
  return [
    [flat[0], flat[1], flat[2], flat[3]],
    [flat[4], flat[5], flat[6], flat[7]],
    [flat[8], flat[9], flat[10], flat[11]],
    [flat[12], flat[13], flat[14], flat[15]],
  ];
}

async function stripBrain(vol, baseProgress, span) {
  log(`Running SynthStrip on ${vol.dims.join('×')} volume`);
  const cleanData = new Float32Array(vol.voxels.length);
  for (let i = 0; i < vol.voxels.length; i++) {
    cleanData[i] = Number.isFinite(vol.voxels[i]) ? vol.voxels[i] : 0;
  }
  const result = await runSynthstrip({
    volume: {
      dims: vol.dims,
      pixdim: vol.pixdim,
      data: cleanData,
      affine: flatToMat4(vol.affine),
    },
    async loadModel() {
      const { url, bytes, sha256 } = SYNTHSTRIP_MODEL;
      const model = await fetchModel(
        { url, integrity: { bytes, sha256 } },
        { onProgress: ({ fraction }) => progress(baseProgress + span * 0.25 * (fraction || 0), 'Downloading SynthStrip…') },
      );
      return { bytes: model, hash: sha256 };
    },
    createSession: (bytes, dims) => createBrowserSession(bytes, dims, ort, { asset: SYNTHSTRIP_MODEL }),
    Tensor: ort.Tensor,
    onProgress: (frac, msg) => progress(baseProgress + span * (0.25 + 0.75 * frac), msg || 'Skull stripping…'),
  });
  return result.mask.data;
}

function openAdsAffineArgs(fixed, moving, prefix, out) {
  return [
    '--dimensionality', '3',
    '--float', '1',
    '--random-seed', '42',
    '-r', `[${fixed},${moving},1]`,
    '--metric', `mattes[${fixed},${moving},1,32,regular,0.2]`,
    '--transform', 'Affine[0.25]',
    '--convergence', '2100x1200x1200x10',
    '--smoothing-sigmas', '3x2x1x0',
    '--shrink-factors', '6x4x2x1',
    '-u', '0',
    '-z', '1',
    '--output', `[${prefix},${out}]`,
    '-x', '[NA,NA]',
    '--write-composite-transform', '0',
  ];
}

function openAdsSynArgs(fixed, moving, prefix, out) {
  return [
    '--dimensionality', '3',
    '--float', '1',
    '--random-seed', '42',
    '-r', `[${fixed},${moving},1]`,
    '--metric', `mattes[${fixed},${moving},1,32,regular,0.2]`,
    '--transform', 'Affine[0.25]',
    '--convergence', '2100x1200x1200x0',
    '--smoothing-sigmas', '3x2x1x0',
    '--shrink-factors', '4x2x2x1',
    '-x', '[NA,NA]',
    '--metric', `mattes[${fixed},${moving},1,32]`,
    '--transform', 'SyN[0.2,3,0]',
    '--convergence', '[60x30x15,1e-7,8]',
    '--smoothing-sigmas', '2x1x0',
    '--shrink-factors', '4x2x1',
    '-u', '0',
    '-z', '1',
    '--output', `[${prefix},${out}]`,
    '-x', '[NA,NA]',
    '--write-composite-transform', '0',
  ];
}

async function runRfClassifier(modelPath, features) {
  let session = rfSessionCache.get(modelPath);
  if (!session) {
    const bytes = await fetchVerifiedBytes(modelPath);
    session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
    rfSessionCache.set(modelPath, session);
  }
  const input = new ort.Tensor('float32', Float32Array.from(features), [1, features.length]);
  let outputs;
  try {
    outputs = await session.run({ [session.inputNames[0]]: input });
    const labelRaw = Number(outputs[session.outputNames[0]].data[0]);
    const probData = outputs[session.outputNames[1]]?.data;
    const prob = probData ? (probData.length >= 2 ? Number(probData[1]) : Number(probData[0])) : null;
    return {
      predict: labelRaw === 1 ? 'AFFECTED' : 'NORMAL',
      probability: prob != null ? Math.round(prob * 1000) / 1000 : null,
    };
  } finally {
    input.dispose();
    for (const out of Object.values(outputs || {})) out.dispose();
  }
}

async function runReportingPipeline({
  subjectId,
  modality = 'DWI',
  lesionVol,
  adcMniVol = null,
  brainMaskVol = null,
  mismatch = null,
  runShap = true,
  baseProgress = 0.65,
  span = 0.35,
}) {
  progress(baseProgress, 'Computing lesion volumes and JHU-ICBM atlas overlap…');
  const volumes = computeLesionVolumes(lesionVol.voxels, lesionVol.dims, lesionVol.pixdim);
  const icvMl = computeIcvMl(brainMaskVol?.voxels ?? null, lesionVol.dims, lesionVol.pixdim);

  const atlasStats = {};
  for (const [key, spec] of Object.entries(ATLAS_SPECS)) {
    const [atlasVol, lookup] = await Promise.all([
      fetchVerifiedNifti(spec.niftiPath),
      fetchVerifiedJson(spec.lookupPath),
    ]);
    atlasStats[key] = computeAtlasOverlap(
      volumes.binaryMask,
      lesionVol.dims,
      atlasVol.voxels,
      atlasVol.dims,
      lookup,
      { maskAffine: lesionVol.affine, atlasAffine: atlasVol.affine },
    );
  }

  let ventricles = null;
  if (adcMniVol && brainMaskVol) {
    const [ventVol, ventLookup] = await Promise.all([
      fetchVerifiedNifti(VENTRICLES_SPEC.niftiPath),
      fetchVerifiedJson(VENTRICLES_SPEC.lookupPath),
    ]);
    ventricles = computeVentricleFeatures(
      adcMniVol.voxels,
      brainMaskVol.voxels,
      adcMniVol.dims,
      ventVol.voxels,
      ventVol.dims,
      ventLookup,
      VENTRICLES_SPEC.adcThreshold,
      {
        adcAffine: adcMniVol.affine,
        brainMaskDims: brainMaskVol.dims,
        brainMaskAffine: brainMaskVol.affine,
        ventAffine: ventVol.affine,
      },
    );
  }

  const qfv = computeQfvVectors(atlasStats, volumes.totalMl);
  const rfRequests = buildRfFeatureRequests(atlasStats, volumes.totalMl, lesionVol.pixdim, ventricles);

  progress(baseProgress + span * 0.25, 'Running 29 OpenADS Random Forest classifiers…');
  const interpretation = { vascular: [], lobe: [], aspects: [] };
  const totalModels =
    rfRequests.vascular.length +
    rfRequests.lobe.length +
    rfRequests.aspects.length +
    (rfRequests.hydrocephalus ? 1 : 0);
  let completed = 0;

  for (const cat of ['vascular', 'lobe', 'aspects']) {
    for (const req of rfRequests[cat]) {
      const res = await runRfClassifier(req.modelPath, req.features);
      interpretation[cat].push({
        region: req.region,
        volumeMl: Math.round(req.volumeMl * 1000) / 1000,
        ...res,
      });
      completed++;
      progress(
        baseProgress + span * (0.25 + 0.35 * (completed / Math.max(1, totalModels))),
        `Scoring regional classifiers (${completed}/${totalModels})…`,
      );
    }
  }

  let hydrocephalus = null;
  if (rfRequests.hydrocephalus) {
    hydrocephalus = await runRfClassifier(rfRequests.hydrocephalus.modelPath, rfRequests.hydrocephalus.features);
    completed++;
  }

  const shap = {};
  if (runShap) {
    progress(baseProgress + span * 0.65, 'Computing exact TreeSHAP feature attributions…');
    const shapCategories = [
      ['vascular', 'vascular', qfv.vascular],
      ['lobe', 'lobe', qfv.lobe],
      ['aspects', 'aspects', qfv.aspects],
      ['aspectpc', 'aspectspc', qfv.aspectpc],
    ];
    for (const [atlasKey, dir, qfvEntry] of shapCategories) {
      if (!qfvEntry) continue;
      try {
        const manifest = await fetchVerifiedJson(`models/aa-shap/${dir}/manifest.json`);
        const forestsByRoi = new Map();
        for (const entry of manifest.models) {
          if (entry.kind === 'linear' || !entry.file) continue;
          const buf = await fetchVerifiedBytes(`models/aa-shap/${dir}/${entry.file}`);
          const ab = buf instanceof ArrayBuffer ? buf : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
          forestsByRoi.set(entry.roi, decodeForestBinary(ab, entry));
        }
        const qfvMap = new Map([['volml', qfvEntry.logml], ['logvol', qfvEntry.logml]]);
        qfvEntry.labels.forEach((lbl, idx) => qfvMap.set(lbl, qfvEntry.values[idx]));
        shap[atlasKey] = evaluateAtlasShap({ atlasKey, manifest, forestsByRoi, qfvMap });
      } catch (err) {
        log(`TreeSHAP (${atlasKey}) skipped: ${err.message}`);
      }
    }
  }

  progress(baseProgress + span * 0.85, 'Loading StrokeView 1,861-patient reference cohort…');
  const [cohortLobe, cohortVas] = await Promise.all([
    fetchVerifiedJson('cohort/cluster_lobe.json'),
    fetchVerifiedJson('cohort/cluster_vas.json'),
  ]);

  const report = buildRadiologicalReportText({
    subjectId,
    modality,
    volumes,
    icvMl,
    interpretation,
    hydrocephalus,
    mismatch,
  });

  const csvFiles = {
    [`${subjectId}_VASCULAR_QFV.csv`]: buildQfvCsv(subjectId, qfv.vascular),
    [`${subjectId}_LOBE_QFV.csv`]: buildQfvCsv(subjectId, qfv.lobe),
    [`${subjectId}_ASPECTS_QFV.csv`]: buildQfvCsv(subjectId, qfv.aspects),
    ...(qfv.aspectpc ? { [`${subjectId}_ASPECTSPC_QFV.csv`]: buildQfvCsv(subjectId, qfv.aspectpc) } : {}),
    [`${subjectId}_VASCULAR_lesionload.csv`]: buildLesionLoadCsv(atlasStats.vascular),
    [`${subjectId}_LOBE_lesionload.csv`]: buildLesionLoadCsv(atlasStats.lobe),
    [`${subjectId}_ASPECTS_lesionload.csv`]: buildLesionLoadCsv(atlasStats.aspects),
  };

  return {
    subjectId,
    modality,
    volumes: { totalMl: volumes.totalMl, leftMl: volumes.leftMl, rightMl: volumes.rightMl, totalVoxels: volumes.totalVoxels },
    icvMl,
    atlasStats,
    qfv,
    interpretation,
    hydrocephalus,
    mismatch,
    shap,
    report,
    csvFiles,
    cohortRefs: { lobe: cohortLobe, vas: cohortVas },
  };
}

async function runDagmnetOnnx(modelPath, fn, params, baseProgress, span, label) {
  progress(baseProgress, `Downloading ${label} model…`);
  const bytes = await fetchVerifiedBytes(modelPath, ({ fraction }) =>
    progress(baseProgress + span * 0.2 * (fraction || 0), `Downloading ${label} model…`),
  );
  log(`Creating ONNX Runtime session for ${modelPath} (WASM, ${ort.env.wasm.numThreads} threads)`);
  const session = await ort.InferenceSession.create(bytes, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });
  try {
    return await fn({
      ...params,
      runPass: async (tensorData, shape) => {
        const input = new ort.Tensor('float32', tensorData, shape);
        let outputs;
        try {
          outputs = await session.run({ [session.inputNames[0]]: input });
          return new Float32Array(outputs[session.outputNames[0]].data);
        } finally {
          input.dispose();
          for (const out of Object.values(outputs || {})) out.dispose();
        }
      },
      onPass: (done, total) =>
        progress(baseProgress + span * (0.2 + 0.8 * (done / total)), `${label} · pass ${done}/${total}`),
    });
  } finally {
    await session.release();
  }
}

async function runJob(job) {
  const started = performance.now();
  const { mode, subjectId, files, runSyn, runShap, threshold, assetBase } = job;
  const outputVolumes = [];

  if (mode === 'mni-report') {
    progress(0.05, 'Reading MNI152 volumes…');
    const maskVol = await loadNiftiBytes(await files.mask.arrayBuffer());
    const adcVol = files.adc ? await loadNiftiBytes(await files.adc.arrayBuffer()) : null;
    const brainMaskVol = files.brainmask ? await loadNiftiBytes(await files.brainmask.arrayBuffer()) : null;
    if (adcVol) assertMatchingGeometry(maskVol, adcVol, 'MNI lesion mask', 'MNI ADC');
    if (brainMaskVol) assertMatchingGeometry(maskVol, brainMaskVol, 'MNI lesion mask', 'MNI brain mask');

    const reporting = await runReportingPipeline({
      subjectId,
      modality: 'DWI',
      lesionVol: maskVol,
      adcMniVol: adcVol,
      brainMaskVol,
      runShap,
      baseProgress: 0.1,
      span: 0.88,
    });

    outputVolumes.push({
      key: 'stroke_mni',
      label: 'Stroke mask (MNI152)',
      filename: `${subjectId}_stroke-mask_space-MNI152.nii.gz`,
      bytes: await writeNiftiGz(maskVol),
      isOverlay: true,
      editable: true,
    });
    if (adcVol) {
      outputVolumes.push({
        key: 'adc_mni',
        label: 'ADC (MNI152)',
        filename: `${subjectId}_ADC_space-MNI152.nii.gz`,
        bytes: await writeNiftiGz(adcVol),
        isOverlay: false,
      });
    }

    progress(1, 'Analysis complete.');
    return {
      mode,
      elapsedSeconds: Math.round((performance.now() - started) / 100) / 10,
      reporting,
      outputVolumes,
    };
  }

  // Full native DWI (+ optional 4D PWI) pipeline
  progress(0.02, 'Reading native DWI/ADC volumes…');
  const dwiRawBytes = new Uint8Array(await files.dwi.arrayBuffer());
  let dwiVol;
  let b0From4d = null;
  const vol4d = await loadNifti4DBytes(dwiRawBytes);
  if (vol4d.dims[3] > 2) {
    throw new Error(
      `Ambiguous 4D DWI input with ${vol4d.dims[3]} volumes. Supply separate 3D DWI and b0/ADC scans (or a 2-volume DWI+b0 stack).`,
    );
  }
  if (vol4d.dims[3] === 2) {
    log(`2-volume 4D DWI detected (${vol4d.dims.join('×')}) — extracting DWI & b0 volumes`);
    dwiVol = extractFrame3D(vol4d, 0);
    b0From4d = extractFrame3D(vol4d, 1);
  } else {
    dwiVol = extractFrame3D(vol4d, 0);
  }
  const adcInput = files.adc ? await loadNiftiBytes(await files.adc.arrayBuffer()) : null;
  const b0Input = files.b0 ? await loadNiftiBytes(await files.b0.arrayBuffer()) : null;
  const prep = prepareDwiAdc({
    dwi: dwiVol,
    b0: b0Input || b0From4d,
    adc: adcInput,
    checkSwap: Boolean(b0From4d && !b0Input),
  });
  log(
    prep.adcWasComputed
      ? `Computed ADC from DWI + b0${prep.orderWasSwapped ? ' (swapped 4D order corrected)' : ''}`
      : 'Using supplied ADC volume',
  );

  // Step 1: SynthStrip brain mask on DWI
  const brainMask = await stripBrain(prep.dwi, 0.05, 0.14);
  let brainVox = 0;
  for (let i = 0; i < brainMask.length; i++) if (brainMask[i]) brainVox++;
  log(`SynthStrip brain mask: ${brainVox.toLocaleString()} foreground voxels`);
  const dwiBrain = maskVolume(prep.dwi, brainMask);
  const adcBrain = maskVolume(prep.adc, brainMask);
  const brainMaskVol = { ...prep.dwi, voxels: Float32Array.from(brainMask) };

  // Step 2: ANTs MNI152 affine (+ optional SyN)
  progress(0.2, 'Loading ANTs WebAssembly registration kernel…');
  const ants = await getAnts(assetBase);
  const affineTemplateBytes = await inflateNifti(await fetchVerifiedBytes('atlases/JHU_MNI_SS_DWI_mask_to_MNI.nii.gz'));
  const movingMaskBytes = writeNiftiFloat32(brainMaskVol);

  progress(0.23, 'Registering brain mask to MNI152 (ANTs affine)…');
  log('Running ANTs Affine registration to JHU_MNI_SS_DWI_mask_to_MNI');
  const affRes = ants.registerWithArgs({
    fixed: affineTemplateBytes,
    moving: movingMaskBytes,
    buildArgs: openAdsAffineArgs,
    transformNames: ['0GenericAffine.mat'],
  });
  const dwiAffineMat = affRes.transforms['0GenericAffine.mat'];
  if (!dwiAffineMat) throw new Error('ANTs affine registration did not produce a transform.');

  const affMaskVol = await loadNiftiBytes(affRes.warped);
  const affMaskBin = new Uint8Array(affMaskVol.voxels.length);
  for (let i = 0; i < affMaskBin.length; i++) affMaskBin[i] = affMaskVol.voxels[i] > 0.5 ? 1 : 0;

  progress(0.3, 'Warping DWI and ADC into MNI152 space…');
  const affDwiBytes = ants.applyTransforms({
    fixed: affineTemplateBytes,
    moving: writeNiftiFloat32(dwiBrain),
    transforms: [{ name: 'aff.mat', bytes: dwiAffineMat }],
    interpolation: 'linear',
  });
  const affAdcBytes = ants.applyTransforms({
    fixed: affineTemplateBytes,
    moving: writeNiftiFloat32(adcBrain),
    transforms: [{ name: 'aff.mat', bytes: dwiAffineMat }],
    interpolation: 'linear',
  });
  const affDwiVol = await loadNiftiBytes(affDwiBytes);
  const affAdcVol = await loadNiftiBytes(affAdcBytes);

  if (runSyn) {
    progress(0.33, 'Running ANTs SyN nonlinear registration (may take several minutes)…');
    log('Running ANTs SyN nonlinear warp against JHU_MNI_SS_ADC_ss_to_MNI');
    const synTemplateBytes = await inflateNifti(await fetchVerifiedBytes('atlases/JHU_MNI_SS_ADC_ss_to_MNI.nii.gz'));
    const scaledAdc = { ...affAdcVol, voxels: affAdcVol.voxels.map((v) => v * 1000) };
    const synRes = ants.registerWithArgs({
      fixed: synTemplateBytes,
      moving: writeNiftiFloat32(scaledAdc),
      buildArgs: openAdsSynArgs,
      transformNames: ['0GenericAffine.mat', '1Warp.nii.gz', '1InverseWarp.nii.gz'],
    });
    if (synRes.transforms['1Warp.nii.gz'] && synRes.transforms['0GenericAffine.mat']) {
      const synDwi = ants.applyTransforms({
        fixed: synTemplateBytes,
        moving: writeNiftiFloat32(affDwiVol),
        transforms: [
          { name: '1Warp.nii.gz', bytes: synRes.transforms['1Warp.nii.gz'] },
          { name: '0GenericAffine.mat', bytes: synRes.transforms['0GenericAffine.mat'] },
        ],
        interpolation: 'linear',
      });
      outputVolumes.push({
        key: 'dwi_affsyn',
        label: 'DWI (MNI152 SyN)',
        filename: `${subjectId}_DWI_space-MNI152_affsyn.nii.gz`,
        bytes: synDwi,
        isOverlay: false,
      });
    }
  }

  // Step 3: DAGMNet DWI stroke core segmentation
  const dwiSeg = await runDagmnetOnnx(
    'models/dagmnet_dwi_ch3.onnx',
    runDagmnetDwi,
    {
      dwi: affDwiVol.voxels,
      adc: affAdcVol.voxels,
      dims: affDwiVol.dims,
      mask: affMaskBin,
      threshold,
    },
    0.35,
    mode === 'dwi-pwi' ? 0.2 : 0.35,
    'DAGMNet DWI',
  );
  log(`DAGMNet DWI segmented ${dwiSeg.lesionVoxels.toLocaleString()} core voxels in MNI152`);

  const strokeMniVol = {
    dims: affDwiVol.dims,
    pixdim: affDwiVol.pixdim,
    affine: affDwiVol.affine,
    voxels: Float32Array.from(dwiSeg.mask),
  };

  // Restore core mask to native DWI space
  const strokeNativeBytes = ants.applyTransforms({
    fixed: writeNiftiFloat32(prep.dwi),
    moving: writeNiftiFloat32(strokeMniVol),
    transforms: [{ name: 'aff.mat', bytes: dwiAffineMat, invert: true }],
    interpolation: 'nearest',
  });

  outputVolumes.push(
    {
      key: 'dwi_mni',
      label: 'DWI (MNI152)',
      filename: `${subjectId}_DWI_space-MNI152_aff.nii.gz`,
      bytes: await writeNiftiGz(affDwiVol),
      isOverlay: false,
    },
    {
      key: 'adc_mni',
      label: 'ADC (MNI152)',
      filename: `${subjectId}_ADC_space-MNI152_aff.nii.gz`,
      bytes: await writeNiftiGz(affAdcVol),
      isOverlay: false,
    },
    {
      key: 'stroke_mni',
      label: 'Stroke core mask (MNI152)',
      filename: `${subjectId}_stroke-mask_space-MNI152.nii.gz`,
      bytes: await writeNiftiGz(strokeMniVol),
      isOverlay: true,
      editable: true,
    },
    {
      key: 'stroke_native',
      label: 'Stroke core mask (native)',
      filename: `${subjectId}_stroke-mask.nii.gz`,
      bytes: strokeNativeBytes,
      isOverlay: true,
      editable: true,
    },
    {
      key: 'brain_mask',
      label: 'DWI brain mask (native)',
      filename: `${subjectId}_DWIbrain-mask.nii.gz`,
      bytes: await writeNiftiGz(brainMaskVol),
      isOverlay: true,
    },
  );

  // Step 4: Optional 4D PWI -> TTP -> DAGMNet PWI hypoperfusion + mismatch
  let mismatch = null;
  if (mode === 'dwi-pwi' && files.pwi) {
    progress(0.56, 'Reading 4D PWI series…');
    // Load in native acquisition order first so BIDS SliceTiming aligns with acquisition slices.
    const pwiRaw = await loadNifti4DRawBytes(await files.pwi.arrayBuffer());
    const minPwiFrames = TTP_DEFAULTS.baselineVolumesMin + TTP_DEFAULTS.skipVolumes + 3;
    if (pwiRaw.dims[3] < minPwiFrames) {
      throw new Error(
        `PWI input must be a 4D perfusion series with at least ${minPwiFrames} time frames (received ${pwiRaw.dims[3]}).`,
      );
    }
    let pwiMeta = null;
    if (files['pwi-json']) {
      try {
        pwiMeta = JSON.parse(await files['pwi-json'].text());
      } catch (err) {
        throw new Error(`Invalid PWI JSON sidecar: ${err.message}`);
      }
    }
    const rawTr = Number.isFinite(pwiMeta?.RepetitionTime) && pwiMeta.RepetitionTime > 0
      ? (pwiMeta.RepetitionTime > 20 ? pwiMeta.RepetitionTime / 1000 : pwiMeta.RepetitionTime)
      : pwiRaw.pixdim[3] > 0
        ? pwiRaw.pixdim[3]
        : 1.7;
    const echoTime = Number.isFinite(pwiMeta?.EchoTime) && pwiMeta.EchoTime > 0
      ? (pwiMeta.EchoTime > 1 ? pwiMeta.EchoTime / 1000 : pwiMeta.EchoTime)
      : TTP_DEFAULTS.echoTime;
    const sliceTiming = Array.isArray(pwiMeta?.SliceTiming) ? pwiMeta.SliceTiming : null;
    if (sliceTiming && sliceTiming.length !== pwiRaw.dims[2]) {
      throw new Error(
        `PWI SliceTiming length (${sliceTiming.length}) does not match acquisition slice count (${pwiRaw.dims[2]}).`,
      );
    }

    progress(0.57, 'Applying slice-time correction in acquisition order…');
    const stcRaw = sliceTimeCorrection(pwiRaw.voxels, pwiRaw.dims, rawTr, sliceTiming);
    const pwi4d = reorientVolume4DToRAS({ ...pwiRaw, voxels: stcRaw.data });

    const pwiFrame0 = extractFrame3D(pwi4d, 0);
    const pwiMask = await stripBrain(pwiFrame0, 0.58, 0.06);
    const pwiMaskVol = { ...pwiFrame0, voxels: Float32Array.from(pwiMask) };

    progress(0.65, 'Computing Time-To-Peak (TTP) perfusion map…');
    const ttpRes = computeTtpVolume({
      pwi: pwi4d.voxels,
      dims: pwi4d.dims,
      pixdim: [pwi4d.pixdim[0], pwi4d.pixdim[1], pwi4d.pixdim[2], rawTr],
      mask: pwiMask,
      skipSliceTimeCorrection: true,
      echoTime,
      onProgress: (stage) => log(`TTP: ${stage}`),
    });
    const ttpNativeVol = { ...pwiFrame0, voxels: ttpRes.ttp };

    progress(0.7, 'Coregistering PWI/TTP to DWI and MNI152…');
    const coregRes = ants.registerWithArgs({
      fixed: movingMaskBytes,
      moving: writeNiftiFloat32(pwiMaskVol),
      buildArgs: openAdsAffineArgs,
      transformNames: ['0GenericAffine.mat'],
    });
    const coregMat = coregRes.transforms['0GenericAffine.mat'];
    const ttpOnDwiBytes = ants.applyTransforms({
      fixed: movingMaskBytes,
      moving: writeNiftiFloat32(ttpNativeVol),
      transforms: [{ name: 'coreg.mat', bytes: coregMat }],
      interpolation: 'linear',
    });
    const ttpOnDwiVol = maskVolume(await loadNiftiBytes(ttpOnDwiBytes), brainMask);
    const ttpMniBytes = ants.applyTransforms({
      fixed: affineTemplateBytes,
      moving: writeNiftiFloat32(ttpOnDwiVol),
      transforms: [{ name: 'dwi_aff.mat', bytes: dwiAffineMat }],
      interpolation: 'linear',
    });
    const ttpMniVol = await loadNiftiBytes(ttpMniBytes);

    const normInMask = (v) => zscoreInMask(percentileClipRescaleInMask(v, affMaskBin), affMaskBin);
    const hpSeg = await runDagmnetOnnx(
      'models/dagmnet_pwi_ch4.onnx',
      runDagmnetPwi,
      {
        dwi: normInMask(affDwiVol.voxels),
        adc: normInMask(affAdcVol.voxels),
        ttp: normInMask(ttpMniVol.voxels),
        strokeMask: strokeMniVol.voxels,
        dims: affDwiVol.dims,
        threshold,
      },
      0.73,
      0.13,
      'DAGMNet PWI',
    );
    log(`DAGMNet PWI segmented ${hpSeg.lesionVoxels.toLocaleString()} hypoperfusion voxels`);

    const hpMniVol = {
      dims: affDwiVol.dims,
      pixdim: affDwiVol.pixdim,
      affine: affDwiVol.affine,
      voxels: Float32Array.from(hpSeg.mask),
    };
    const hpNativeBytes = ants.applyTransforms({
      fixed: writeNiftiFloat32(pwiFrame0),
      moving: writeNiftiFloat32(hpMniVol),
      transforms: [
        { name: 'coreg.mat', bytes: coregMat, invert: true },
        { name: 'dwi_aff.mat', bytes: dwiAffineMat, invert: true },
      ],
      interpolation: 'nearest',
    });

    mismatch = computeMismatch(strokeMniVol.voxels, hpMniVol.voxels, affDwiVol.dims, affDwiVol.pixdim);
    outputVolumes.push(
      {
        key: 'ttp_mni',
        label: 'TTP perfusion map (MNI152)',
        filename: `${subjectId}_TTP_space-MNI152_aff.nii.gz`,
        bytes: await writeNiftiGz(ttpMniVol),
        isOverlay: false,
      },
      {
        key: 'hp_mni',
        label: 'Hypoperfusion mask (MNI152)',
        filename: `${subjectId}_HP-mask_space-MNI152.nii.gz`,
        bytes: await writeNiftiGz(hpMniVol),
        isOverlay: true,
        editable: true,
      },
      {
        key: 'hp_native',
        label: 'Hypoperfusion mask (native PWI)',
        filename: `${subjectId}_HP-mask.nii.gz`,
        bytes: hpNativeBytes,
        isOverlay: true,
      },
    );
  }

  // Step 5: Reporting + 29 RF models + TreeSHAP + StrokeView 1,861-patient cohort
  const reporting = await runReportingPipeline({
    subjectId,
    modality: 'DWI',
    lesionVol: strokeMniVol,
    adcMniVol: affAdcVol,
    brainMaskVol: { ...affDwiVol, voxels: Float32Array.from(affMaskBin) },
    mismatch,
    runShap,
    baseProgress: mode === 'dwi-pwi' ? 0.86 : 0.72,
    span: mode === 'dwi-pwi' ? 0.13 : 0.27,
  });

  progress(1, 'Analysis complete.');
  return {
    mode,
    elapsedSeconds: Math.round((performance.now() - started) / 100) / 10,
    reporting,
    outputVolumes,
  };
}

self.onmessage = async ({ data: job }) => {
  try {
    const result = await runJob(job);
    const transfers = result.outputVolumes.map((v) => v.bytes.buffer);
    self.postMessage({ type: 'result', result }, transfers);
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
