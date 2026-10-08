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
  'web/js/modules/fallback-nifti-preview.js',
  'web/js/modules/sct-viewer.js',
  'web/js/app/manual-edits.js'
].map(file => fs.readFileSync(path.join(ROOT, file), 'utf8')).join('\n');
const viewerJs = fs.readFileSync(path.join(ROOT, 'web/js/modules/sct-viewer.js'), 'utf8');
const sharedUiSources = [
  'ConsoleOutput.js',
  'ModalManager.js',
  'ProgressManager.js'
].map(file => fs.readFileSync(path.join(SHARED_UI, file), 'utf8')).join('\n');
const workerJs = fs.readFileSync(path.join(ROOT, 'web/js/inference-worker.js'), 'utf8');
const logChannelsJs = fs.readFileSync(path.join(ROOT, 'web/js/app/log-channels.js'), 'utf8');
const viewerTest = fs.readFileSync(path.join(ROOT, 'scripts/test_viewer_controller.mjs'), 'utf8');
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
  { id: 'screenshotViewer', behavior: 'exports viewer screenshot', coveredBy: ['viewer', 'batch', 'static-dom'] },
  { id: 'freebrowseViewer', behavior: 'hosts the FreeBrowse viewer: layout, zoom/pan, window, opacity, colormap, drawing', coveredBy: ['viewer', 'static-dom'] },
  { id: 'viewerUnavailableMessage', behavior: 'shows non-WebGL2 viewer fallback state', coveredBy: ['static-dom'] },
  { id: 'fallbackCanvas2d', behavior: 'renders NIfTI slices when the viewer cannot initialize', coveredBy: ['static-dom'] },
  { id: 'clearResults', behavior: 'clears pipeline results', coveredBy: ['static-dom'] },
  { id: 'singleViewButton', behavior: 'returns the viewer to the active single-image session', coveredBy: ['viewer', 'static-dom'] },
  { id: 'compareViewButton', behavior: 'shows every loaded image side by side, each panel with its own results; a panel click makes it active', coveredBy: ['viewer', 'static-dom'] },
  { id: 'compareLayoutSelect', behavior: 'sets the slice layout of every comparison panel', coveredBy: ['viewer', 'static-dom'] },
  { id: 'compareLinkButton', behavior: 'links or unlinks comparison panels (slice, zoom, pan and crosshair by world position)', coveredBy: ['viewer', 'static-dom'] },
  { id: 'comparisonGrid', behavior: 'holds one canvas per loaded image while comparing', coveredBy: ['viewer', 'static-dom'] },
  { id: 'aboutButton', behavior: 'opens About modal', coveredBy: ['static-dom'] },
  { id: 'closeAbout', behavior: 'closes About modal', coveredBy: ['static-dom'] },
  { id: 'citationsButton', behavior: 'opens Citations modal', coveredBy: ['static-dom'] },
  { id: 'closeCitations', behavior: 'closes Citations modal', coveredBy: ['static-dom'] },
  { id: 'privacyButton', behavior: 'opens Privacy modal', coveredBy: ['static-dom'] },
  { id: 'closePrivacy', behavior: 'closes Privacy modal', coveredBy: ['static-dom'] }
]);

const TEST_SOURCES = {
  batch: batchTest,
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
  return /(Button|Toggle|Select|Input|Opacity|Window|range|file|run|abort|cancel|clear|download|screenshot|close|privacy|citations|about|viewer)/i.test(id);
});
const missingCoverage = htmlInteractiveIds.filter(id => !interactiveIds.has(id) && !/Version|Modal|Badge|Value|Text|Output|Section|Control|List|Details|Primary|Label|Selected|viewerInfo/u.test(id));
assert.deepEqual(missingCoverage, [], `interactive ids missing UI coverage entries: ${missingCoverage.join(', ')}`);

// The viewer is FreeBrowse, mounted from the app's own origin. Controls it
// already provides must not come back as a second copy in SCT's toolbar.
assert.ok(indexHtml.includes('<div id="freebrowseViewer" class="nd-viewer-embed"></div>'), 'the FreeBrowse host element exists');
assert.ok(!/<(script|link)\b[^>]*(unpkg\.com|cdn\.jsdelivr\.net|niivue\.umd)/.test(indexHtml), 'the page loads no viewer code from a CDN');
assert.ok(!/id="gl1"/.test(indexHtml), 'the app no longer owns a bare NiiVue canvas');
assert.match(viewerJs, /new URL\('\.\.\/\.\.\/freebrowse-viewer\/index\.js', import\.meta\.url\)/, 'the viewer bundle is loaded from the app origin');
assert.ok(!/https?:\/\//.test(viewerJs), 'the viewer module references no remote URL');
for (const retired of ['data-view=', 'id="windowMin"', 'id="windowMax"', 'id="rangeMin"', 'id="rangeMax"', 'id="resetWindow"', 'id="overlayOpacity"', 'id="inputVisibilityToggle"', 'id="interpolation"', 'id="colorbarToggle"', 'id="crosshairToggle"', 'id="colormapSelect"', 'id="downloadCurrentVolume"']) {
  assert.ok(!indexHtml.includes(retired), `${retired} duplicates a FreeBrowse control and stays removed`);
}
assert.ok(appJs.includes('await SctViewer.mount({'), 'app mounts the viewer through SctViewer');
assert.ok(appJs.includes("element: document.getElementById('freebrowseViewer')"), 'app mounts FreeBrowse into its host element');
assert.ok(viewerJs.includes("if (!nv?.backend) throw new Error('WebGL2 context unavailable after attach.')"), 'viewer asserts a rendering backend exists after attach (guards a NiiVue that logs-and-returns)');
assert.ok(appJs.includes('this.viewerMount = this.viewer.handle') && appJs.includes('this.nv = this.viewer.nv'), 'app exposes the mount handle and NiiVue instance for later integrations');
assert.ok(!/hideDrawing|drawing.*display:\s*none/i.test(`${appJs}\n${viewerJs}\n${stylesCss}`), 'the FreeBrowse Drawing tab is not hidden');
assert.equal((appJs.match(/\.showVolumes\(/g) || []).length, 1, 'one call site decides which volumes the main viewer shows');
assert.ok(!/\.(loadVolumes|addVolume|removeVolume|removeAllVolumes)\(/.test(appJs), 'the app never changes the NiiVue volume list directly');
assert.ok(appJs.includes("this.disableViewer(error?.message || 'Viewer initialization failed.')"), 'app disables viewer instead of aborting startup when the viewer cannot initialize');
assert.ok(/VIEWER_UNAVAILABLE_GUIDANCE[\s\S]*WebGL2[\s\S]*hardware acceleration/i.test(appJs), 'viewer-unavailable message names the WebGL2 cause and the hardware-acceleration remedy');
assert.ok(indexHtml.includes('<script src="nifti-js/index.js"></script>'), 'NIfTI parser is loaded for the non-WebGL fallback preview');
assert.ok(appJs.includes('FallbackNiftiPreview'), 'app wires the non-WebGL NIfTI preview fallback');
assert.ok(appJs.includes('this.renderFallbackPreview()'), 'viewer render path falls back to a 2D NIfTI preview');
assert.match(effectiveStyles, /\.viewer-unavailable-message\[hidden\]\s*{\s*display:\s*none\s*!important;\s*}/, 'hidden viewer fallback message does not paint over a working canvas');
assert.ok(appJs.includes('setViewerControlsEnabled(false)'), 'app disables viewer-only controls when the viewer is unavailable');
assert.ok(appJs.includes('if (!this.isViewerAvailable()) return this.renderFallbackPreview();'), 'viewer render path never touches NiiVue when WebGL2 is unavailable');
assert.ok(SpinalCordToolboxHintLength(appJs) <= 90, 'the zoom/pan hint stays within 90 characters');
assert.ok(/VIEWER_HINT =\s*'[^']*zoom[^']*pan[^']*reset/i.test(appJs), 'the viewer hint tells the user how to zoom, pan and reset');
assert.ok(!/start-page|id="startPage"|id="enterAppButton"/.test(indexHtml), 'the workspace is the first screen; no start page');
assert.ok(!appJs.includes('bindStartPageControls'), 'no start-page handoff remains');
assert.ok(/<footer id="status" class="nd-imaging-status">[\s\S]*id="statusText" class="nd-status-text"[\s\S]*<progress id="progress"[\s\S]*id="cancelButton" class="nd-btn-cancel"[^>]*hidden/.test(indexHtml), 'status lives in the shared footer with a native progress bar and a hidden cancel');
assert.ok(!indexHtml.includes('sidebar-status'), 'the sidebar status block is retired');
assert.ok(!indexHtml.includes('id="abortInferenceBtn"'), 'the footer cancel is the only abort control');
assert.equal((indexHtml.match(/class="btn btn-primary/g) || []).length, 1, 'the sidebar has one primary action');
// Manual edits: the shared nd-mask-editor (Edit in a result row, its toolbar
// row under the viewer toolbar) on FreeBrowse's NiiVue. No SCT section, no
// second drawing toolbar in the page.
const manualEditsJs = fs.readFileSync(path.join(ROOT, 'web/js/app/manual-edits.js'), 'utf8');
assert.ok(!indexHtml.includes('id="editSection"'), 'manual edits have no sidebar section: Edit sits on each result row');
assert.ok(!/id="[^"]*(pen|eraser|undo|brush)[^"]*"/i.test(indexHtml), 'no app-drawn drawing toolbar: the shared editor builds its own row');
assert.ok(manualEditsJs.includes('createMaskEditor(') && appJs.includes("editBtn.className = 'nd-edit-btn'"), 'the shared editor opens from the Edit button of a result row');
assert.ok(/\bapp\.setStageData\(/.test(manualEditsJs), 'applied edits change stage data only through setStageData');
assert.ok(manualEditsJs.includes('setDrawingLocked'), "FreeBrowse's own drawing controls are locked while the shared editor is open");
assert.equal((appJs.match(/'stagedatachanged'/g) || []).length, 3, 'stage data changes are one event: dispatch, subscribe, unsubscribe');
assert.ok(appJs.includes("this.notifyStageDataChanged(data.stage, 'model')"), 'model output announces its stage data too');
assert.ok(appJs.includes('!this.manualEdits?.isHiding(overlayStage)'), 'the stage on the drawing layer is hidden as an overlay');
assert.ok(!/\.(loadVolumes|addVolume|removeVolume)\(/.test(manualEditsJs), 'the edit controller never changes the NiiVue volume list');
assert.ok(appJs.includes("data-metrics-stage") && appJs.includes('renderAllMetricsResults'), 'every metrics stage renders in its own block of the Results section');
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
  indexHtml.includes('downloads the pinned Pyodide Python runtime and scientific libraries from jsDelivr (cdn.jsdelivr.net)'),
  'privacy copy discloses the CDN requests made by browser SCT analysis'
);
assert.ok(
  indexHtml.includes('SCT: Spinal Cord Toolbox, an open-source software for processing spinal cord MRI data'),
  'Citations modal includes the primary SCT NeuroImage citation'
);

// Console: one shared nd-console, collapsed at load, resizable, with an analysis and a technical log.
const consoleTag = indexHtml.match(/<nd-console\b[^>]*>/)?.[0] || '';
assert.equal((indexHtml.match(/<nd-console\b/g) || []).length, 1, 'one console region');
assert.match(consoleTag, /id="spinalcordtoolbox-log"/, 'console keeps its id');
assert.match(consoleTag, /\scollapsed[\s>]/, 'console starts collapsed');
assert.match(consoleTag, /\sresizable[\s>]/, 'console can be enlarged by the user');
assert.match(consoleTag, /channels="analysis:Analysis,technical:Technical"/, 'console holds an analysis and a technical log');
assert.ok(!/class="[^"]*\bconsole-(container|header|output)\b/.test(indexHtml), 'no hand-written console markup; nd-console builds it');
assert.ok(!/id="(consoleOutput|copyConsole|clearConsole)"/.test(indexHtml), 'Copy, Clear and the outputs come from nd-console');
assert.ok(!/console/.test(stylesCss), 'the app stylesheet does not style the console');
assert.ok(appJs.includes('defineConsole()') && appJs.includes("getElementById('spinalcordtoolbox-log')"), 'app registers and uses the shared console element');
assert.ok(!appJs.includes('new ConsoleOutput('), 'app does not build its own console output');
assert.match(appJs, /new SctInputSessions\(\{\s*updateOutput: \(msg\) => this\.logAnalysis\(msg\)/, 'input messages go to the analysis log');
assert.match(appJs, /updateOutput: \(msg\) => \{\s*const \{ channel, level \} = routePipelineMessage\(msg\)/, 'pipeline messages are routed per line');
assert.match(appJs, /workerLog: \(msg, details\) => \{\s*const \{ channel, level \} = routeWorkerLog\(msg, details\)/, 'worker messages are routed by their channel');
assert.match(appJs, /describeRun\(\{[\s\S]*?\}\)\) this\.logAnalysis\(line\);\s*this\.beginAbortableStep\('inference'\)/, 'each run records task, input and parameters in the analysis log');
assert.match(appJs, /writeLog\(channel, msg, level = 'info'\) \{\s*console\.log\(msg\);\s*this\.log\?\.log\(msg, level, channel\);\s*\}/, 'every line is written once, to one channel');
assert.match(appJs, /updateOutput\(msg, level\) \{\s*this\.writeLog\(TECHNICAL, msg, level\)/, 'updateOutput is the technical log');
assert.match(logChannelsJs, /export const ANALYSIS = 'analysis';[\s\S]*export const TECHNICAL = 'technical';/, 'channel ids match the markup');
for (const line of [
  'postAnalysis(`Input volume: ',
  'postAnalysis(`Lesion metrics: ',
  'postAnalysis(`TotalSpineSeg warning: ',
  'postAnalysis(`WARNING: Segmentation is empty.',
  'postAnalysis(`WARNING: ${stage} mask is empty.',
  "postMaskSummary('segmentation', outputLabels)",
  'postMaskSummary(stageOutput.stage, outputLabels)',
]) assert.ok(workerJs.includes(line), `worker writes the analysis log: ${line}`);
for (const line of [
  'postLog(`Loaded: ${displayName}',
  "postLog('Creating ONNX InferenceSession",
  'postLog(`Inference complete in ',
  'postLog(`Using WASM backend',
  'onLog: (msg) => postLog(msg)',
]) assert.ok(workerJs.includes(line), `worker keeps the technical log: ${line}`);
assert.equal((indexHtml.match(/role="status"/g) || []).length, 1, 'status stays in footer#status only');

function SpinalCordToolboxHintLength(source) {
  const match = source.match(/VIEWER_HINT =\s*'([^']*)'/);
  return match ? match[1].length : Infinity;
}

function SpinalCordToolboxGuidanceLength(source) {
  const match = source.match(/VIEWER_UNAVAILABLE_GUIDANCE =\s*'([^']*)'/);
  return match ? match[1].length : Infinity;
}

console.log(`UI coverage contract passed: ${UI_COVERAGE.length} controls mapped`);
