'use strict';

const DEFAULT_NIFTI_POLICY = Object.freeze({
  dataComparison: 'exact',
  metadataFields: Object.freeze([
    'dimensions',
    'spacing',
    'affine_or_orientation',
    'datatype',
    'label_semantics',
    'output_name'
  ]),
  labelSemantics: 'binary-segmentation'
});

const FIXTURE_CASES = Object.freeze([
  {
    id: 'batch_t2_deepseg_spinalcord',
    batchStep: { section: 't2', sourceLine: 72 },
    inputPath: 'test_data/batch_t2_deepseg_spinalcord/input.nii.gz',
    expectedOutputPath: 'test_data/batch_t2_deepseg_spinalcord/batch_output.nii.gz',
    producedOutputName: 'batch_output.nii.gz',
    outputType: 'nifti',
    tolerancePolicy: DEFAULT_NIFTI_POLICY
  },
  {
    id: 'batch_t2_label_vertebrae',
    batchStep: { section: 't2', sourceLine: 81 },
    inputPath: 'test_data/batch_t2_label_vertebrae/input.nii.gz',
    expectedOutputPath: 'test_data/batch_t2_label_vertebrae/batch_output.nii.gz',
    producedOutputName: 'batch_output.nii.gz',
    outputType: 'nifti',
    tolerancePolicy: DEFAULT_NIFTI_POLICY
  },
  {
    id: 'batch_t2_deepseg_lesion_sci_t2',
    batchStep: { section: 't2', sourceLine: null },
    externalReference: 'spinalcordtoolbox/sct_testing_data:t2/t2_fake_lesion',
    inputPath: 'test_data/batch_t2_deepseg_lesion_sci_t2/input.nii.gz',
    expectedOutputPath: 'test_data/batch_t2_deepseg_lesion_sci_t2/batch_output_sc.nii.gz',
    expectedOutputPaths: {
      segmentation: 'test_data/batch_t2_deepseg_lesion_sci_t2/batch_output_sc.nii.gz',
      lesion: 'test_data/batch_t2_deepseg_lesion_sci_t2/batch_output_lesion.nii.gz'
    },
    browserOutputPaths: {
      segmentation: 'test_data/batch_t2_deepseg_lesion_sci_t2/browser_output_sc.nii.gz',
      lesion: 'test_data/batch_t2_deepseg_lesion_sci_t2/browser_output_lesion.nii.gz'
    },
    producedOutputName: 'batch_output_sc.nii.gz',
    outputType: 'multi-nifti',
    tolerancePolicy: DEFAULT_NIFTI_POLICY
  },
  {
    id: 'batch_t2s_deepseg_spinalcord',
    batchStep: { section: 't2s', sourceLine: 114 },
    inputPath: 'test_data/batch_t2s_deepseg_spinalcord/input.nii.gz',
    expectedOutputPath: 'test_data/batch_t2s_deepseg_spinalcord/batch_output.nii.gz',
    producedOutputName: 'batch_output.nii.gz',
    outputType: 'nifti',
    tolerancePolicy: DEFAULT_NIFTI_POLICY
  },
  {
    id: 'batch_t2s_deepseg_graymatter',
    batchStep: { section: 't2s', sourceLine: 116 },
    inputPath: 'test_data/batch_t2s_deepseg_graymatter/input.nii.gz',
    expectedOutputPath: 'test_data/batch_t2s_deepseg_graymatter/batch_output.nii.gz',
    producedOutputName: 'batch_output.nii.gz',
    outputType: 'nifti',
    tolerancePolicy: DEFAULT_NIFTI_POLICY
  },
  {
    id: 'batch_t1_deepseg_spinalcord_t1',
    batchStep: { section: 't1', sourceLine: 141 },
    inputPath: 'test_data/batch_t1_deepseg_spinalcord_t1/input.nii.gz',
    expectedOutputPath: 'test_data/batch_t1_deepseg_spinalcord_t1/batch_output.nii.gz',
    producedOutputName: 'batch_output.nii.gz',
    outputType: 'nifti',
    tolerancePolicy: DEFAULT_NIFTI_POLICY
  },
  {
    id: 'batch_t1_deepseg_spinalcord_t2',
    batchStep: { section: 't1', sourceLine: 146 },
    inputPath: 'test_data/batch_t1_deepseg_spinalcord_t2/input.nii.gz',
    expectedOutputPath: 'test_data/batch_t1_deepseg_spinalcord_t2/batch_output.nii.gz',
    producedOutputName: 'batch_output.nii.gz',
    outputType: 'nifti',
    tolerancePolicy: DEFAULT_NIFTI_POLICY
  },
  {
    id: 'batch_mt_deepseg_spinalcord',
    batchStep: { section: 'mt', sourceLine: 172 },
    inputPath: 'test_data/batch_mt_deepseg_spinalcord/input.nii.gz',
    expectedOutputPath: 'test_data/batch_mt_deepseg_spinalcord/batch_output.nii.gz',
    producedOutputName: 'batch_output.nii.gz',
    outputType: 'nifti',
    tolerancePolicy: DEFAULT_NIFTI_POLICY
  },
  {
    id: 'batch_dmri_deepseg_spinalcord',
    batchStep: { section: 'dmri', sourceLine: 214 },
    inputPath: 'test_data/batch_dmri_deepseg_spinalcord/input.nii.gz',
    expectedOutputPath: 'test_data/batch_dmri_deepseg_spinalcord/batch_output.nii.gz',
    producedOutputName: 'batch_output.nii.gz',
    outputType: 'nifti',
    tolerancePolicy: DEFAULT_NIFTI_POLICY
  }
]);

// Parity gates: the app's output against native SCT output for each fixture.
// Read by test_fixture_parity_outputs.cjs (nightly, Node inference) and by
// e2e/automation.spec.js (browser inference on the T2 example).
const CRITICAL_BROWSER_OUTPUTS = Object.freeze([
  {
    id: 'batch_t2_deepseg_spinalcord',
    taskId: 'spinalcord',
    minDice: 0.95,
    foregroundRatioTolerance: 0.1
  },
  {
    id: 'batch_t2_label_vertebrae',
    taskId: 'vertebrae',
    minDice: 0.7,
    foregroundRatioTolerance: 0.15,
    mode: 'multilabel',
    minPositiveLabels: 10
  },
  {
    id: 'batch_t2_deepseg_lesion_sci_t2_sc',
    fixtureId: 'batch_t2_deepseg_lesion_sci_t2',
    stage: 'segmentation',
    taskId: 'lesion_sci_t2',
    minDice: 0.8,
    foregroundRatioTolerance: 0.35
  },
  {
    id: 'batch_t2_deepseg_lesion_sci_t2_lesion',
    fixtureId: 'batch_t2_deepseg_lesion_sci_t2',
    stage: 'lesion',
    taskId: 'lesion_sci_t2',
    minDice: 0.6,
    foregroundRatioTolerance: 0.75
  },
  {
    id: 'batch_dmri_deepseg_spinalcord',
    taskId: 'spinalcord',
    minDice: 0.8,
    foregroundRatioTolerance: 0.5
  },
  {
    id: 'batch_t2s_deepseg_spinalcord',
    taskId: 'spinalcord',
    minDice: 0.9,
    foregroundRatioTolerance: 0.2
  },
  {
    id: 'batch_t2s_deepseg_graymatter',
    taskId: 'graymatter',
    minDice: 0.7,
    foregroundRatioTolerance: 0.15
  },
  {
    id: 'batch_t1_deepseg_spinalcord_t1',
    taskId: 'spinalcord',
    minDice: 0.9,
    foregroundRatioTolerance: 0.2
  },
  {
    id: 'batch_t1_deepseg_spinalcord_t2',
    taskId: 'spinalcord',
    minDice: 0.95,
    foregroundRatioTolerance: 0.1
  },
  {
    id: 'batch_mt_deepseg_spinalcord',
    taskId: 'spinalcord',
    minDice: 0.85,
    foregroundRatioTolerance: 0.2
  }
]);

module.exports = {
  DEFAULT_NIFTI_POLICY,
  FIXTURE_CASES,
  CRITICAL_BROWSER_OUTPUTS
};
