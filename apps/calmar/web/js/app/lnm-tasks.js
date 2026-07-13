// Pipeline + stage manifest for the CALMaR webapp.
//
// A pipeline is a named sequence of stages. Each stage names the JS module
// that implements it plus the asset IDs it requires (model, atlas, or
// connectome). Asset IDs resolve against web/models/manifest.json so the
// loader can fetch the correct file from a CDN.
//
// Phase 1 shipped the 'lnm-yeo-only' compatibility pipeline (manual lesion mask
// in MNI space -> Yeo 7-network overlap). The visible app now uses the Atlas
// selector to choose the overlap atlas/connectome while retaining those hidden
// Yeo paths for old smoke tests and programmatic manual-mask runs.

export const LNM_PIPELINES = [
  {
    id: 'lnm-yeo-only',
    // Phase 39: hidden from the dropdown — the visible UI assumes raw T1
    // input. Manual-mask path stays runnable for power users via the
    // "Researcher mode" file input under Advanced; auto-promote in
    // setLesion() switches to lnm-network-map (also hidden) when a mask
    // is dropped. lnm-yeo-only is a strict subset of lnm-network-map
    // and is kept for tests + back-compat with old smokes.
    hidden: true,
    displayName: 'Yeo 7-network overlap (manual mask)',
    description:
      'Upload a lesion mask already in MNI152 space. Reports per-network ' +
      'overlap with the Yeo 2011 7-network parcellation.',
    stages: [
      {
        id: 'overlap',
        module: 'parcel-overlap',
        atlasAssetId: 'yeo7-2mm',
        required: true
      }
    ]
  },
  {
    id: 'lnm-segment-only',
    displayName: 'Auto-segment lesion (T1 + SynthStrip)',
    description:
      'Drop a structural T1, then run analysis. Brain extraction ' +
      '(SynthStrip) runs first; the lesion-segmentation model ' +
      '(SynthStroke baseline) operates on the brain-masked structural and produces a ' +
      'binary lesion mask in the input image\'s native space, downloadable ' +
      'as NIfTI. No MNI registration or atlas overlap.',
    stages: [
      {
        id: 'brainmask',
        module: 'brain-extraction',
        modelAssetId: 'lnm-synthstrip',
        required: true
      },
      {
        id: 'segment',
        module: 'inference-pipeline',
        modelAssetId: 'lnm-stroke-lesion',
        required: true
      }
    ]
  },
  {
    id: 'lnm-network-map',
    // Phase 39: hidden from the dropdown — the visible UI assumes raw T1
    // input. setLesion() still auto-promotes to this pipeline when a
    // a Yeo-grid mask is provided through the hidden compatibility input
    // or when test_browser_smoke drives #lesionFileInput directly.
    hidden: true,
    displayName: 'Lesion network map (Yeo7 + group-FC pack)',
    description:
      'Manual-mask path with FC weighted sum: drop a binary lesion mask in ' +
      'MNI152NLin2009cAsym 2mm, get the per-network overlap (Phase 1) PLUS ' +
      'a brain-wide Yeo7-weighted FC t-map. Each Yeo network contributes its ' +
      'group-level t-stat connectivity map weighted by the lesion\'s share ' +
      'of that network. Output is a Float32 NIfTI on the Yeo7 atlas grid.',
    stages: [
      {
        id: 'overlap',
        module: 'parcel-overlap',
        atlasAssetId: 'yeo7-2mm',
        required: true
      },
      {
        id: 'fc',
        module: 'fc-weighted-sum',
        connectomeAssetId: 'yeo7-fc-pack',
        required: true
      },
      {
        id: 'threshold',
        module: 'threshold',
        required: false,
        defaults: { value: 5, symmetric: true, minClusterVoxels: 30 }
      }
    ]
  },
  {
    id: 'lnm-yeo-auto',
    displayName: 'Auto lesion network map (T1 -> SynthStrip -> prealign -> seg -> atlas)',
    description:
      'End-to-end automatic flow: drop ANY structural T1, get brain extraction + ' +
      'in-browser PCA prealign to MNI160 1mm + lesion segmentation, then SynthMorph ' +
      'deformable registration onto MNI152NLin2009cAsym, then selected-atlas overlap + ' +
      'group-FC weighted-sum + threshold. The prealign stage is no-op when the input ' +
      'is already 160x160x192 1mm.',
    stages: [
      {
        id: 'brainmask',
        module: 'brain-extraction',
        modelAssetId: 'lnm-synthstrip',
        required: true
      },
      {
        // Phase 34: prealign T1 (+ brainmask) to MNI160 1mm via centroid +
        // PCA. Lets the auto chain swallow arbitrary clinical T1s instead
        // of requiring an upstream FSL FLIRT step. No-op if input is
        // already at the SynthMorph-required pose.
        id: 'prealign',
        module: 'prealign',
        atlasAssetId: 'lnm-mni160',
        required: true
      },
      {
        id: 'segment',
        module: 'inference-pipeline',
        modelAssetId: 'lnm-stroke-lesion',
        required: true
      },
      {
        id: 'register',
        module: 'registration',
        modelAssetId: 'lnm-synthmorph-mni',
        atlasAssetId: 'lnm-mni160',
        required: true
      },
      {
        id: 'overlap',
        module: 'parcel-overlap',
        atlasAssetId: 'yeo7-2mm',
        required: true
      },
      {
        id: 'fc',
        module: 'fc-weighted-sum',
        connectomeAssetId: 'yeo7-fc-pack',
        required: true
      },
      {
        id: 'threshold',
        module: 'threshold',
        required: false,
        defaults: { value: 5, symmetric: true, minClusterVoxels: 30 }
      }
    ]
  },
  {
    id: 'lnm-default',
    // The visible Atlas selector is the public surface for Schaefer; keep this
    // legacy pipeline hidden so Run analysis stays input-driven.
    hidden: true,
    displayName: 'CALMaR (Schaefer400 / development fMRI)',
    description:
      'Full pipeline: ONNX lesion segmentation -> deep-learning MNI ' +
      'registration -> Schaefer400 parcel overlap -> per-parcel functional ' +
      'connectivity weighted sum (public development_fmri N=155) -> threshold.',
    stages: [
      {
        id: 'segment',
        module: 'inference-pipeline',
        modelAssetId: 'lnm-stroke-lesion',
        required: true,
        alternatives: [{ id: 'manual-mask', kind: 'upload' }]
      },
      {
        id: 'register',
        module: 'registration',
        modelAssetId: 'lnm-synthmorph-mni',
        required: true
      },
      {
        id: 'overlap',
        module: 'parcel-overlap',
        atlasAssetId: 'schaefer400-7n-2mm',
        required: true
      },
      {
        id: 'network',
        module: 'fc-weighted-sum',
        connectomeAssetId: 'schaefer400-fc-pack-development-n155-4mm',
        required: true
      },
      {
        id: 'threshold',
        module: 'threshold',
        required: false,
        defaults: {
          mode: 'percentile',
          value: 5,
          symmetric: true,
          minClusterVoxels: 30
        }
      }
    ]
  }
];

// Modules that have a working JS implementation in this phase. A stage whose
// module is not in this set is not runnable, even if its asset ID resolves.
const IMPLEMENTED_MODULES = new Set([
  'parcel-overlap',
  // Phase 2a.1: SynthStrip in web/js/modules/brain-extraction.js, dispatched
  // by the worker's 'run-synthstrip' op.
  'brain-extraction',
  // Phase 2a.2: SynthStroke baseline in web/js/inference-pipeline.js
  // (sliding-window patches), dispatched by the worker's 'run-inference' op.
  'inference-pipeline',
  // Phase 3: SynthMorph SVF in web/js/modules/registration.js + integrate /
  // upsample / warp helpers, dispatched by the worker's 'run-register' op.
  'registration',
  // Phase 4+: atlas-aware group-FC weighted sum in web/js/modules/fc-weighted-sum.js,
  // dispatched by the worker's 'run-fc-weighted-sum' op.
  'fc-weighted-sum',
  // Phase 5: applyThreshold in web/js/modules/threshold.js, driven by
  // the orchestrator's applyNetworkThreshold().
  'threshold',
  // Phase 16: in-browser PCA prealign to MNI160 1mm in
  // web/js/modules/prealign.js, driven by orchestrator.prealignToMni160().
  'prealign'
]);

export function getPipelineById(id) {
  return LNM_PIPELINES.find(p => p.id === id) || null;
}

export function getRequiredAssetIds(pipeline) {
  if (!pipeline) return [];
  const ids = [];
  for (const stage of pipeline.stages) {
    for (const key of ['modelAssetId', 'atlasAssetId', 'connectomeAssetId']) {
      if (stage[key]) ids.push(stage[key]);
    }
  }
  return Array.from(new Set(ids));
}

export function isStageRunnable(stage) {
  if (!stage || !stage.module) return false;
  if (!IMPLEMENTED_MODULES.has(stage.module)) return false;
  // A required stage must reference at least one asset (model/atlas/connectome)
  // OR opt out via required:false. This matches the SCT regression guard:
  // never silently fall back to a default when a required input is missing.
  if (stage.required) {
    const hasAsset = Boolean(
      stage.modelAssetId || stage.atlasAssetId || stage.connectomeAssetId
    );
    if (!hasAsset) return false;
  }
  return true;
}

// Phase 13: a pipeline is "runnable" only when every required stage is
// runnable AND the pipeline is not flagged hidden:true. Legacy/manual
// declarations stay hidden while Run analysis remains input-driven.
export function isPipelineRunnable(pipeline) {
  if (!pipeline || !Array.isArray(pipeline.stages)) return false;
  if (pipeline.hidden === true) return false;
  for (const stage of pipeline.stages) {
    if (stage.required === false) continue;
    if (!isStageRunnable(stage)) return false;
  }
  return true;
}
