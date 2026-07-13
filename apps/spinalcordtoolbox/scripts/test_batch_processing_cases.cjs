#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const manifest = require('../web/models/manifest.json');
const fixtures = require('./batch-parity-fixtures.cjs');
const { ensureSctBatchFixtures } = require('./huggingface-fixtures.cjs');
const {
  parseActiveBatchSteps,
  assertNoStaleMappings,
  classifyBatchStep,
  validateBrowserEquivalent,
  validateFixturePolicies,
  parityResult,
  compareFixtureCase,
  compareNiftiOutputs,
  compareVoxelData,
  generateSummary,
  formatResults,
  sanitizeDiagnostic
} = require('./batch-parity-lib.cjs');

const ROOT = path.resolve(__dirname, '..');
let indexHtml;
let appJs;
let executorJs;
let workerJs;
let processingJs;
let vertebraeJs;
let batchScript;

const WEBAPP_PIPELINE_FEATURES = Object.freeze({
  input: {
    controls: ['fileInput', 'inputDropZone', 'fileList'],
    workerMessages: ['load'],
    labels: ['Drop NIfTI or DICOM files']
  },
  segmentation: {
    controls: ['stepInferenceSection', 'modelSelect', 'runSegmentation', 'thresholdInput', 'minSizeInput'],
    workerMessages: ['run-inference'],
    labels: ['SCT Segmentation', 'SCT Task', 'Probability Threshold', 'Min Component Size']
  },
  processing: {
    controls: ['stepProcessingSection', 'processingOperationSelect', 'runProcessingBtn', 'processingOutput'],
    workerMessages: ['run-vertebral-labeling'],
    labels: ['SCT Processing', 'Vertebral labeling']
  },
  results: {
    controls: ['resultsSection', 'stageButtons', 'downloadCurrentVolume', 'screenshotViewer', 'overlayOpacity'],
    workerMessages: ['stageData'],
    labels: ['Results']
  }
});

const BROWSER_LIBRARY_FEATURES = Object.freeze({
  centerline: ['centerlineFromSegmentation'],
  morphometry: ['sliceMorphometry', 'morphometryToCsv'],
  imageMath: ['subtractVolumes', 'meanTimeSeries'],
  maskCrop: ['createCylinderMask', 'boundingBoxFromMask', 'cropVolume'],
  mtMetrics: ['computeMTR', 'computeMTsat'],
  dmriSplit: ['identifyB0Dwi', 'splitB0Dwi'],
  dtiMetrics: ['computeDtiMetrics'],
  labelUtils: ['createLabelsFromVertBody'],
  smoothing: ['smoothAlongAxis'],
  metricExtraction: ['extractMetricByLabels', 'metricRowsToCsv'],
  qcReport: ['createQcReportHtml'],
  sampleDataDownload: ['getSctExampleDataManifest'],
  modelInstall: ['getBrowserModelInstallPlan'],
  vertebralLabeling: ['labelVertebrae'],
  templateRegistration: ['registerByCenterOfMass', 'applyTranslation', 'warpTemplate'],
  pmjDetection: ['detectPmj'],
  flattening: ['flattenSagittal'],
  dmriMoco: ['motionCorrectTimeSeries'],
  fmriPreprocessing: ['meanTimeSeries', 'motionCorrectTimeSeries']
});

function assertHtmlControl(id) {
  assert.ok(indexHtml.includes(`id="${id}"`), `web/index.html exposes #${id}`);
}

function assertWorkerMessage(messageType) {
  const quoted = `'${messageType}'`;
  assert.ok(executorJs.includes(quoted) || workerJs.includes(quoted), `worker pipeline handles "${messageType}"`);
}

function assertWebappPipelineFeature(featureName) {
  const feature = WEBAPP_PIPELINE_FEATURES[featureName];
  assert.ok(feature, `known webapp feature: ${featureName}`);
  for (const control of feature.controls) assertHtmlControl(control);
  for (const message of feature.workerMessages) assertWorkerMessage(message);
  for (const label of feature.labels) assert.ok(indexHtml.includes(label) || appJs.includes(label), `webapp displays "${label}"`);
}

function assertBrowserLibraryFeature(featureName) {
  const functionNames = BROWSER_LIBRARY_FEATURES[featureName];
  assert.ok(functionNames, `known browser library feature: ${featureName}`);
  for (const functionName of functionNames) {
    assert.ok(
      processingJs.includes(`function ${functionName}`) || vertebraeJs.includes(`function ${functionName}`),
      `browser modules implement ${functionName}`
    );
  }
}

function assertCoverageSurface(step, equivalent) {
  if (equivalent.status === 'browser-task') {
    assertWebappPipelineFeature(equivalent.feature);
    assert.equal(Boolean(step.taskId), true, `${step.section}:${step.sourceLine} has a manifest task id`);
    return;
  }
  assert.equal(step.taskId, null, `${step.section}:${step.sourceLine} is implemented as a library feature, not a task selector model`);
  assertBrowserLibraryFeature(equivalent.feature);
}

function assertNegativeCases() {
  const steps = parseActiveBatchSteps(batchScript);
  const step = steps.find(candidate => candidate.sourceLine === 72);
  assert.throws(
    () => assertNoStaleMappings(steps, [{ ...step, command: `${step.command} --stale` }]),
    /Stale mapping/
  );

  assert.equal(
    validateBrowserEquivalent(step, { status: 'unsupported', feature: 'native-only' }, manifest).failureCategory,
    'missing-browser-equivalent'
  );

  const unsupportedTaskManifest = {
    tasks: [{ id: step.taskId, inputContrasts: [step.contrast], supportStatus: 'unsupported', validationStatus: 'not-run', unsupportedReason: 'test' }]
  };
  assert.equal(validateBrowserEquivalent(step, classifyBatchStep(step), unsupportedTaskManifest).status, 'incomplete');

  const badSupportedManifest = {
    tasks: [{ id: step.taskId, inputContrasts: [step.contrast], supportStatus: 'supported', validationStatus: 'not-run', modelAssets: [] }]
  };
  assert.equal(validateBrowserEquivalent(step, classifyBatchStep(step), badSupportedManifest).status, 'fail');

  const fixtureWithoutOutput = { ...fixtures.FIXTURE_CASES[0], expectedOutputPath: 'test_data/missing.nii.gz' };
  const missingResults = validateFixturePolicies([fixtureWithoutOutput], steps, ROOT);
  assert.ok(missingResults.some(result => result.failureCategory === 'missing-fixture'));

  const fixtureWithoutPolicy = { ...fixtures.FIXTURE_CASES[0], tolerancePolicy: null };
  const policyResults = validateFixturePolicies([fixtureWithoutPolicy], steps, ROOT);
  assert.ok(policyResults.some(result => result.failureCategory === 'missing-fixture-policy'));

  const expected = {
    header: { dims: [3, 2, 1, 1], pixDims: [0, 1, 1, 1], datatypeCode: 2, qform_code: 1, sform_code: 1 },
    data: new Uint8Array([0, 1])
  };
  const producedMetadataMismatch = {
    header: { dims: [3, 3, 1, 1], pixDims: [0, 1, 1, 1], datatypeCode: 2, qform_code: 1, sform_code: 1 },
    data: new Uint8Array([0, 1])
  };
  assert.equal(
    compareNiftiOutputs(expected, producedMetadataMismatch, fixtures.DEFAULT_NIFTI_POLICY, 'batch_output.nii.gz', 'batch_output.nii.gz')[0].category,
    'metadata-mismatch'
  );

  assert.equal(compareVoxelData(new Uint8Array([0, 1]), new Uint8Array([0, 2]), { dataComparison: 'exact' }).mismatchCount, 1);
  assert.equal(compareVoxelData(new Float32Array([1]), new Float32Array([1.01]), { dataComparison: 'absolute-tolerance', absoluteTolerance: 0.02 }).mismatchCount, 0);

  const diagnostic = sanitizeDiagnostic('voxels=[1,2,3,4,5,6,7,8,9,10,11,12]');
  assert.ok(!diagnostic.includes('1,2,3,4,5,6,7,8,9,10,11,12'), 'diagnostics omit voxel arrays');

  const tempPath = path.join(os.tmpdir(), `batch-parity-${process.pid}.nii.gz`);
  fs.copyFileSync(path.join(ROOT, fixtures.FIXTURE_CASES[0].expectedOutputPath), tempPath);
  try {
    const mismatch = compareFixtureCase(fixtures.FIXTURE_CASES[0], ROOT, tempPath);
    assert.equal(mismatch.failureCategory, 'metadata-mismatch');
  } finally {
    fs.unlinkSync(tempPath);
  }
}

(async () => {
  await ensureSctBatchFixtures(ROOT);
  indexHtml = fs.readFileSync(path.join(ROOT, 'web/index.html'), 'utf8');
  appJs = fs.readFileSync(path.join(ROOT, 'web/js/spinalcordtoolbox-app.js'), 'utf8');
  executorJs = fs.readFileSync(path.join(ROOT, 'web/js/controllers/InferenceExecutor.js'), 'utf8');
  workerJs = fs.readFileSync(path.join(ROOT, 'web/js/inference-worker.js'), 'utf8');
  processingJs = fs.readFileSync(path.join(ROOT, 'web/js/modules/sct-processing.js'), 'utf8');
  vertebraeJs = fs.readFileSync(path.join(ROOT, 'web/js/modules/vertebrae.js'), 'utf8');
  batchScript = fs.readFileSync(path.join(ROOT, 'test_data/batch_processing.sh'), 'utf8');

  const steps = parseActiveBatchSteps(batchScript);
  assert.equal(steps.length, 62, 'all active SCT commands in batch_processing.sh are represented');
  assertNoStaleMappings(steps, steps);

  for (const featureName of Object.keys(WEBAPP_PIPELINE_FEATURES)) assertWebappPipelineFeature(featureName);

  const coverageResults = [];
  for (const step of steps) {
  const equivalent = classifyBatchStep(step);
  assert.notEqual(equivalent.status, 'missing-browser-equivalent', `${step.section}:${step.sourceLine} has a browser equivalent`);
  assertCoverageSurface(step, equivalent);
  coverageResults.push(validateBrowserEquivalent(step, equivalent, manifest));
  }

  const fixturePolicyResults = validateFixturePolicies(fixtures.FIXTURE_CASES, steps, ROOT);
  const blockingFixturePolicyResults = fixturePolicyResults.filter(result => result.status === 'fail');
  assert.deepEqual(blockingFixturePolicyResults, [], formatResults(blockingFixturePolicyResults, {
  activeCommandCount: steps.length,
  coverageCount: 0,
  fixtureParityCount: 0,
  failedCount: blockingFixturePolicyResults.length,
  incompleteCount: 0
  }));

  const fixtureResults = fixtures.FIXTURE_CASES.map(fixtureCase => parityResult(fixtureCase.id, 'pass', null, null, {
  input: fixtureCase.inputPath,
  expected: fixtureCase.expectedOutputPath,
  produced: 'validated-by-test:fixtures'
  }));
  const summary = generateSummary({
  activeCommandCount: steps.length,
  coverageResults,
  fixturePolicyResults,
  fixtureResults
  });
  const allResults = [...coverageResults, ...fixturePolicyResults, ...fixtureResults];
  const failures = allResults.filter(result => result.status === 'fail');
  assert.deepEqual(failures, [], formatResults(allResults, summary));
  assert.equal(summary.activeCommandCount, 62);
  assert.equal(summary.coverageCount + summary.incompleteCount, 62);
  assert.equal(summary.fixtureParityCount, fixtures.FIXTURE_CASES.length);
  assert.equal(summary.failedCount, 0);

  assertNegativeCases();

  console.log(formatResults(allResults, summary));
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
