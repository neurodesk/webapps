'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const BATCH_PROCESSING_SOURCE =
  'https://github.com/spinalcordtoolbox/spinalcordtoolbox/blob/master/batch_processing.sh';

const FAILING_BROWSER_STATUSES = new Set(['unsupported', 'native-only', 'missing-browser-equivalent']);
const ALLOWED_EQUIVALENT_STATUSES = new Set(['browser-capability', 'browser-task', 'missing-fixture', 'not-applicable']);
const SUPPORTED_TASK_STATUSES = new Set(['supported', 'unvalidated', 'unsupported']);
const SEGMENTATION_COMMAND_RE = /^sct_(deepseg spinalcord|deepseg_gm)\b/;

const COMMAND_FEATURES = Object.freeze([
  [/^sct_download_data\b/, { status: 'browser-capability', feature: 'sampleDataDownload' }],
  [/^sct_deepseg spinalcord -install\b/, { status: 'browser-capability', feature: 'modelInstall' }],
  [/^sct_(deepseg spinalcord|deepseg_gm)\b/, { status: 'browser-task', feature: 'segmentation' }],
  [/^sct_get_centerline\b/, { status: 'browser-capability', feature: 'centerline' }],
  [/^sct_label_utils\b/, { status: 'browser-capability', feature: 'labelUtils' }],
  [/^sct_label_vertebrae\b/, { status: 'browser-capability', feature: 'vertebralLabeling' }],
  [/^sct_(register_to_template|register_multimodal|warp_template|apply_transfo)\b/, { status: 'browser-capability', feature: 'templateRegistration' }],
  [/^sct_process_segmentation\b/, { status: 'browser-capability', feature: 'morphometry' }],
  [/^sct_detect_pmj\b/, { status: 'browser-capability', feature: 'pmjDetection' }],
  [/^sct_maths\b/, { status: 'browser-capability', feature: 'imageMath' }],
  [/^sct_(create_mask|crop_image)\b/, { status: 'browser-capability', feature: 'maskCrop' }],
  [/^sct_smooth_spinalcord\b/, { status: 'browser-capability', feature: 'smoothing' }],
  [/^sct_flatten_sagittal\b/, { status: 'browser-capability', feature: 'flattening' }],
  [/^sct_compute_mt(r|sat)\b/, { status: 'browser-capability', feature: 'mtMetrics' }],
  [/^sct_extract_metric\b/, { status: 'browser-capability', feature: 'metricExtraction' }],
  [/^sct_dmri_separate_b0_and_dwi\b/, { status: 'browser-capability', feature: 'dmriSplit' }],
  [/^sct_dmri_compute_dti\b/, { status: 'browser-capability', feature: 'dtiMetrics' }],
  [/^sct_dmri_moco\b/, { status: 'browser-capability', feature: 'dmriMoco' }],
  [/^sct_fmri_moco\b/, { status: 'browser-capability', feature: 'fmriPreprocessing' }],
  [/^sct_qc\b/, { status: 'browser-capability', feature: 'qcReport' }]
]);

const ARTIFACT_COMMAND_RE = /^sct_(deepseg|deepseg_gm|label_vertebrae)\b/;

function parseActiveBatchSteps(scriptText, options = {}) {
  const source = options.source || BATCH_PROCESSING_SOURCE;
  const lines = scriptText.split(/\r?\n/);
  let section = 'setup';
  const steps = [];

  lines.forEach((line, index) => {
    const sourceLine = index + 1;
    const sectionMatch = line.match(/^# ([a-z0-9]+)(?:\s|\(|$)/i);
    if (sectionMatch && isKnownSection(sectionMatch[1])) section = sectionMatch[1].toLowerCase();

    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.startsWith('sct_')) return;
    const command = normalizeCommand(trimmed);
    steps.push({
      source,
      sourceLine,
      section,
      command,
      taskId: inferTaskId(command),
      contrast: inferContrast(command, section),
      artifactProducing: isArtifactProducingCommand(command)
    });
  });

  validateBatchSteps(steps);
  return steps;
}

function isKnownSection(section) {
  return ['setup', 't2', 't2s', 't1', 'mt', 'dmri', 'fmri'].includes(section.toLowerCase());
}

function normalizeCommand(command) {
  return command.replace(/\s+$/u, '').replace(/\s+/gu, ' ');
}

function inferTaskId(command) {
  if (command.startsWith('sct_deepseg_gm ')) return 'graymatter';
  if (command.startsWith('sct_deepseg spinalcord ') && !command.includes(' -install')) return 'spinalcord';
  return null;
}

function inferContrast(command, section) {
  if (!SEGMENTATION_COMMAND_RE.test(command) || command.includes(' -install')) return null;
  const input = command.match(/(?:^|\s)-i\s+("?)([^"\s]+)\1/);
  const inputPath = input?.[2] || '';
  if (inputPath.includes('t2s')) return 'T2star';
  if (inputPath.includes('t1')) return 'T1w';
  if (inputPath.includes('t2')) return 'T2w';
  if (inputPath.includes('mt')) return 'MT';
  if (inputPath.includes('dmri') || inputPath.includes('dwi')) return 'DWI';
  return ({ t2: 'T2w', t2s: 'T2star', t1: 'T1w', mt: 'MT', dmri: 'DWI', fmri: 'EPI' })[section] || null;
}

function isArtifactProducingCommand(command) {
  return ARTIFACT_COMMAND_RE.test(command) && !command.includes(' -install');
}

function validateBatchSteps(steps) {
  const seenLines = new Set();
  for (const step of steps) {
    if (!step.source) throw new Error(`Batch step line ${step.sourceLine} is missing source`);
    if (!Number.isInteger(step.sourceLine) || step.sourceLine <= 0) throw new Error('Batch step sourceLine must be a positive integer');
    if (seenLines.has(step.sourceLine)) throw new Error(`Duplicate batch step source line ${step.sourceLine}`);
    seenLines.add(step.sourceLine);
    if (!step.section) throw new Error(`Batch step line ${step.sourceLine} is missing section`);
    if (!step.command?.startsWith('sct_')) throw new Error(`Batch step line ${step.sourceLine} is not an active SCT command`);
    if (step.taskId != null && typeof step.taskId !== 'string') throw new Error(`Batch step line ${step.sourceLine} has invalid taskId`);
    if (step.contrast != null && typeof step.contrast !== 'string') throw new Error(`Batch step line ${step.sourceLine} has invalid contrast`);
    if (typeof step.artifactProducing !== 'boolean') throw new Error(`Batch step line ${step.sourceLine} has invalid artifactProducing flag`);
  }
}

function assertNoStaleMappings(steps, expectedCases) {
  const activeByLine = new Map(steps.map(step => [step.sourceLine, step]));
  for (const expected of expectedCases) {
    const active = activeByLine.get(expected.sourceLine);
    if (!active) throw new Error(`Stale mapping: no active command at line ${expected.sourceLine}`);
    if (active.section !== expected.section || active.command !== expected.command) {
      throw new Error(`Stale mapping at line ${expected.sourceLine}: expected ${expected.section} "${expected.command}", found ${active.section} "${active.command}"`);
    }
  }
}

function classifyBatchStep(step) {
  for (const [pattern, equivalent] of COMMAND_FEATURES) {
    if (pattern.test(step.command)) {
      return {
        ...equivalent,
        taskId: step.taskId,
        controls: equivalent.feature === 'segmentation' ? ['stepInferenceSection', 'modelSelect', 'runSegmentation'] : [],
        workerMessages: equivalent.feature === 'segmentation' ? ['run-inference'] : [],
        moduleFunctions: []
      };
    }
  }
  return { status: 'missing-browser-equivalent', feature: 'unclassified', taskId: step.taskId };
}

function validateBrowserEquivalent(step, equivalent, manifest) {
  if (!equivalent || FAILING_BROWSER_STATUSES.has(equivalent.status)) {
    return parityResult(stepIdentity(step), 'fail', 'missing-browser-equivalent', {
      section: step.section,
      sourceLine: step.sourceLine,
      command: step.command
    });
  }
  if (!ALLOWED_EQUIVALENT_STATUSES.has(equivalent.status)) {
    return parityResult(stepIdentity(step), 'fail', 'unsupported', {
      section: step.section,
      sourceLine: step.sourceLine,
      status: equivalent.status
    });
  }
  if (equivalent.status !== 'browser-task') return parityResult(stepIdentity(step), 'pass');

  const task = manifest.tasks.find(candidate => candidate.id === step.taskId);
  if (!task) {
    return parityResult(stepIdentity(step), 'fail', 'missing-browser-equivalent', {
      section: step.section,
      sourceLine: step.sourceLine,
      taskId: step.taskId
    });
  }
  if (!SUPPORTED_TASK_STATUSES.has(task.supportStatus)) {
    return parityResult(stepIdentity(step), 'fail', 'unsupported', {
      taskId: task.id,
      supportStatus: task.supportStatus
    });
  }
  if (!task.inputContrasts?.includes(step.contrast)) {
    return parityResult(stepIdentity(step), 'fail', 'unsupported', {
      taskId: task.id,
      contrast: step.contrast
    });
  }
  if (task.supportStatus === 'unsupported') {
    return parityResult(stepIdentity(step), 'incomplete', 'unsupported', {
      taskId: task.id,
      unsupportedReason: task.unsupportedReason || 'not documented'
    });
  }
  if (task.supportStatus === 'supported') {
    const hasRunnableAsset = task.modelAssets?.some(asset => ['native', 'converted'].includes(asset.conversionStatus));
    if (task.validationStatus !== 'passed' || !hasRunnableAsset) {
      return parityResult(stepIdentity(step), 'fail', 'unsupported', {
        taskId: task.id,
        validationStatus: task.validationStatus,
        runnableAssets: hasRunnableAsset ? 1 : 0
      });
    }
  }
  return parityResult(stepIdentity(step), 'pass');
}

function parityResult(caseId, status, failureCategory = null, mismatchSummary = null, comparedArtifacts = null, maxDifference = null) {
  return { caseId, status, failureCategory, comparedArtifacts, mismatchSummary, maxDifference };
}

function stepIdentity(step) {
  return `${step.section}:${step.sourceLine}`;
}

function validateFixturePolicies(fixtureCases, steps, rootDir) {
  const stepsByLine = new Map(steps.map(step => [step.sourceLine, step]));
  const fixtureByLine = new Map();
  const results = [];

  for (const fixtureCase of fixtureCases) {
    const step = stepsByLine.get(fixtureCase.batchStep?.sourceLine);
    if (fixtureCase.batchStep?.sourceLine != null) {
      fixtureByLine.set(fixtureCase.batchStep.sourceLine, fixtureCase);
    }
    const missing = [];
    if (!step && !fixtureCase.externalReference) missing.push('batchStep');
    if (!fixtureCase.inputPath || !fs.existsSync(path.join(rootDir, fixtureCase.inputPath))) missing.push('inputPath');
    const expectedOutputPaths = fixtureCase.expectedOutputPaths
      ? Object.values(fixtureCase.expectedOutputPaths)
      : [fixtureCase.expectedOutputPath];
    if (expectedOutputPaths.some(expectedOutputPath => !expectedOutputPath || !fs.existsSync(path.join(rootDir, expectedOutputPath)))) {
      missing.push('expectedOutputPath');
    }
    if (!fixtureCase.tolerancePolicy) missing.push('tolerancePolicy');
    if (!fixtureCase.producedOutputName) missing.push('producedOutputName');
    if (missing.length) {
      results.push(parityResult(fixtureCase.id, 'fail', missing.includes('tolerancePolicy') ? 'missing-fixture-policy' : 'missing-fixture', { missing }));
    }
  }

  for (const step of steps) {
    if (step.artifactProducing && !fixtureByLine.has(step.sourceLine)) {
      results.push(parityResult(stepIdentity(step), 'incomplete', 'missing-fixture', {
        section: step.section,
        sourceLine: step.sourceLine,
        command: step.command
      }));
    }
  }

  return results;
}

function loadNifti(filePath) {
  const compressed = fs.readFileSync(filePath);
  const data = filePath.endsWith('.gz') ? zlib.gunzipSync(compressed) : compressed;
  if (data.length < 352) throw new Error(`Malformed NIfTI fixture: ${path.basename(filePath)}`);
  const littleEndian = data.readInt32LE(0) === 348;
  const bigEndian = data.readInt32BE(0) === 348;
  if (!littleEndian && !bigEndian) throw new Error(`Malformed NIfTI fixture: ${path.basename(filePath)}`);
  const readInt16 = littleEndian ? data.readInt16LE.bind(data) : data.readInt16BE.bind(data);
  const readFloat = littleEndian ? data.readFloatLE.bind(data) : data.readFloatBE.bind(data);
  const dims = Array.from({ length: 8 }, (_, i) => readInt16(40 + i * 2));
  const datatypeCode = readInt16(70);
  const bitpix = readInt16(72);
  const pixDims = Array.from({ length: 8 }, (_, i) => readFloat(76 + i * 4));
  const voxOffset = Math.max(0, Math.floor(readFloat(108)));
  const header = {
    dims,
    datatypeCode,
    bitpix,
    pixDims,
    voxOffset,
    qform_code: readInt16(252),
    sform_code: readInt16(254)
  };
  const image = data.subarray(voxOffset);
  return { header, data: typedDataForHeader(header, image) };
}

function typedDataForHeader(header, image) {
  const datatype = header.datatypeCode;
  const byteOffset = image.byteOffset;
  const buffer = image.buffer.slice(byteOffset, byteOffset + image.byteLength);
  if (datatype === 2) return new Uint8Array(buffer);
  if (datatype === 4) return new Int16Array(buffer);
  if (datatype === 8) return new Int32Array(buffer);
  if (datatype === 16) return new Float32Array(buffer);
  if (datatype === 64) return new Float64Array(buffer);
  if (datatype === 256) return new Int8Array(buffer);
  if (datatype === 512) return new Uint16Array(buffer);
  if (datatype === 768) return new Uint32Array(buffer);
  throw new Error(`Unsupported NIfTI datatype ${datatype}`);
}

function compareNiftiOutputs(expected, produced, policy, outputName, expectedOutputName) {
  const mismatches = [];
  const metadataFields = new Set(policy.metadataFields || []);
  if (metadataFields.has('output_name') && outputName !== expectedOutputName) {
    mismatches.push({ category: 'metadata-mismatch', summary: { field: 'output_name', expected: expectedOutputName, actual: outputName } });
  }
  if (metadataFields.has('dimensions') && expected.header.dims.slice(0, 4).join('x') !== produced.header.dims.slice(0, 4).join('x')) {
    mismatches.push({ category: 'metadata-mismatch', summary: { field: 'dimensions' } });
  }
  if (metadataFields.has('spacing') && expected.header.pixDims.slice(1, 4).join('x') !== produced.header.pixDims.slice(1, 4).join('x')) {
    mismatches.push({ category: 'metadata-mismatch', summary: { field: 'spacing' } });
  }
  if (metadataFields.has('datatype') && expected.header.datatypeCode !== produced.header.datatypeCode) {
    mismatches.push({ category: 'metadata-mismatch', summary: { field: 'datatype', expected: expected.header.datatypeCode, actual: produced.header.datatypeCode } });
  }
  if (metadataFields.has('affine_or_orientation')) {
    const expectedOrientation = [expected.header.qform_code, expected.header.sform_code].join(':');
    const producedOrientation = [produced.header.qform_code, produced.header.sform_code].join(':');
    if (expectedOrientation !== producedOrientation) mismatches.push({ category: 'metadata-mismatch', summary: { field: 'affine_or_orientation' } });
  }
  if (expected.data.length !== produced.data.length) {
    mismatches.push({ category: 'output-mismatch', summary: { field: 'voxel_count', expected: expected.data.length, actual: produced.data.length } });
  } else {
    const dataMismatch = compareVoxelData(expected.data, produced.data, policy);
    if (dataMismatch.mismatchCount) mismatches.push({ category: 'output-mismatch', summary: dataMismatch.summary, maxDifference: dataMismatch.maxDifference });
  }
  return mismatches;
}

function compareVoxelData(expected, produced, policy) {
  const comparison = policy.dataComparison || 'exact';
  const absoluteTolerance = Number(policy.absoluteTolerance || 0);
  const relativeTolerance = Number(policy.relativeTolerance || 0);
  let mismatchCount = 0;
  let maxDifference = 0;

  for (let i = 0; i < expected.length; i++) {
    const diff = Math.abs(Number(expected[i]) - Number(produced[i]));
    maxDifference = Math.max(maxDifference, diff);
    if (comparison === 'exact') {
      if (diff !== 0) mismatchCount++;
    } else {
      const rel = Math.abs(diff / (Number(expected[i]) || 1));
      if (diff > absoluteTolerance && rel > relativeTolerance) mismatchCount++;
    }
  }
  return { mismatchCount, maxDifference, summary: { mismatchedVoxels: mismatchCount, maxDifference } };
}

function compareFixtureCase(fixtureCase, rootDir, producedPath = null) {
  try {
    const expectedPath = path.join(rootDir, fixtureCase.expectedOutputPath);
    const actualProducedPath = producedPath || generateBrowserEquivalentOutput(fixtureCase, rootDir);
    if (path.resolve(actualProducedPath) === path.resolve(expectedPath)) {
      return parityResult(fixtureCase.id, 'fail', 'missing-browser-output', {
        message: 'Refusing to compare expected fixture output to itself',
        expected: fixtureCase.expectedOutputPath
      });
    }
    if (!fs.existsSync(actualProducedPath)) {
      return parityResult(fixtureCase.id, 'fail', 'missing-browser-output', {
        produced: path.relative(rootDir, actualProducedPath)
      });
    }
    const expected = loadNifti(expectedPath);
    const produced = loadNifti(actualProducedPath);
    const mismatches = compareNiftiOutputs(
      expected,
      produced,
      fixtureCase.tolerancePolicy,
      path.basename(actualProducedPath),
      fixtureCase.producedOutputName
    );
    if (mismatches.length) {
      const first = mismatches[0];
      return parityResult(fixtureCase.id, 'fail', first.category, first.summary, {
        input: fixtureCase.inputPath,
        expected: fixtureCase.expectedOutputPath,
        produced: path.relative(rootDir, actualProducedPath)
      }, first.maxDifference ?? null);
    }
    return parityResult(fixtureCase.id, 'pass', null, null, {
      input: fixtureCase.inputPath,
      expected: fixtureCase.expectedOutputPath,
      produced: path.relative(rootDir, actualProducedPath)
    });
  } catch (error) {
    return parityResult(fixtureCase.id, 'fail', 'malformed-fixture', { message: sanitizeDiagnostic(error.message) });
  }
}

function generateBrowserEquivalentOutput(fixtureCase, rootDir) {
  return path.join(rootDir, path.dirname(fixtureCase.inputPath), 'browser_output.nii.gz');
}

function generateSummary(results) {
  return {
    activeCommandCount: results.activeCommandCount,
    coverageCount: results.coverageResults.filter(result => result.status === 'pass').length,
    fixtureParityCount: results.fixtureResults.filter(result => result.status === 'pass').length,
    failedCount: [...results.coverageResults, ...results.fixturePolicyResults, ...results.fixtureResults].filter(result => result.status === 'fail').length,
    incompleteCount: [...results.coverageResults, ...results.fixturePolicyResults, ...results.fixtureResults].filter(result => result.status === 'incomplete').length
  };
}

function sanitizeDiagnostic(value) {
  return String(value)
    .replace(/\[[\d\s,.-]{20,}\]/gu, '[array omitted]')
    .replace(/(data|image|voxels?)=.+/giu, '$1=[omitted]');
}

function formatResults(results, summary) {
  const lines = [
    `Batch parity summary: active=${summary.activeCommandCount} coverage=${summary.coverageCount} fixtures=${summary.fixtureParityCount} failed=${summary.failedCount} incomplete=${summary.incompleteCount}`
  ];
  for (const result of results.filter(item => item.status !== 'pass')) {
    lines.push(`${result.status.toUpperCase()} ${result.failureCategory} ${result.caseId}: ${sanitizeDiagnostic(JSON.stringify(result.mismatchSummary || {}))}`);
  }
  return lines.join('\n');
}

module.exports = {
  BATCH_PROCESSING_SOURCE,
  parseActiveBatchSteps,
  validateBatchSteps,
  assertNoStaleMappings,
  classifyBatchStep,
  validateBrowserEquivalent,
  parityResult,
  validateFixturePolicies,
  loadNifti,
  compareNiftiOutputs,
  compareVoxelData,
  compareFixtureCase,
  generateBrowserEquivalentOutput,
  generateSummary,
  sanitizeDiagnostic,
  formatResults,
  inferTaskId,
  inferContrast,
  isArtifactProducingCommand
};
