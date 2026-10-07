#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { JSDOM } = require('jsdom');
const loadClassicScript = require('./load-classic-script.cjs');
const manifest = require('../web/models/manifest.json');
const fixtures = require('./batch-parity-fixtures.cjs');
const { ensureSctBatchFixtures } = require('./huggingface-fixtures.cjs');
const {
  parseActiveBatchSteps,
  assertNoStaleMappings,
  classifyBatchStep,
  validateBrowserEquivalent,
  validateFixturePolicies,
  compareFixtureCase,
  compareNiftiOutputs,
  compareVoxelData,
  generateSummary,
  formatResults,
  sanitizeDiagnostic
} = require('./batch-parity-lib.cjs');

const ROOT = path.resolve(__dirname, '..');
let page;
let browserModules;
let batchScript;

// The controls and visible labels a user needs for each browser pipeline
// feature. The worker requests behind them are executed and asserted in
// test_task_routing.mjs.
const WEBAPP_PIPELINE_FEATURES = Object.freeze({
  input: {
    controls: ['fileInput', 'inputDropZone', 'fileList'],
    labels: ['Drop NIfTI or DICOM files']
  },
  segmentation: {
    controls: ['stepInferenceSection', 'modelSelect', 'runSegmentation', 'thresholdInput', 'minSizeInput'],
    labels: ['SCT Segmentation', 'SCT Task', 'Probability Threshold', 'Min Component Size']
  },
  processing: {
    controls: ['stepProcessingSection', 'processingOperationSelect', 'runProcessingBtn'],
    labels: ['SCT Processing', 'Vertebral labeling']
  },
  results: {
    controls: ['resultsSection', 'stageButtons', 'downloadCurrentVolume', 'screenshotViewer', 'overlayOpacity'],
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

function assertWebappPipelineFeature(featureName) {
  const feature = WEBAPP_PIPELINE_FEATURES[featureName];
  assert.ok(feature, `known webapp feature: ${featureName}`);
  for (const control of feature.controls) {
    assert.ok(page.getElementById(control), `web/index.html has #${control}`);
  }
  const visibleText = page.body.textContent.replace(/\s+/g, ' ');
  for (const label of feature.labels) {
    assert.ok(visibleText.includes(label), `the page shows "${label}"`);
  }
}

function assertBrowserLibraryFeature(featureName) {
  const functionNames = BROWSER_LIBRARY_FEATURES[featureName];
  assert.ok(functionNames, `known browser library feature: ${featureName}`);
  for (const functionName of functionNames) {
    assert.ok(
      browserModules.some(exportsObject => typeof exportsObject[functionName] === 'function'),
      `a browser module exports ${functionName}()`
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
  page = new JSDOM(fs.readFileSync(path.join(ROOT, 'web/index.html'), 'utf8')).window.document;
  browserModules = [
    loadClassicScript(path.join(ROOT, 'web/js/modules/sct-processing.js')),
    loadClassicScript(path.join(ROOT, 'web/js/modules/vertebrae.js'))
  ];
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

  // Fixture parity (browser output against native SCT output) is measured by
  // test_fixture_parity_outputs.cjs with real inference. This test only maps
  // commands to features and validates the fixture definitions, so it reports
  // no fixture results of its own.
  const fixtureResults = [];
  const summary = generateSummary({
    activeCommandCount: steps.length,
    coverageResults,
    fixturePolicyResults,
    fixtureResults
  });
  const allResults = [...coverageResults, ...fixturePolicyResults];
  const failures = allResults.filter(result => result.status === 'fail');
  assert.deepEqual(failures, [], formatResults(allResults, summary));
  assert.equal(summary.activeCommandCount, 62);
  assert.equal(summary.coverageCount + summary.incompleteCount, 62);
  assert.equal(summary.failedCount, 0);

  // Every fixture case names real files and a task the manifest supports.
  for (const fixtureCase of fixtures.FIXTURE_CASES) {
    for (const relativePath of [fixtureCase.inputPath, ...Object.values(fixtureCase.expectedOutputPaths || { only: fixtureCase.expectedOutputPath })]) {
      const size = fs.statSync(path.join(ROOT, relativePath)).size;
      assert.ok(size > 352, `${fixtureCase.id}: ${relativePath} is a non-empty NIfTI file`);
    }
    if (fixtureCase.batchStep.sourceLine !== null) {
      const step = steps.find(candidate => candidate.sourceLine === fixtureCase.batchStep.sourceLine);
      assert.ok(step, `${fixtureCase.id}: batch_processing.sh line ${fixtureCase.batchStep.sourceLine} is an active SCT command`);
      assert.equal(step.section, fixtureCase.batchStep.section, `${fixtureCase.id}: section`);
      if (step.taskId === null) {
        // A library step (vertebral labeling) rather than a model task.
        assert.match(step.command, /^sct_label_vertebrae\b/, `${fixtureCase.id}: the only fixture without a model task is vertebral labeling`);
      } else {
        const task = manifest.tasks.find(candidate => candidate.id === step.taskId);
        assert.ok(task, `${fixtureCase.id}: task ${step.taskId} is in the manifest`);
        assert.equal(task.supportStatus, 'supported', `${fixtureCase.id}: task ${step.taskId} is supported`);
      }
    }
  }

  assertNegativeCases();

  console.log(formatResults(allResults, summary).replace(/ fixtures=0 /, ' '));
  console.log(`Fixture definitions valid: ${fixtures.FIXTURE_CASES.length}. Parity against native SCT output is measured by test:fixtures.`);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
