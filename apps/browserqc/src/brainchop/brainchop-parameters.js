export { inferenceModelsList, brainChopOpts }

const brainChopOpts = {
  // General settings for input shape [batchSize, batch_D, batch_H, batch_W, numOfChan]
  batchSize: 1, // How many batches are used during each inference iteration
  numOfChan: 1, // num of channel of the input shape
  isColorEnable: true, // If false, grey scale will enabled
  isAutoColors: true, // If false, manualColorsRange will be in use
  bgLabelValue: 0, // Semenatic Segmentation background label value
  drawBoundingVolume: false, // plot bounding volume used to crop the brain
  isGPU: true, //use WebGL/GPU (faster) or CPU (compatibility)
  isBrainCropMaskBased: true, // Check if brain masking will be used for cropping & optional show or brain tissue will be used
  showPhase1Output: false, // This will load to papaya the output of phase-1 (ie. brain mask or brain tissue)
  isPostProcessEnable: true, // If true 3D Connected Components filter will apply
  fillSuppressedWithNeighborLabel: false, // If true, blobs dropped by the per-class "largest component" filter are repainted with their surrounding surviving label instead of background (adds one linear neighbour pass; applies to per-class models e.g. 3/8/9, 5/14, 1/7 — not the binary brain-mask path)
  diagnoseEnclosedComponents: false, // DEBUG: if true, log per-component stats (class, size, largest-of-class?, dominant neighbour & enclosure) for 104-class models to the console. Output-neutral; used to tune island absorption.
  isContoursViewEnable: false, // If true 3D contours of the labeled regions will apply
  browserArrayBufferMaxZDim: 30, // This value depends on Memory available
  telemetryFlag: false, // Ethical and transparent collection of browser usage while adhering to security and privacy standards
  chartXaxisStepPercent: 10, // percent from total labels on Xaxis
  uiSampleName: 'BC_UI_Sample', // Sample name used by interface
  atlasSelectedColorTable: 'Fire' // Select from ["Hot-and-Cold", "Fire", "Grayscale", "Gold", "Spectrum"]
}

// Inference Models, the ids must start from 1 in sequence
const inferenceModelsList = [
  {
    id: 1,
    type: 'Segmentation',
    path: '/models/model5_gw_ae/model.json',
    modelName: '\u26A1 Tissue GWM (light)',
    colormapPath: './models/model5_gw_ae/colormap3.json',
      webgpu_safetensor: './models/model5_gw_ae/model.safetensors', webgpu_runner: 'model5', //'model5_gw_ae',
          webgpuTTArunner: true,
    preModelId: null, // Model run first e.g.  crop the brain   { null, 1, 2, ..  }
    preModelPostProcess: false, // If true, perform postprocessing to remove noisy regions after preModel inference generate output.
    isBatchOverlapEnable: false, // create extra overlap batches for inference
    numOverlapBatches: 0, // Number of extra overlap batches for inference
    enableTranspose: true, // Keras and tfjs input orientation may need a tranposing step to be matched
    enableCrop: true, // For speed-up inference, crop brain from background before feeding to inference model to lower memory use.
    cropPadding: 18, // Padding size add to cropped brain
    autoThreshold: 0, // Threshold between 0 and 1, given no preModel and tensor is normalized either min-max or by quantiles. Will remove noisy voxels around brain
    enableQuantileNorm: false, // Some models needs Quantile Normaliztion.
    filterOutWithPreMask: false, // Can be used to multiply final output with premodel output mask to crean noisy areas
    enableSeqConv: false, // For low memory system and low configuration, enable sequential convolution instead of last layer
    textureSize: 0, // Requested Texture size for the model, if unknown can be 0.
    warning: null, // Warning message to show when select the model.
    inferenceDelay: 100, // Delay in ms time while looping layers applying.
    description:
      'Gray and white matter segmentation model. Operates on full T1 image in a single pass, but uses only 5 filters per layer. Can work on integrated graphics cards but is barely large enough to provide good accuracy. Still more accurate than the subvolume model.'
  },
  {
    id: 2,
    type: 'Brain_Extraction',
    path: '/models/mindgrab/model.json',
    modelName: '\u{1FA93}\u{1F9E0} omnimodal Skull Stripping',
    webgpu_safetensor: './models/mindgrab/model.safetensors',
      webgpu_runner: 'mindgrab',
      webgpuTTArunner: true,
    preModelId: null, // Model run first e.g.  crop the brain  { null, 1, 2, ..  }
    preModelPostProcess: false, // If true, perform postprocessing to remove noisy regions after preModel inference generate output.
    isBatchOverlapEnable: false, // create extra overlap batches for inference
    numOverlapBatches: 0, // Number of extra overlap batches for inference
    enableTranspose: true, // Keras and tfjs input orientation may need a tranposing step to be matched
    isPostProcessEnable: true, // If true 3D Connected Components filter will apply
    enableCrop: true, // For speed-up inference, crop brain from background before feeding to inference model to lower memory use.
    cropPadding: 20, // Padding size add to cropped brain
    autoThreshold: 0.5, // Threshold between 0 and 1, given no preModel and tensor is normalized either min-max or by quantiles. Will remove noisy voxels around brain
    enableQuantileNorm: true, // Some models needs Quantile Normaliztion.
    filterOutWithPreMask: false, // Can be used to multiply final output with premodel output mask to crean noisy areas
    enableSeqConv: false, // For low memory system and low configuration, enable sequential convolution instead of last layer
    textureSize: 0, // Requested Texture size for the model, if unknown can be 0.
    warning:
      "This model may need dedicated graphics card.  For more info please check with Browser Resources <i class='fa fa-cogs'></i>.",
    inferenceDelay: 100, // Delay in ms time while looping layers applying.
    description:
      'The omnimodal skull stripping model delivers high-accuracy brain extraction in seconds, supporting multiple imaging modalities including T1, T2, FLAIR, DWI, EPI, MRA, PDw, CT, and PET without a need for tuning. It runs in a single pass with only 15 filters per layer, and is offered in high-memory/fast and low-memory/slow configurations. Use it today to improve and accelerate your brain extraction!'
  },
  {
    // Default Subcortical + GWM: now backed by the deep gridding-free MeshNet
    // model16chan18cls (16 channels, 13 conv + 1x1, affine GroupNorm + GELU,
    // dilations -> 31 / RF=255). Lightest/fastest of the deep 18-class family;
    // the WebGPU build is good enough to be the default (replaces the old
    // model30chan18cls here). Same family as the Heavy variant (id 8).
    // Assets in public/models/model16chan18cls/:
    //   WebGPU fp16 : model16chan18cls_runner.js     + model.safetensors
    //   WebGPU fp32 : model16chan18cls_f32_runner.js + model_f32.safetensors
    //   WebGL2      : model.json (tfjs topology)      + model.bin
    id: 3,
    type: 'Atlas',
    path: '/models/model16chan18cls/model.json',
    modelName: '\u{1FA93} Subcortical + GWM',
    colormapPath: './models/model16chan18cls/colormap.json',
    webgpu_safetensor: './models/model16chan18cls/model.safetensors',
    webgpu_runner: 'model16chan18cls',
    forceFP32: false, // fp16 default; fp32 auto-used only if device lacks shader-f16 AND the _f32 runner exists.
    webgpuStorageSize: 1073741824, // 16 * 256^3 * 4 = 1 GiB largest full-volume f32 conv buffer.
    numClasses: 18,
    preModelId: null, // gridding-free (RF=255): full head, no pre-model/crop on WebGPU.
    preModelPostProcess: false,
    isBatchOverlapEnable: false,
    numOverlapBatches: 0,
    enableTranspose: true, // Keras and tfjs input orientation may need a tranposing step to be matched
    enableCrop: true, // WebGL2 fallback only (texture limit); WebGPU runs the full volume.
    cropPadding: 20, // Padding size add to cropped brain
    autoThreshold: 0, // Threshold between 0 and 1, given no preModel and tensor is normalized either min-max or by quantiles. Will remove noisy voxels around brain
    enableQuantileNorm: true, // synth18/turbo16 trained with quantile normalization -- must match at inference. Do NOT set false.
    filterOutWithPreMask: false, // Can be used to multiply final output with premodel output mask to crean noisy areas
    enableSeqConv: true, // For low memory system and low configuration, enable sequential convolution instead of last layer
    textureSize: 0, // Requested Texture size for the model, if unknown can be 0.
    warning:
      "This model may need dedicated graphics card.  For more info please check with Browser Resources <i class='fa fa-cogs'></i>.", // Warning message to show when select the model.
    inferenceDelay: 100, // Delay in ms time while looping layers applying.
    description:
      'Parcellation of the brain into 17 regions: gray and white matter plus subcortical areas. A deep 16-channel gridding-free MeshNet (affine GroupNorm + GELU), synth-trained for robustness across data quality including varying saturation and clinical scans. The lightest/fastest of the Subcortical + GWM family.'
  },
  {
    id: 4,
    type: 'Atlas',
    path: '/models/model30chan50cls/model.json',
    modelName: '\u{1F52A} Aparc+Aseg 50',
    colormapPath: './models/model30chan50cls/colormap.json',
      webgpu_safetensor: './models/model30chan50cls/model.safetensors', webgpu_runner: 'model30chan50cls',
          webgpuTTArunner: true,
    preModelId: null, // Model run first e.g.  crop the brain  { null, 1, 2, ..  }
    preModelPostProcess: false, // If true, perform postprocessing to remove noisy regions after preModel inference generate output.
    isBatchOverlapEnable: false, // create extra overlap batches for inference
    numOverlapBatches: 200, // Number of extra overlap batches for inference
    enableTranspose: true, // Keras and tfjs input orientation may need a tranposing step to be matched
    enableCrop: true, // For speed-up inference, crop brain from background before feeding to inference model to lower memory use.
    cropPadding: 0, // Padding size add to cropped brain
    autoThreshold: 0, // Threshold between 0 and 1, given no preModel and tensor is normalized either min-max or by quantiles. Will remove noisy voxels around brain
    enableQuantileNorm: true, // Some models needs Quantile Normaliztion.
    filterOutWithPreMask: false, // Can be used to multiply final output with premodel output mask to crean noisy areas
    enableSeqConv: false, // For low memory system and low configuration, enable sequential convolution instead of last layer
    textureSize: 0, // Requested Texture size for the model, if unknown can be 0.
    warning:
      "This model may need dedicated graphics card.  For more info please check with Browser Resources <i class='fa fa-cogs'></i>.", // Warning message to show when select the model.
    inferenceDelay: 100, // Delay in ms time while looping layers applying.
    description:
      'This is a 50-class model, that segments the brain into the Aparc+Aseg Freesurfer Atlas but one where cortical homologues are merged into a single class.'
  },
  {
    // Primary 104-class DK-atlas model. Synth-trained 24ch/104cls gridding-free
    // MeshNet (affine GroupNorm + GELU), promoted into the canonical Aparc+Aseg 104
    // slot -- replaces the real-data model24chan104cls entry and the legacy
    // 21-channel model21_104class. Weights converted from catalyst
    // synth104_gn_hdc_deep_turbo24_fromreal. Full artifact set in
    // public/models/model24chan104cls_synth/:
    //   WebGPU fp16 : dkatlas24_synth_runner.js     + model.safetensors
    //   WebGPU fp32 : dkatlas24_synth_f32_runner.js + model_f32.safetensors
    //   WebGL2      : model.json (tfjs topology)     + model.bin
    id: 5,
    type: 'Atlas',
    path: '/models/model24chan104cls_synth/model.json',
    modelName: '\u{1FA93}\u{1F52A} Aparc+Aseg 104',
    colormapPath: './models/model24chan104cls_synth/colormap.json',
    webgpu_safetensor: './models/model24chan104cls_synth/model.safetensors',
    webgpu_runner: 'dkatlas24_synth', // dedicated runner; fp16 export uses the lossless conv-weight rescale (overflow-safe fast f16 GroupNorm)
    forceFP32: false, // false -> fp16 runner (dkatlas24_synth_runner.js + model.safetensors).
                      // true  -> fp32 runner (dkatlas24_synth_f32_runner.js + model_f32.safetensors).
    webgpuStorageSize: 1610612736,
    numClasses: 104,
    preModelId: null, // No pre-model; run the full head like the CLI.
    preModelPostProcess: false,
    isBatchOverlapEnable: false,
    numOverlapBatches: 0,
    enableTranspose: true,
    enableCrop: true, // WebGL2 fallback needs this (texture limit); WebGPU ignores it and runs full volume.
    cropPadding: 20,
    autoThreshold: 0,
    enableQuantileNorm: true, // synth104 trained with quantile normalization (catalyst pipeline) -- must match at inference (inference-webgpu.js / inference-logic.js). Do NOT set false.
    filterOutWithPreMask: false,
    enableSeqConv: true,
    textureSize: 0,
    warning:
      "This model may need a dedicated graphics card.  For more info please check with Browser Resources <i class='fa fa-cogs'></i>.",
    inferenceDelay: 100,
    description:
      'Desikan-Killiany atlas parcellation into 104 regions (cortical + subcortical). A deep 24-channel gridding-free MeshNet with affine GroupNorm and GELU, synth-trained for robustness across data quality. Runs on WebGL2 and WebGPU (fp16 default, fp32 selectable).'
  },
  {
    id: 6,
    type: 'Divider',
    modelName: '-----------------',
    path: null
  },
  {
    id: 7,
    type: 'Segmentation',
    path: '/models/model_sae16ch3_tfjs/model.json',
    modelName: '\u{1FA93} Tissue GWM',
    colormapPath: './models/model_sae16ch3_tfjs/colormap.json',
    webgpu_safetensor: './models/model_sae16ch3_tfjs/model.safetensors', webgpu_runner: 'robust_tissue', // 'model21_104class',
    webgpuTTArunner: true,
    preModelId: null, // Model run first e.g.  crop the brain   { null, 1, 2, ..  }
    preModelPostProcess: false, // If true, perform postprocessing to remove noisy regions after preModel inference generate output.
    isBatchOverlapEnable: false, // create extra overlap batches for inference
    numOverlapBatches: 0, // Number of extra overlap batches for inference
    enableTranspose: true, // Keras and tfjs input orientation may need a tranposing step to be matched
    webglEnableTranspose: false, // WebGL-only override: this model's tfjs export expects the UNtransposed orientation (unlike its WebGPU safetensors export, which needs enableTranspose:true). With transpose on, the WebGL segmentation degrades to noise. WebGPU is unaffected by this flag.
    enableCrop: false, // For speed-up inference, crop brain from background before feeding to inference model to lower memory use.
    cropPadding: 10, // Padding size add to cropped brain
      inputPermutation: null, // [0, 1, 2] etc. Overrides enableTranspose if set.
      outputPermutation: null, // Inverse of inputPermutation.
    outputShift: [0, 0, 0], // No shift: matches the (correct) WebGPU display. outputShift is a WebGL-only correction (restoreToOriginalSize); the WebGPU path ignores it, so a non-zero value here desyncs WebGL from WebGPU by that many voxels. [Row, Col, Depth]
    forceFP32: false, // Force float32 precision for better quality
    ttaFlipAxis: 0, // Axis to flip for TTA (1 = Depth/Width depending on transpose)
    autoThreshold: 0.2, // Threshold between 0 and 1, given no preModel and tensor is normalized either min-max or by quantiles. Will remove noisy voxels around brain
    enableQuantileNorm: true, // Some models needs Quantile Normaliztion.
    filterOutWithPreMask: false, // Can be used to multiply final output with premodel output mask to crean noisy areas
    enableSeqConv: false, // For low memory system and low configuration, enable sequential convolution instead of last layer
    textureSize: 0, // Requested Texture size for the model, if unknown can be 0.
    warning:
      "This model may need dedicated graphics card.  For more info please check with Browser Resources <i class='fa fa-cogs'></i>.",
    inferenceDelay: 100, // Delay in ms time while looping layers applying.
    description:
      'Omnimodal gray and white matter segmentation model using SpatialAE architecture with swish activation. Operates on full T1 image in a single pass but needs a dedicated graphics card to operate.'
  },
  {
    // Subcortical + GWM (Heavy): the deep gridding-free MeshNet model32chan18cls
    // (32 channels, 13 conv + 1x1, affine GroupNorm + GELU, dilations -> 31 / RF=255),
    // same architecture family as the Aparc+Aseg 104 model. Higher capacity than the
    // default model30chan18cls (id 3) but much heavier: full-volume, ~2 GiB f32 conv
    // buffer, noticeably slower in-browser -- offered as an opt-in "Heavy" choice.
    // Assets in public/models/model32chan18cls/:
    //   WebGPU fp16 : model32chan18cls_runner.js     + model.safetensors     (present; re-export with --beam>=2 to speed up)
    //   WebGPU fp32 : model32chan18cls_f32_runner.js + model_f32.safetensors  (pending)
    //   WebGL2      : model.json (tfjs topology)      + model.bin             (pending)
    id: 8,
    type: 'Atlas',
    path: '/models/model32chan18cls/model.json',
    modelName: '\u{1FA93} Subcortical + GWM (Heavy)',
    colormapPath: './models/model32chan18cls/colormap.json',
    webgpu_safetensor: './models/model32chan18cls/model.safetensors',
    webgpu_runner: 'model32chan18cls',
    forceFP32: false, // fp16 default; fp32 auto-used only if device lacks shader-f16 AND the _f32 runner exists.
    webgpuStorageSize: 2147483648, // 32 * 256^3 * 4 = 2 GiB largest full-volume f32 conv buffer. Exceeds Firefox's ~1 GiB cap -> WebGL2 fallback there.
    numClasses: 18,
    preModelId: null, // gridding-free (RF=255): full head, no pre-model/crop on WebGPU.
    preModelPostProcess: false,
    isBatchOverlapEnable: false,
    numOverlapBatches: 0,
    enableTranspose: true,
    enableCrop: true, // WebGL2 fallback only (texture limit); WebGPU runs the full volume.
    cropPadding: 20,
    autoThreshold: 0,
    enableQuantileNorm: true, // model32chan18cls trained with quantile normalization -- must match at inference. Do NOT set false.
    filterOutWithPreMask: false,
    enableSeqConv: true,
    textureSize: 0,
    warning:
      "Heavy model: needs a dedicated graphics card and is slower than the default Subcortical + GWM. For more info please check with Browser Resources <i class='fa fa-cogs'></i>.",
    inferenceDelay: 100,
    description:
      'Higher-capacity subcortical + gray/white matter parcellation (17 regions) using a deep 32-channel gridding-free MeshNet (affine GroupNorm + GELU). More robust but heavier and slower in-browser than the default Subcortical + GWM (id 3). WebGPU fp16; WebGL2 fallback and fp32 require the pending asset conversions.'
  },
  {
    id: 10,
    type: 'Brain_Extraction',
    path: '/models/model5_gw_ae/model.json',
    modelName: '\u26A1 Extract the Brain (FAST)',
    preModelId: null, // Model run first e.g.  crop the brain  { null, 1, 2, ..  }
    preModelPostProcess: false, // If true, perform postprocessing to remove noisy regions after preModel inference generate output.
    isBatchOverlapEnable: false, // create extra overlap batches for inference
    numOverlapBatches: 0, // Number of extra overlap batches for inference
    enableTranspose: true, // Keras and tfjs input orientation may need a tranposing step to be matched
    enableCrop: true, // For speed-up inference, crop brain from background before feeding to inference model to lower memory use.
    cropPadding: 18, // Padding size add to cropped brain
    autoThreshold: 0, // Threshold between 0 and 1, given no preModel and tensor is normalized either min-max or by quantiles. Will remove noisy voxels around brain
    enableQuantileNorm: false, // Some models needs Quantile Normaliztion.
    filterOutWithPreMask: false, // Can be used to multiply final output with premodel output mask to crean noisy areas
    enableSeqConv: false, // For low memory system and low configuration, enable sequential convolution instead of last layer
    textureSize: 0, // Requested Texture size for the model, if unknown can be 0.
    warning: null, // Warning message to show when select the model.
    inferenceDelay: 100, // Delay in ms time while looping layers applying.
    description:
      'Extract the brain fast model operates on full T1 image in a single pass, but uses only 5 filters per layer. Can work on integrated graphics cards but is barely large enough to provide good accuracy. Still more accurate than the failsafe version.'
  },
  {
    id: 11,
    type: 'Brain_Extraction',
    path: '/models/model11_gw_ae/model.json',
    modelName: '\u{1F52A} Extract the Brain (High Acc, Slow)',
    preModelId: null, // Model run first e.g.  crop the brain  { null, 1, 2, ..  }
    preModelPostProcess: false, // If true, perform postprocessing to remove noisy regions after preModel inference generate output.
    isBatchOverlapEnable: false, // create extra overlap batches for inference
    numOverlapBatches: 0, // Number of extra overlap batches for inference
    enableTranspose: true, // Keras and tfjs input orientation may need a tranposing step to be matched
    enableCrop: true, // For speed-up inference, crop brain from background before feeding to inference model to lower memory use.
    cropPadding: 0, // Padding size add to cropped brain
    autoThreshold: 0, // Threshold between 0 and 1, given no preModel and tensor is normalized either min-max or by quantiles. Will remove noisy voxels around brain
    enableQuantileNorm: false, // Some models needs Quantile Normaliztion.
    filterOutWithPreMask: false, // Can be used to multiply final output with premodel output mask to crean noisy areas
    enableSeqConv: true, // For low memory system and low configuration, enable sequential convolution instead of last layer
    textureSize: 0, // Requested Texture size for the model, if unknown can be 0.
    warning:
      "This model may need dedicated graphics card.  For more info please check with Browser Resources <i class='fa fa-cogs'></i>.",
    inferenceDelay: 100, // Delay in ms time while looping layers applying.
    description:
      'Extract the brain high accuracy model operates on full T1 image in a single pass, but uses only 11 filters per layer. Can work on dedicated graphics cards. Still more accurate than the fast version.'
  },
  {
    id: 12,
    type: 'Brain_Masking',
    path: '/models/model5_gw_ae/model.json',
    modelName: '\u26A1 Brain Mask (FAST)',
    colormapPath: './models/model5_gw_ae/colormap.json',
    preModelId: null, // Model run first e.g.  crop the brain  { null, 1, 2, ..  }
    preModelPostProcess: false, // If true, perform postprocessing to remove noisy regions after preModel inference generate output.
    isBatchOverlapEnable: false, // create extra overlap batches for inference
    numOverlapBatches: 0, // Number of extra overlap batches for inference
    enableTranspose: true, // Keras and tfjs input orientation may need a tranposing step to be matched
    enableCrop: true, // For speed-up inference, crop brain from background before feeding to inference model to lower memory use.
    cropPadding: 17, // Padding size add to cropped brain
    autoThreshold: 0, // Threshold between 0 and 1, given no preModel and tensor is normalized either min-max or by quantiles. Will remove noisy voxels around brain
    enableQuantileNorm: false, // Some models needs Quantile Normaliztion.
    filterOutWithPreMask: false, // Can be used to multiply final output with premodel output mask to crean noisy areas
    enableSeqConv: false, // For low memory system and low configuration, enable sequential convolution instead of last layer
    textureSize: 0, // Requested Texture size for the model, if unknown can be 0.
    warning: null, // Warning message to show when select the model.
    inferenceDelay: 100, // Delay in ms time while looping layers applying.
    description:
      'This fast masking model operates on full T1 image in a single pass, but uses only 5 filters per layer. Can work on integrated graphics cards but is barely large enough to provide good accuracy. Still more accurate than failsafe version.'
  },
  {
    id: 13,
    type: 'Brain_Masking',
    path: '/models/model11_gw_ae/model.json',
    modelName: '\u{1F52A} Brain Mask (High Acc, Low Mem)',
    preModelId: null, // Model run first e.g.  crop the brain  { null, 1, 2, ..  }
    preModelPostProcess: false, // If true, perform postprocessing to remove noisy regions after preModel inference generate output.
    isBatchOverlapEnable: false, // create extra overlap batches for inference
    numOverlapBatches: 0, // Number of extra overlap batches for inference
    enableTranspose: true, // Keras and tfjs input orientation may need a tranposing step to be matched
    enableCrop: true, // For speed-up inference, crop brain from background before feeding to inference model to lower memory use.
    cropPadding: 0, // Padding size add to cropped brain
    autoThreshold: 0, // Threshold between 0 and 1, given no preModel and tensor is normalized either min-max or by quantiles. Will remove noisy voxels around brain
    enableQuantileNorm: true, // Some models needs Quantile Normaliztion.
    filterOutWithPreMask: false, // Can be used to multiply final output with premodel output mask to crean noisy areas
    enableSeqConv: true, // For low memory system and low configuration, enable sequential convolution instead of last layer
    textureSize: 0, // Requested Texture size for the model, if unknown can be 0.
    warning:
      "This model may need dedicated graphics card.  For more info please check with Browser Resources <i class='fa fa-cogs'></i>.",
    inferenceDelay: 100, // Delay in ms time while looping layers applying.
    description:
      'This masking model operates on full T1 image in a single pass, but uses 11 filters per layer. Can work on dedicated graphics cards. Still more accurate than fast version.'
  },
] // inferenceModelsList
