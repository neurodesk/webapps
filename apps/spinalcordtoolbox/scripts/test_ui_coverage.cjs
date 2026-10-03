#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SHARED_UI = path.resolve(ROOT, '../../packages/components/src/ui');
const SHARED_STYLES = path.resolve(ROOT, '../../packages/components/src/styles');
const indexHtml = fs.readFileSync(path.join(ROOT, 'web/index.html'), 'utf8');
const stylesCss = fs.readFileSync(path.join(ROOT, 'web/css/styles.css'), 'utf8');
const effectiveStyles = [
  fs.readFileSync(path.join(SHARED_STYLES, 'base.css'), 'utf8'),
  fs.readFileSync(path.join(SHARED_STYLES, 'inference-workspace.css'), 'utf8'),
  stylesCss
].join('\n');
const appJs = fs.readFileSync(path.join(ROOT, 'web/js/spinalcordtoolbox-app.js'), 'utf8');
const controllerSources = [
  'web/js/controllers/SctInputSessions.js',
  'web/js/controllers/SctPipeline.js',
  'web/js/modules/fallback-nifti-preview.js'
].map(file => fs.readFileSync(path.join(ROOT, file), 'utf8')).join('\n');
const sharedUiSources = [
  'ConsoleOutput.js',
  'ModalManager.js',
  'ProgressManager.js',
  'WindowControls.js'
].map(file => fs.readFileSync(path.join(SHARED_UI, file), 'utf8')).join('\n');
const viewerTest = fs.readFileSync(path.join(ROOT, 'scripts/test_viewer_controller.mjs'), 'utf8');
const processingTest = fs.readFileSync(path.join(ROOT, 'scripts/test_sct_processing.cjs'), 'utf8');
const lesionAnalysisTest = fs.readFileSync(path.join(ROOT, 'scripts/test_lesion_analysis.cjs'), 'utf8');
const batchTest = fs.readFileSync(path.join(ROOT, 'scripts/test_batch_processing_cases.cjs'), 'utf8');
const workerTest = fs.readFileSync(path.join(ROOT, 'scripts/test_inference_worker_e2e.cjs'), 'utf8');

const htmlIds = new Set([...indexHtml.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
const domSource = `${appJs}\n${controllerSources}\n${sharedUiSources}`;
const domReferences = new Set([...domSource.matchAll(/getElementById\('([^']+)'\)/g)].map(match => match[1]));

const UI_COVERAGE = Object.freeze([
  { id: 'fileInput', behavior: 'loads selected files', coveredBy: ['batch', 'static-dom'] },
  { id: 'inputDropZone', behavior: 'accepts drag/drop file input', coveredBy: ['batch', 'static-dom'] },
  { id: 'fileList', behavior: 'displays and clears selected files', coveredBy: ['batch', 'static-dom'] },
  { id: 'modelSelect', behavior: 'selects supported SCT task and applies defaults', coveredBy: ['batch', 'worker', 'static-dom'] },
  { id: 'runSegmentation', behavior: 'starts worker inference', coveredBy: ['batch', 'worker', 'static-dom'] },
  { id: 'cancelButton', behavior: 'cancels active pipeline step', coveredBy: ['static-dom'] },
  { id: 'thresholdInput', behavior: 'passes probability threshold to inference', coveredBy: ['batch', 'worker', 'static-dom'] },
  { id: 'minSizeInput', behavior: 'passes connected-component cleanup threshold', coveredBy: ['batch', 'worker', 'static-dom'] },
  { id: 'ttaToggle', behavior: 'passes test-time augmentation setting', coveredBy: ['static-dom'] },
  { id: 'stageButtons', behavior: 'renders result view/download controls', coveredBy: ['batch', 'static-dom'] },
  { id: 'metricsResults', behavior: 'renders tabular metrics result stages', coveredBy: ['lesion-analysis', 'static-dom'] },
  { id: 'resultsSection', behavior: 'shows available result stages', coveredBy: ['batch', 'static-dom'] },
  { id: 'downloadCurrentVolume', behavior: 'downloads selected result/input volume', coveredBy: ['batch', 'static-dom'] },
  { id: 'screenshotViewer', behavior: 'exports viewer screenshot', coveredBy: ['batch', 'static-dom'] },
  { id: 'viewerUnavailableMessage', behavior: 'shows non-WebGL2 viewer fallback state', coveredBy: ['static-dom'] },
  { id: 'fallbackCanvas2d', behavior: 'renders NIfTI slices when NiiVue cannot initialize', coveredBy: ['static-dom'] },
  { id: 'clearResults', behavior: 'clears pipeline results', coveredBy: ['static-dom'] },
  { id: 'overlayOpacity', behavior: 'updates segmentation overlay opacity', coveredBy: ['viewer', 'batch', 'static-dom'] },
  { id: 'inputVisibilityToggle', behavior: 'toggles input volume visibility', coveredBy: ['viewer', 'static-dom'] },
  { id: 'singleViewButton', behavior: 'returns the viewer to the active single-image session', coveredBy: ['viewer', 'static-dom'] },
  { id: 'compareViewButton', behavior: 'shows loaded input sessions in side-by-side comparison canvases', coveredBy: ['viewer', 'static-dom'] },
  { id: 'interpolation', behavior: 'toggles viewer interpolation', coveredBy: ['static-dom'] },
  { id: 'colorbarToggle', behavior: 'toggles viewer colorbar', coveredBy: ['static-dom'] },
  { id: 'crosshairToggle', behavior: 'toggles viewer crosshair', coveredBy: ['static-dom'] },
  { id: 'colormapSelect', behavior: 'changes base volume colormap', coveredBy: ['static-dom'] },
  { id: 'rangeMin', behavior: 'updates lower display window', coveredBy: ['static-dom'] },
  { id: 'rangeMax', behavior: 'updates upper display window', coveredBy: ['static-dom'] },
  { id: 'windowMin', behavior: 'updates lower display window from numeric input', coveredBy: ['static-dom'] },
  { id: 'windowMax', behavior: 'updates upper display window from numeric input', coveredBy: ['static-dom'] },
  { id: 'resetWindow', behavior: 'resets display window', coveredBy: ['static-dom'] },
  { id: 'copyConsole', behavior: 'copies console output', coveredBy: ['static-dom'] },
  { id: 'clearConsole', behavior: 'clears console output', coveredBy: ['static-dom'] },
  { id: 'aboutButton', behavior: 'opens About modal', coveredBy: ['static-dom'] },
  { id: 'closeAbout', behavior: 'closes About modal', coveredBy: ['static-dom'] },
  { id: 'citationsButton', behavior: 'opens Citations modal', coveredBy: ['static-dom'] },
  { id: 'closeCitations', behavior: 'closes Citations modal', coveredBy: ['static-dom'] },
  { id: 'privacyButton', behavior: 'opens Privacy modal', coveredBy: ['static-dom'] },
  { id: 'closePrivacy', behavior: 'closes Privacy modal', coveredBy: ['static-dom'] }
]);

const TEST_SOURCES = {
  batch: batchTest,
  processing: processingTest,
  'lesion-analysis': lesionAnalysisTest,
  viewer: viewerTest,
  worker: workerTest,
  'static-dom': domSource
};

const interactiveIds = new Set(UI_COVERAGE.map(item => item.id));
for (const item of UI_COVERAGE) {
  assert.ok(htmlIds.has(item.id), `${item.id} exists in web/index.html`);
  assert.ok(
    domReferences.has(item.id) || domSource.includes(`'${item.id}'`) || domSource.includes(`"${item.id}"`),
    `${item.id} is referenced by app DOM wiring`
  );
  assert.ok(item.behavior && item.coveredBy.length > 0, `${item.id} has coverage metadata`);
  for (const coverage of item.coveredBy) {
    assert.ok(TEST_SOURCES[coverage], `${item.id} references known coverage source ${coverage}`);
  }
}

const htmlInteractiveIds = [...htmlIds].filter(id => {
  return /(Button|Toggle|Select|Input|Opacity|Window|range|file|run|abort|cancel|clear|download|screenshot|close|privacy|citations|about)/i.test(id);
});
const missingCoverage = htmlInteractiveIds.filter(id => !interactiveIds.has(id) && !/Version|Modal|Badge|Value|Text|Output|Section|Control|List|Details|Primary|Label|Selected|gl1/u.test(id));
assert.deepEqual(missingCoverage, [], `interactive ids missing UI coverage entries: ${missingCoverage.join(', ')}`);

assert.ok(appJs.includes("querySelectorAll('.view-tab[data-view]')"), 'view tab controls are wired');
assert.ok(indexHtml.includes('class="view-tab'), 'view tab controls exist');
assert.ok(appJs.includes("await this.nv.attachTo('gl1')"), 'app attempts NiiVue attachment directly');
assert.ok(appJs.includes('if (!this.nv.gl)'), 'app asserts a GL context exists after attach (guards a future niivue that logs-and-returns)');
assert.ok(appJs.includes("this.disableViewer(error?.message || 'Viewer initialization failed.')"), 'app disables viewer instead of aborting startup when NiiVue cannot initialize');
assert.ok(/VIEWER_UNAVAILABLE_GUIDANCE[\s\S]*WebGL2[\s\S]*hardware acceleration/i.test(appJs), 'viewer-unavailable message names the WebGL2 cause and the hardware-acceleration remedy');
assert.ok(indexHtml.includes('<script src="nifti-js/index.js"></script>'), 'NIfTI parser is loaded for the non-WebGL fallback preview');
assert.ok(appJs.includes('FallbackNiftiPreview'), 'app wires the non-WebGL NIfTI preview fallback');
assert.ok(appJs.includes('this.renderFallbackPreview()'), 'viewer render path falls back to a 2D NIfTI preview');
assert.match(effectiveStyles, /\.viewer-unavailable-message\[hidden\]\s*{\s*display:\s*none\s*!important;\s*}/, 'hidden viewer fallback message does not paint over a working canvas');
assert.ok(appJs.includes('setViewerControlsEnabled(false)'), 'app disables viewer-only controls when the viewer is unavailable');
assert.ok(appJs.includes('if (!this.isViewerAvailable()) return false;'), 'viewer render path is a no-op when WebGL2 is unavailable');
assert.ok(!/start-page|id="startPage"|id="enterAppButton"/.test(indexHtml), 'the workspace is the first screen; no start page');
assert.ok(!appJs.includes('bindStartPageControls'), 'no start-page handoff remains');
assert.ok(/<footer id="status" class="nd-imaging-status">[\s\S]*id="statusText" class="nd-status-text"[\s\S]*<progress id="progress"[\s\S]*id="cancelButton" class="nd-btn-cancel"[^>]*hidden/.test(indexHtml), 'status lives in the shared footer with a native progress bar and a hidden cancel');
assert.ok(!indexHtml.includes('sidebar-status'), 'the sidebar status block is retired');
assert.ok(!indexHtml.includes('id="abortInferenceBtn"'), 'the footer cancel is the only abort control');
assert.ok(!indexHtml.includes('id="processingOutput"'), 'processing output goes to the technical log');
assert.equal((indexHtml.match(/class="btn btn-primary/g) || []).length, 1, 'the sidebar has one primary action');
assert.ok(indexHtml.includes('id="taskInfoTooltip"') && appJs.includes("getElementById('taskInfoTooltip')"), 'task description lives in the SCT Task info tooltip');
assert.ok(SpinalCordToolboxGuidanceLength(appJs) <= 90, 'viewer-unavailable guidance stays within 90 characters');
assert.ok(indexHtml.includes('id="moreAppsLink"'), 'main app header More Apps link exists');
assert.ok(indexHtml.includes('href="../"'), 'More Apps links return to the composite webapps start page');
assert.ok(!indexHtml.includes('https://neurodesk.org/getting-started/hosted/webapps/'), 'More Apps links do not leave the composite site');
assert.ok(
  !indexHtml.includes('googletagmanager.com/gtag/js') && !indexHtml.includes("gtag('config'"),
  'app source leaves analytics bootstrap to the shared hosting shell'
);
assert.ok(
  indexHtml.includes('The Neurodesk hosting layer records page views only, unless your browser sends Do Not Track or Global Privacy Control') &&
    indexHtml.includes('It does not send custom events'),
  'privacy copy discloses page-view-only analytics and privacy controls'
);
assert.ok(
  indexHtml.includes('SCT: Spinal Cord Toolbox, an open-source software for processing spinal cord MRI data'),
  'Citations modal includes the primary SCT NeuroImage citation'
);

function SpinalCordToolboxGuidanceLength(source) {
  const match = source.match(/VIEWER_UNAVAILABLE_GUIDANCE =\s*'([^']*)'/);
  return match ? match[1].length : Infinity;
}

console.log(`UI coverage contract passed: ${UI_COVERAGE.length} controls mapped`);
