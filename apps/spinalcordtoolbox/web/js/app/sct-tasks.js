import { VERSION, MODEL_BASE_URL } from './config.js';

export const SCT_STABLE_SOURCE = 'https://spinalcordtoolbox.com/stable/user_section/command-line/sct_deepseg.html';
const HF_DATASET_ASSET_REVISION = '55c9462a14bc9c84cf093c348cffda9148099df9';
const HF_DATASET_ASSET_BASE_URL = `https://huggingface.co/datasets/sbollmann/sct-webapp-data/resolve/${HF_DATASET_ASSET_REVISION}`;

export const TASK_STATUS = Object.freeze({
  SUPPORTED: 'supported',
  UNVALIDATED: 'unvalidated',
  UNSUPPORTED: 'unsupported',
  RETIRED: 'retired'
});

const SPINE_DISC_POINT_LABELS = Object.freeze([
  { index: 0, name: 'Background', color: [0, 0, 0, 0], meaning: 'Background' },
  { index: 3, name: 'C2-C3 disc', color: [48, 18, 59, 255], meaning: 'C2-C3 intervertebral disc point' },
  { index: 4, name: 'C3-C4 disc', color: [61, 52, 139, 255], meaning: 'C3-C4 intervertebral disc point' },
  { index: 5, name: 'C4-C5 disc', color: [70, 91, 208, 255], meaning: 'C4-C5 intervertebral disc point' },
  { index: 6, name: 'C5-C6 disc', color: [57, 132, 223, 255], meaning: 'C5-C6 intervertebral disc point' },
  { index: 7, name: 'C6-C7 disc', color: [39, 173, 220, 255], meaning: 'C6-C7 intervertebral disc point' },
  { index: 8, name: 'C7-T1 disc', color: [37, 207, 196, 255], meaning: 'C7-T1 intervertebral disc point' },
  { index: 9, name: 'T1-T2 disc', color: [55, 229, 165, 255], meaning: 'T1-T2 intervertebral disc point' },
  { index: 10, name: 'T2-T3 disc', color: [88, 242, 129, 255], meaning: 'T2-T3 intervertebral disc point' },
  { index: 11, name: 'T3-T4 disc', color: [129, 249, 96, 255], meaning: 'T3-T4 intervertebral disc point' },
  { index: 12, name: 'T4-T5 disc', color: [171, 246, 72, 255], meaning: 'T4-T5 intervertebral disc point' },
  { index: 13, name: 'T5-T6 disc', color: [210, 236, 57, 255], meaning: 'T5-T6 intervertebral disc point' },
  { index: 14, name: 'T6-T7 disc', color: [239, 218, 52, 255], meaning: 'T6-T7 intervertebral disc point' },
  { index: 15, name: 'T7-T8 disc', color: [253, 190, 45, 255], meaning: 'T7-T8 intervertebral disc point' },
  { index: 16, name: 'T8-T9 disc', color: [254, 159, 39, 255], meaning: 'T8-T9 intervertebral disc point' },
  { index: 17, name: 'T9-T10 disc', color: [247, 125, 35, 255], meaning: 'T9-T10 intervertebral disc point' },
  { index: 18, name: 'T10-T11 disc', color: [233, 91, 27, 255], meaning: 'T10-T11 intervertebral disc point' },
  { index: 19, name: 'T11-T12 disc', color: [209, 57, 21, 255], meaning: 'T11-T12 intervertebral disc point' },
  { index: 20, name: 'T12-L1 disc', color: [181, 32, 15, 255], meaning: 'T12-L1 intervertebral disc point' },
  { index: 21, name: 'L1-L2 disc', color: [150, 18, 12, 255], meaning: 'L1-L2 intervertebral disc point' },
  { index: 22, name: 'L2-L3 disc', color: [119, 14, 28, 255], meaning: 'L2-L3 intervertebral disc point' },
  { index: 23, name: 'L3-L4 disc', color: [93, 13, 52, 255], meaning: 'L3-L4 intervertebral disc point' },
  { index: 24, name: 'L4-L5 disc', color: [72, 12, 78, 255], meaning: 'L4-L5 intervertebral disc point' },
  { index: 25, name: 'L5-S disc', color: [51, 10, 103, 255], meaning: 'L5-S intervertebral disc point' }
]);

const TOTALSPINESEG_LABELS = Object.freeze([
  { index: 0, name: 'Background', color: [0, 0, 0, 0], meaning: 'Background' },
  { index: 1, name: 'Spinal cord', color: [68, 128, 255, 255], meaning: 'Spinal cord' },
  { index: 2, name: 'Spinal canal', color: [38, 191, 170, 255], meaning: 'Spinal canal' },
  { index: 11, name: 'C1', color: [48, 18, 59, 255], meaning: 'C1 vertebra' },
  { index: 50, name: 'Sacrum', color: [166, 64, 43, 255], meaning: 'Sacrum' },
  { index: 63, name: 'C2-C3 disc', color: [61, 52, 139, 255], meaning: 'C2-C3 intervertebral disc' },
  { index: 64, name: 'C3-C4 disc', color: [70, 91, 208, 255], meaning: 'C3-C4 intervertebral disc' },
  { index: 65, name: 'C4-C5 disc', color: [57, 132, 223, 255], meaning: 'C4-C5 intervertebral disc' },
  { index: 66, name: 'C5-C6 disc', color: [39, 173, 220, 255], meaning: 'C5-C6 intervertebral disc' },
  { index: 67, name: 'C6-C7 disc', color: [37, 207, 196, 255], meaning: 'C6-C7 intervertebral disc' },
  { index: 71, name: 'C7-T1 disc', color: [55, 229, 165, 255], meaning: 'C7-T1 intervertebral disc' },
  { index: 72, name: 'T1-T2 disc', color: [88, 242, 129, 255], meaning: 'T1-T2 intervertebral disc' },
  { index: 73, name: 'T2-T3 disc', color: [129, 249, 96, 255], meaning: 'T2-T3 intervertebral disc' },
  { index: 74, name: 'T3-T4 disc', color: [171, 246, 72, 255], meaning: 'T3-T4 intervertebral disc' },
  { index: 75, name: 'T4-T5 disc', color: [210, 236, 57, 255], meaning: 'T4-T5 intervertebral disc' },
  { index: 76, name: 'T5-T6 disc', color: [239, 218, 52, 255], meaning: 'T5-T6 intervertebral disc' },
  { index: 77, name: 'T6-T7 disc', color: [253, 190, 45, 255], meaning: 'T6-T7 intervertebral disc' },
  { index: 78, name: 'T7-T8 disc', color: [254, 159, 39, 255], meaning: 'T7-T8 intervertebral disc' },
  { index: 79, name: 'T8-T9 disc', color: [247, 125, 35, 255], meaning: 'T8-T9 intervertebral disc' },
  { index: 80, name: 'T9-T10 disc', color: [233, 91, 27, 255], meaning: 'T9-T10 intervertebral disc' },
  { index: 81, name: 'T10-T11 disc', color: [209, 57, 21, 255], meaning: 'T10-T11 intervertebral disc' },
  { index: 82, name: 'T11-T12 disc', color: [181, 32, 15, 255], meaning: 'T11-T12 intervertebral disc' },
  { index: 91, name: 'T12-L1 disc', color: [150, 18, 12, 255], meaning: 'T12-L1 intervertebral disc' },
  { index: 92, name: 'L1-L2 disc', color: [119, 14, 28, 255], meaning: 'L1-L2 intervertebral disc' },
  { index: 93, name: 'L2-L3 disc', color: [93, 13, 52, 255], meaning: 'L2-L3 intervertebral disc' },
  { index: 94, name: 'L3-L4 disc', color: [72, 12, 78, 255], meaning: 'L3-L4 intervertebral disc' },
  { index: 95, name: 'L4-L5 disc', color: [51, 10, 103, 255], meaning: 'L4-L5 intervertebral disc' },
  { index: 96, name: 'L5-L6 disc', color: [42, 9, 125, 255], meaning: 'L5-L6 intervertebral disc' },
  { index: 100, name: 'L5-S disc', color: [32, 8, 145, 255], meaning: 'L5-S intervertebral disc' }
]);

export const SCT_LABELS = Object.freeze({
  spinalcord: [
    { index: 0, name: 'Background', color: [0, 0, 0, 0], meaning: 'No spinal cord' },
    { index: 1, name: 'Spinal cord', color: [68, 128, 255, 255], meaning: 'Spinal cord segmentation' }
  ],
  graymatter: [
    { index: 0, name: 'Background', color: [0, 0, 0, 0], meaning: 'No gray matter' },
    { index: 1, name: 'Gray matter', color: [255, 184, 76, 255], meaning: 'Spinal cord gray matter' }
  ],
  vertebrae: [
    { index: 0, name: 'Background', color: [0, 0, 0, 0], meaning: 'Background' },
    { index: 1, name: 'Vertebral level 1', color: [48, 18, 59, 255], meaning: 'Vertebral level 1' },
    { index: 2, name: 'Vertebral level 2', color: [70, 75, 174, 255], meaning: 'Vertebral level 2' },
    { index: 3, name: 'Vertebral level 3', color: [60, 138, 222, 255], meaning: 'Vertebral level 3' },
    { index: 4, name: 'Vertebral level 4', color: [40, 191, 215, 255], meaning: 'Vertebral level 4' },
    { index: 5, name: 'Vertebral level 5', color: [60, 230, 160, 255], meaning: 'Vertebral level 5' },
    { index: 6, name: 'Vertebral level 6', color: [144, 248, 91, 255], meaning: 'Vertebral level 6' },
    { index: 7, name: 'Vertebral level 7', color: [216, 234, 53, 255], meaning: 'Vertebral level 7' },
    { index: 8, name: 'Vertebral level 8', color: [254, 187, 43, 255], meaning: 'Vertebral level 8' },
    { index: 9, name: 'Vertebral level 9', color: [251, 130, 38, 255], meaning: 'Vertebral level 9' },
    { index: 10, name: 'Vertebral level 10', color: [220, 65, 22, 255], meaning: 'Vertebral level 10' },
    { index: 11, name: 'Vertebral level 11', color: [165, 22, 11, 255], meaning: 'Vertebral level 11' }
  ],
  lesion: [
    { index: 0, name: 'Background', color: [0, 0, 0, 0], meaning: 'No lesion' },
    { index: 1, name: 'Lesion', color: [255, 66, 120, 255], meaning: 'Spinal cord lesion' }
  ],
  spineDiscs: SPINE_DISC_POINT_LABELS,
  totalspineseg: TOTALSPINESEG_LABELS,
  multiclass: [
    { index: 0, name: 'Background', color: [0, 0, 0, 0], meaning: 'Background' },
    { index: 1, name: 'Class 1', color: [68, 128, 255, 255], meaning: 'Task-defined class 1' },
    { index: 2, name: 'Class 2', color: [255, 184, 76, 255], meaning: 'Task-defined class 2' },
    { index: 3, name: 'Class 3', color: [255, 66, 120, 255], meaning: 'Task-defined class 3' }
  ]
});

export const SCT_TASKS = [
  {
    id: 'spinalcord',
    displayName: 'Spinal cord',
    category: 'spinal-cord',
    description: 'Contrast-agnostic spinal cord segmentation from SCT stable.',
    inputContrasts: ['T1w', 'T2w', 'T2star', 'MT', 'DWI', 'MP2RAGE', 'PSIR', 'STIR', 'EPI'],
    requiredInputs: [{ role: 'image', contrast: 'any supported spinal cord MRI contrast' }],
    outputType: 'binary-mask',
    labelSet: 'spinalcord',
    supportStatus: TASK_STATUS.SUPPORTED,
    validationStatus: 'passed',
    validationSummary: 'Converted SCT stable contrast-agnostic nnUNet package to ONNX and validated against the batch-processing fixture outputs.',
    modelAssets: [
      {
        id: 'sct-spinalcord',
        sourceUrl: 'https://spinalcordtoolbox.com/stable/user_section/command-line/deepseg/spinalcord.html',
        sourceVersion: 'stable',
        sourceFormat: 'SCT model package',
        browserFormat: 'onnx',
        filename: 'sct-spinalcord.onnx',
        downloadUrl: `${HF_DATASET_ASSET_BASE_URL}/web/models/sct-spinalcord.onnx`,
        conversionStatus: 'converted',
        checksum: 'sha256:5ada810b71b1ad6f445b805af899bd4f6c08f85045927450dc20d2395c1beddd',
        sizeBytes: 123468139,
        patchSize: [160, 224, 64],
        preprocessing: {
          modelOrientation: 'RPI',
          modelAxisOrder: 'zyx',
          targetSpacing: [0.8958333, 0.7, 1.0]
        },
        inferenceDefaults: {
          overlap: 0.5,
          probabilityThreshold: 0.5,
          minComponentSize: 0,
          keepLargestComponent: true,
          testTimeAugmentation: false
        }
      }
    ]
  },
  {
    id: 'sc_lumbar_t2',
    displayName: 'Lumbar spinal cord T2',
    category: 'spinal-cord',
    description: 'Lumbar-region spinal cord segmentation for T2-weighted data.',
    inputContrasts: ['T2w'],
    requiredInputs: [{ role: 'image', contrast: 'T2w lumbar spinal cord MRI' }],
    outputType: 'binary-mask',
    labelSet: 'spinalcord',
    supportStatus: TASK_STATUS.UNSUPPORTED,
    validationStatus: 'not-run',
    unsupportedReason: 'Not yet converted or validated for browser execution.',
    modelAssets: []
  },
  {
    id: 'sc_epi',
    displayName: 'Spinal cord EPI',
    category: 'spinal-cord',
    description: 'Spinal cord segmentation for EPI-BOLD fMRI images.',
    inputContrasts: ['EPI'],
    requiredInputs: [{ role: 'image', contrast: 'EPI-BOLD fMRI' }],
    outputType: 'binary-mask',
    labelSet: 'spinalcord',
    supportStatus: TASK_STATUS.UNSUPPORTED,
    validationStatus: 'not-run',
    unsupportedReason: 'Not yet converted or validated for browser execution.',
    modelAssets: []
  },
  {
    id: 'sc_mouse_t1',
    displayName: 'Mouse spinal cord T1',
    category: 'spinal-cord',
    description: 'Mouse spinal cord segmentation for T1-weighted data.',
    inputContrasts: ['T1w'],
    requiredInputs: [{ role: 'image', contrast: 'mouse T1w spinal cord MRI' }],
    outputType: 'binary-mask',
    labelSet: 'spinalcord',
    supportStatus: TASK_STATUS.UNSUPPORTED,
    validationStatus: 'not-run',
    unsupportedReason: 'Not yet converted or validated for browser execution.',
    modelAssets: []
  },
  {
    id: 'graymatter',
    displayName: 'Gray matter',
    category: 'gray-matter',
    description: 'Spinal cord gray matter segmentation.',
    inputContrasts: ['T2star'],
    requiredInputs: [{ role: 'image', contrast: 'T2star spinal cord MRI' }],
    outputType: 'binary-mask',
    labelSet: 'graymatter',
    supportStatus: TASK_STATUS.SUPPORTED,
    validationStatus: 'passed',
    validationSummary: 'Converted SCT stable gray matter nnUNet package to an ONNX browser wrapper and validated against the T2star batch fixture.',
    modelAssets: [
      {
        id: 'sct-graymatter',
        sourceUrl: 'https://spinalcordtoolbox.com/stable/user_section/command-line/sct_deepseg.html',
        sourceVersion: 'stable',
        sourceFormat: 'SCT model package',
        browserFormat: 'onnx',
        filename: 'sct-graymatter.onnx',
        downloadUrl: `${HF_DATASET_ASSET_BASE_URL}/web/models/sct-graymatter.onnx`,
        conversionStatus: 'converted',
        checksum: 'sha256:73c1d741aa2f2f38555e250b0d69b95ae72f8d69b56c162c424985660e705897',
        sizeBytes: 134270580,
        patchSize: [64, 64, 64],
        preprocessing: {
          modelAxisOrder: 'zyx'
        },
        inferenceDefaults: {
          probabilityThreshold: 0.5,
          minComponentSize: 1000,
          testTimeAugmentation: false
        }
      }
    ]
  },
  {
    id: 'vertebrae',
    displayName: 'Vertebral labeling',
    category: 'spinal-cord',
    description: 'Anatomical vertebral level labeling from a T2 volume and spinal cord segmentation.',
    inputContrasts: ['T2w'],
    requiredInputs: [
      { role: 'image', contrast: 'T2w spinal cord MRI' },
      { role: 'segmentation', contrast: 'spinal cord segmentation' }
    ],
    outputType: 'multi-label-mask',
    labelSet: 'vertebrae',
    supportStatus: TASK_STATUS.SUPPORTED,
    processingOnly: true,
    validationStatus: 'passed',
    validationSummary: 'Ports SCT C2-C3 HOG/SVM initialization and PAM50 vertebral level propagation for the browser fixture pipeline.',
    browserParityRequired: true,
    modelAssets: [],
    templateAssets: [
      {
        id: 'pam50-t2',
        filename: 'templates/PAM50/PAM50_t2.nii.gz',
        downloadUrl: `${HF_DATASET_ASSET_BASE_URL}/web/models/templates/PAM50/PAM50_t2.nii.gz`,
        sourceUrl: 'https://github.com/spinalcordtoolbox/PAM50',
        checksum: 'sha256:3e98b3275454e783a2683af0a6c895a9fa40c5c8da7eac9d6d478516fe85f0a8',
        sizeBytes: 24057343
      },
      {
        id: 'pam50-levels',
        filename: 'templates/PAM50/PAM50_levels.nii.gz',
        downloadUrl: `${HF_DATASET_ASSET_BASE_URL}/web/models/templates/PAM50/PAM50_levels.nii.gz`,
        sourceUrl: 'https://github.com/spinalcordtoolbox/PAM50',
        checksum: 'sha256:5e5b27aee46837abfdb85bffb01d5eb6c20f41ed7d308f5388fc86fd251942b6',
        sizeBytes: 129677
      },
      {
        id: 'c2c3-t2-hog-svm',
        filename: 'c2c3_disc_models/t2_model.yml',
        sourceUrl: 'https://github.com/spinalcordtoolbox/spinalcordtoolbox',
        checksum: null
      }
    ]
  },
  {
    id: 'gm_sc_7t_t2star',
    displayName: 'Gray matter 7T T2star',
    category: 'gray-matter',
    description: 'Spinal cord gray matter segmentation for 7T T2star data.',
    inputContrasts: ['T2star'],
    requiredInputs: [{ role: 'image', contrast: '7T T2star spinal cord MRI' }],
    outputType: 'binary-mask',
    labelSet: 'graymatter',
    supportStatus: TASK_STATUS.UNSUPPORTED,
    validationStatus: 'not-run',
    unsupportedReason: 'Not yet converted or validated for browser execution.',
    modelAssets: []
  },
  {
    id: 'gm_wm_exvivo_t2',
    displayName: 'Ex vivo gray/white matter T2',
    category: 'gray-matter',
    description: 'Ex vivo spinal cord gray and white matter segmentation for T2-weighted data.',
    inputContrasts: ['T2w'],
    requiredInputs: [{ role: 'image', contrast: 'ex vivo T2w spinal cord MRI' }],
    outputType: 'multi-label-mask',
    labelSet: 'multiclass',
    supportStatus: TASK_STATUS.UNSUPPORTED,
    validationStatus: 'not-run',
    unsupportedReason: 'Not yet converted or validated for browser execution.',
    modelAssets: []
  },
  {
    id: 'gm_wm_mouse_t1',
    displayName: 'Mouse gray/white matter T1',
    category: 'gray-matter',
    description: 'Mouse spinal cord gray and white matter segmentation for T1-weighted data.',
    inputContrasts: ['T1w'],
    requiredInputs: [{ role: 'image', contrast: 'mouse T1w spinal cord MRI' }],
    outputType: 'multi-label-mask',
    labelSet: 'multiclass',
    supportStatus: TASK_STATUS.UNSUPPORTED,
    validationStatus: 'not-run',
    unsupportedReason: 'Not yet converted or validated for browser execution.',
    modelAssets: []
  },
  {
    id: 'gm_mouse_t1',
    displayName: 'Mouse gray matter T1',
    category: 'gray-matter',
    description: 'Mouse spinal cord gray matter segmentation for T1-weighted data.',
    inputContrasts: ['T1w'],
    requiredInputs: [{ role: 'image', contrast: 'mouse T1w spinal cord MRI' }],
    outputType: 'binary-mask',
    labelSet: 'graymatter',
    supportStatus: TASK_STATUS.UNSUPPORTED,
    validationStatus: 'not-run',
    unsupportedReason: 'Not yet converted or validated for browser execution.',
    modelAssets: []
  },
  {
    id: 'lesion_sci_t2',
    displayName: 'SCI lesion T2',
    category: 'pathology',
    description: 'SCIsegV2 spinal cord and spinal cord injury lesion segmentation for T2-weighted data.',
    inputContrasts: ['T2w'],
    requiredInputs: [{ role: 'image', contrast: 'T2w spinal cord injury MRI' }],
    outputType: 'multi-label-mask',
    labelSet: 'lesion',
    supportStatus: TASK_STATUS.SUPPORTED,
    validationStatus: 'passed',
    validationSummary: 'Converted SCT SCIsegV2 r20240729 region-based nnUNet package to a single ONNX asset and validated browser region post-processing plus lesion-analysis metrics with regression tests.',
    outputStages: [
      {
        id: 'segmentation',
        kind: 'nifti',
        labelSet: 'spinalcord',
        sourceRegion: 'sc',
        sourceLabels: [1, 2],
        outputSuffix: '_sc_seg'
      },
      {
        id: 'lesion',
        kind: 'nifti',
        labelSet: 'lesion',
        sourceRegion: 'lesion',
        sourceLabels: [2],
        outputSuffix: '_lesion_seg'
      },
      {
        id: 'lesion_metrics',
        kind: 'metrics',
        derivedFrom: ['segmentation', 'lesion'],
        outputSuffix: '_lesion_metrics.csv'
      }
    ],
    modelAssets: [
      {
        id: 'sct-lesion-sci-t2',
        sourceUrl: 'https://github.com/ivadomed/model_seg_sci/releases/download/r20240729/model_SCIsegV2_r20240729.zip',
        sourceVersion: 'r20240729',
        sourceFormat: 'SCT SCIsegV2 nnUNet region package',
        browserFormat: 'onnx',
        filename: 'sct-lesion-sci-t2.onnx',
        downloadUrl: `${HF_DATASET_ASSET_BASE_URL}/web/models/sct-lesion-sci-t2.onnx`,
        conversionStatus: 'converted',
        checksum: 'sha256:3b28b46ac85345fd33f0ce393c6538370794fe9b5d1ffedeb5df88891bfa1cdb',
        sizeBytes: 123451938,
        modelOrientation: 'RPI',
        patchSize: [128, 192, 96],
        preprocessing: {
          modelOrientation: 'RPI',
          modelAxisOrder: 'zyx',
          targetSpacing: [0.6875, 0.5077999234199524, 0.68751]
        },
        output: {
          activation: 'sigmoid-regions',
          channelCount: 2,
          channelOrder: ['sc', 'lesion'],
          datasetLabels: {
            background: 0,
            sc: [1, 2],
            lesion: 2
          },
          classMap: [
            { stage: 'segmentation', sourceRegion: 'sc', sourceLabels: [1, 2], outputLabel: 1 },
            { stage: 'lesion', sourceRegion: 'lesion', sourceLabels: [2], outputLabel: 1 }
          ],
          regions: [
            {
              name: 'sc',
              stage: 'segmentation',
              channel: 0,
              sourceLabels: [1, 2],
              outputLabel: 1,
              threshold: 0.5,
              description: 'SCIsegV2 spinal cord segmentation'
            },
            {
              name: 'lesion',
              stage: 'lesion',
              channel: 1,
              sourceLabels: [2],
              outputLabel: 1,
              threshold: 0.5,
              description: 'SCIsegV2 lesion segmentation'
            }
          ],
          metricsStage: 'lesion_metrics'
        },
        inferenceDefaults: {
          probabilityThreshold: 0.5,
          minComponentSize: 1,
          testTimeAugmentation: false
        }
      }
    ]
  },
  {
    id: 'lesion_ms',
    displayName: 'MS lesion',
    category: 'pathology',
    description: 'Contrast-agnostic multiple sclerosis lesion segmentation.',
    inputContrasts: ['T1w', 'T2w', 'T2star', 'MP2RAGE', 'PSIR', 'STIR'],
    requiredInputs: [{ role: 'image', contrast: 'supported MS spinal cord MRI contrast' }],
    outputType: 'binary-mask',
    labelSet: 'lesion',
    supportStatus: TASK_STATUS.UNSUPPORTED,
    validationStatus: 'not-run',
    unsupportedReason: 'Not yet converted or validated for browser execution.',
    modelAssets: []
  },
  {
    id: 'lesion_ms_axial_t2',
    displayName: 'MS lesion axial T2',
    category: 'pathology',
    description: 'Multiple sclerosis lesion segmentation for axial T2-weighted data.',
    inputContrasts: ['T2w'],
    requiredInputs: [{ role: 'image', contrast: 'axial T2w spinal cord MRI' }],
    outputType: 'binary-mask',
    labelSet: 'lesion',
    supportStatus: TASK_STATUS.UNSUPPORTED,
    validationStatus: 'not-run',
    unsupportedReason: 'Not yet converted or validated for browser execution.',
    modelAssets: []
  },
  {
    id: 'lesion_ms_mp2rage',
    displayName: 'MS lesion MP2RAGE',
    category: 'pathology',
    description: 'Multiple sclerosis lesion segmentation for MP2RAGE data.',
    inputContrasts: ['MP2RAGE'],
    requiredInputs: [{ role: 'image', contrast: 'MP2RAGE spinal cord MRI' }],
    outputType: 'binary-mask',
    labelSet: 'lesion',
    supportStatus: TASK_STATUS.UNSUPPORTED,
    validationStatus: 'not-run',
    unsupportedReason: 'Not yet converted or validated for browser execution.',
    modelAssets: []
  },
  {
    id: 'tumor_edema_cavity_t1_t2',
    displayName: 'Tumor, edema, cavity',
    category: 'pathology',
    description: 'Multiclass spinal cord tumor, edema, and cavity segmentation.',
    inputContrasts: ['T1w', 'T2w'],
    requiredInputs: [
      { role: 'image', contrast: 'T1w' },
      { role: 'image', contrast: 'T2w' }
    ],
    outputType: 'multi-label-mask',
    labelSet: 'multiclass',
    supportStatus: TASK_STATUS.UNSUPPORTED,
    validationStatus: 'not-run',
    unsupportedReason: 'Requires multi-input workflow support before browser execution can be enabled.',
    modelAssets: []
  },
  {
    id: 'tumor_t2',
    displayName: 'Tumor T2',
    category: 'pathology',
    description: 'Spinal cord tumor segmentation for T2-weighted data.',
    inputContrasts: ['T2w'],
    requiredInputs: [{ role: 'image', contrast: 'T2w spinal cord tumor MRI' }],
    outputType: 'binary-mask',
    labelSet: 'lesion',
    supportStatus: TASK_STATUS.UNSUPPORTED,
    validationStatus: 'not-run',
    unsupportedReason: 'Not yet converted or validated for browser execution.',
    modelAssets: []
  },
  {
    id: 'rootlets',
    displayName: 'Rootlets',
    category: 'other-structure',
    description: 'Spinal nerve rootlet segmentation.',
    inputContrasts: ['T2w'],
    requiredInputs: [{ role: 'image', contrast: 'T2w' }],
    outputType: 'multi-label-mask',
    labelSet: 'multiclass',
    supportStatus: TASK_STATUS.UNSUPPORTED,
    validationStatus: 'not-run',
    unsupportedReason: 'Not yet converted or validated for browser execution.',
    modelAssets: []
  },
  {
    id: 'spine',
    displayName: 'TotalSpineSeg',
    category: 'other-structure',
    description: 'TotalSpineSeg spine and disc labeling from SCT stable.',
    inputContrasts: ['CT', 'MRI'],
    requiredInputs: [{ role: 'image', contrast: 'supported spine image' }],
    outputType: 'multi-label-mask',
    labelSet: 'totalspineseg',
    supportStatus: TASK_STATUS.SUPPORTED,
    validationStatus: 'manual-only',
    validationSummary: 'Converted TotalSpineSeg step-1 r20251124 ResidualEncoderUNet to ONNX and smoke-tested ONNX Runtime shape compatibility. Full SCT fixture parity is pending.',
    browserParityRequired: false,
    outputStages: [
      {
        id: 'spine_step1',
        kind: 'nifti',
        labelSet: 'totalspineseg',
        visibleByDefault: true,
        outputSuffix: '_totalspineseg_step1'
      },
      {
        id: 'spine_discs',
        kind: 'nifti',
        labelSet: 'spineDiscs',
        visibleByDefault: true,
        outputSuffix: '_totalspineseg_discs'
      }
    ],
    modelAssets: [
      {
        id: 'totalspineseg-step1',
        sourceUrl: 'https://github.com/neuropoly/totalspineseg/releases/download/r20251124/Dataset101_TotalSpineSeg_step1_r20251124.zip',
        sourceVersion: 'r20251124',
        sourceFormat: 'TotalSpineSeg nnUNet package',
        browserFormat: 'onnx',
        filename: 'totalspineseg-step1.onnx',
        downloadUrl: `${HF_DATASET_ASSET_BASE_URL}/web/models/totalspineseg-step1.onnx`,
        conversionStatus: 'converted',
        checksum: 'sha256:22f2e6e0b7a028a80ddd8b211d5c732da8c23a6dbb059fb9d379a67b3f9ce74c',
        sizeBytes: 564385004,
        patchSize: [256, 256, 48],
        preprocessing: {
          modelOrientation: 'RAS',
          modelAxisOrder: 'zyx',
          targetSpacing: [1.0, 1.0, 1.0]
        },
        inferenceDefaults: {
          probabilityThreshold: 0.5,
          minComponentSize: 1,
          testTimeAugmentation: false
        },
        output: {
          activation: 'sigmoid-labels',
          channelCount: 9,
          classLabels: [1, 2, 3, 4, 5, 6, 7, 8, 9],
          labelPriority: [1, 2, 3, 4, 5, 6, 7, 8, 9],
          paddingMode: 'center-min-patch',
          discPointRadius: 2,
          postprocess: 'totalspineseg-step1'
        }
      }
    ]
  },
  {
    id: 'sc_canal_t2',
    displayName: 'Spinal canal T2',
    category: 'other-structure',
    description: 'Spinal canal segmentation for T2-weighted data.',
    inputContrasts: ['T2w'],
    requiredInputs: [{ role: 'image', contrast: 'T2w' }],
    outputType: 'binary-mask',
    labelSet: 'spinalcord',
    supportStatus: TASK_STATUS.UNSUPPORTED,
    validationStatus: 'not-run',
    unsupportedReason: 'Not yet converted or validated for browser execution.',
    modelAssets: []
  },
  {
    id: 'seg_sc_ms_lesion_stir_psir',
    displayName: 'Retired STIR/PSIR MS lesion',
    category: 'retired',
    description: 'Retired STIR/PSIR MS lesion model.',
    inputContrasts: ['STIR', 'PSIR'],
    requiredInputs: [{ role: 'image', contrast: 'STIR or PSIR spinal cord MRI' }],
    outputType: 'unsupported',
    labelSet: 'lesion',
    supportStatus: TASK_STATUS.RETIRED,
    validationStatus: 'not-run',
    unsupportedReason: 'Retired by SCT stable; use lesion_ms instead.',
    modelAssets: []
  },
  {
    id: 'ms_sc_mp2rage',
    displayName: 'Retired MP2RAGE spinal cord',
    category: 'retired',
    description: 'Retired MP2RAGE spinal cord model.',
    inputContrasts: ['MP2RAGE'],
    requiredInputs: [{ role: 'image', contrast: 'MP2RAGE spinal cord MRI' }],
    outputType: 'unsupported',
    labelSet: 'spinalcord',
    supportStatus: TASK_STATUS.RETIRED,
    validationStatus: 'not-run',
    unsupportedReason: 'Retired by SCT stable; use spinalcord instead.',
    modelAssets: []
  },
  {
    id: 'sc_t2star',
    displayName: 'Retired T2star spinal cord',
    category: 'retired',
    description: 'Retired contrast-specific T2star spinal cord model.',
    inputContrasts: ['T2star'],
    requiredInputs: [{ role: 'image', contrast: 'T2star' }],
    outputType: 'unsupported',
    labelSet: 'spinalcord',
    supportStatus: TASK_STATUS.RETIRED,
    validationStatus: 'not-run',
    unsupportedReason: 'Retired by SCT stable; use spinalcord or sc_epi depending on data.',
    modelAssets: []
  }
];

export const DEFAULT_TASK_ID = 'spinalcord';

export function getTaskById(taskId) {
  return SCT_TASKS.find(task => task.id === taskId) || getDefaultTask();
}

export function getDefaultTask() {
  return SCT_TASKS.find(task => task.id === DEFAULT_TASK_ID) || SCT_TASKS[0];
}

export function getTaskLabels(taskOrId) {
  if (typeof taskOrId === 'string' && SCT_LABELS[taskOrId]) return SCT_LABELS[taskOrId];
  const task = typeof taskOrId === 'string' ? getTaskById(taskOrId) : taskOrId;
  return SCT_LABELS[task?.labelSet || 'spinalcord'] || SCT_LABELS.spinalcord;
}

export function getTaskForegroundLabel(taskOrId) {
  return getTaskLabels(taskOrId).find(label => label.index > 0) || getTaskLabels(taskOrId)[0];
}

export function isTaskRunnable(taskOrId) {
  const task = typeof taskOrId === 'string' ? getTaskById(taskOrId) : taskOrId;
  return task?.supportStatus === TASK_STATUS.SUPPORTED;
}

export function getPrimaryModelAsset(taskOrId) {
  const task = typeof taskOrId === 'string' ? getTaskById(taskOrId) : taskOrId;
  return task?.modelAssets?.[0] || null;
}

export function getTemplateAsset(taskOrId, assetId) {
  const task = typeof taskOrId === 'string' ? getTaskById(taskOrId) : taskOrId;
  return task?.templateAssets?.find(asset => asset.id === assetId) || null;
}

export function getModelCacheKey(taskOrId, asset = getPrimaryModelAsset(taskOrId)) {
  const task = typeof taskOrId === 'string' ? getTaskById(taskOrId) : taskOrId;
  const assetId = asset?.id || 'no-asset';
  const version = asset?.sourceVersion || 'unknown';
  return `${task?.id || DEFAULT_TASK_ID}:${assetId}:${version}:app-${VERSION}`;
}

export function taskToManifestTask(task) {
  const labels = getTaskLabels(task).map(label => ({
    index: label.index,
    name: label.name,
    rgba: label.rgba || label.color,
    meaning: label.meaning || label.name
  }));
  const modelAssets = (task.modelAssets || []).map(asset => ({
    ...asset,
    cacheKey: getModelCacheKey(task, asset)
  }));
  return {
    ...task,
    labels,
    modelAssets
  };
}

export function buildManifest() {
  return {
    schemaVersion: '1.0.0',
    sctStableSource: SCT_STABLE_SOURCE,
    generatedAt: new Date().toISOString(),
    tasks: SCT_TASKS.map(taskToManifestTask)
  };
}

export function getAssetUrl(asset) {
  if (asset?.downloadUrl) return asset.downloadUrl;
  if (!asset?.filename) return null;
  return `${MODEL_BASE_URL}/${asset.filename}`;
}

export function getTaskModelUrl(taskOrId) {
  const task = typeof taskOrId === 'string' ? getTaskById(taskOrId) : taskOrId;
  return getAssetUrl(getPrimaryModelAsset(task));
}

export function getTaskTemplateAssetUrl(taskOrId, assetId) {
  return getAssetUrl(getTemplateAsset(taskOrId, assetId));
}
