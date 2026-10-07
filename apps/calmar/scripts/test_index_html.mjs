#!/usr/bin/env node --no-warnings
// web/index.html, checked as a document rather than as text.
//
// Part 1 parses the page with jsdom and queries elements, attributes, ARIA
// groups and document order.
// Part 2 boots the real LesionNetworkMappingApp against that same document
// (only NiiVue, fetch and Worker are stand-ins) and drives the controls, so a
// renamed or missing id shows up as a control that no longer does anything.
// Part 3 holds the few policy lints that are properties of the source file.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'web/index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8080/', pretendToBeVisual: true });
const { document } = dom.window;

const $ = selector => document.querySelector(selector);
const $$ = selector => Array.from(document.querySelectorAll(selector));
const text = element => element.textContent.replace(/\s+/g, ' ').trim();
// Own text of a control, without the text of nested help popovers.
const label = element => Array.from(element.childNodes)
  .filter(node => node.nodeType === 3)
  .map(node => node.textContent)
  .join(' ')
  .replace(/\s+/g, ' ')
  .trim();
const ids = elements => elements.map(element => element.id);
const precedes = (first, second) => Boolean(first.compareDocumentPosition(second) & 4);

// =========================================================================
// Part 1: document structure
// =========================================================================

// ---- identity ----
assert.equal(document.title, 'CALMaR | Co-designed Automated Lesion Mapping and Reporting');
assert.equal(text($('header.app-header h1')), 'CALMaR');
assert.equal(text($('header.app-header .tagline')), 'Co-designed Automated Lesion Mapping and Reporting');

// ---- the workspace is the first screen ----
assert.equal($('#startPage, #enterAppButton, .start-page'), null, 'no start page, hero or welcome overlay');
const appContainer = $('.app-container');
assert.deepEqual(
  Array.from(appContainer.children).map(child => child.tagName.toLowerCase()),
  ['header', 'aside', 'main', 'footer'],
  'the app is one header, sidebar, viewer and status footer'
);

// ---- shared status footer ----
{
  const footer = $('footer#status');
  assert.ok(footer.classList.contains('nd-imaging-status'));
  const statusText = footer.querySelector('#statusText');
  assert.equal(statusText.getAttribute('role'), 'status', 'status text is announced');
  assert.equal(statusText.getAttribute('aria-live'), 'polite');
  assert.equal(footer.querySelector('#progress').tagName, 'PROGRESS', 'progress is a native <progress>');
  assert.ok(footer.querySelector('#elapsed'));
  const cancel = footer.querySelector('#cancelButton');
  assert.equal(cancel.hidden, true, 'the cancel is hidden until a run can be cancelled');
  assert.equal(cancel.getAttribute('aria-label'), 'Cancel processing');
  assert.equal($('.app-sidebar #statusText, .app-sidebar progress, .sidebar-status'), null, 'no status or progress in the sidebar');
  assert.equal($$('footer').length, 1, 'no second, static footer');
}

// ---- header actions ----
{
  const links = $$('.header-links .header-link');
  assert.deepEqual(links.map(text), ['About', 'Cite', 'Privacy', 'More Apps', 'GitHub']);
  const moreApps = links[3];
  assert.equal(moreApps.tagName, 'A');
  assert.equal(moreApps.getAttribute('href'), '../', 'More Apps returns to the composite site root');
  assert.equal(moreApps.getAttribute('title'), 'More Neurodesk web apps');
  assert.equal(moreApps.hasAttribute('target'), false, 'More Apps stays in the current tab');
  assert.equal(moreApps.querySelectorAll('svg rect').length, 4, 'More Apps uses the 2x2 grid icon');
  assert.equal(links[4].getAttribute('href'), 'https://github.com/neurodesk/webapps/tree/main/apps/calmar');
  assert.equal(links[4].getAttribute('rel'), 'noopener noreferrer');
  assert.deepEqual(
    links.slice(0, 3).map(link => link.dataset.neurodeskControl),
    ['about', 'cite', 'privacy'],
    'About, Cite and Privacy are registered through the shell control contract'
  );
}

// ---- sidebar: three sections, one primary action ----
{
  assert.deepEqual(ids($$('.app-sidebar section.sidebar-section')), ['stepLoadSection', 'stepLesionSection', 'resultsSection']);
  assert.deepEqual(
    $$('.app-sidebar .section-toggle').map(label),
    ['1. Input', '2. Run analysis', '3. Results']
  );
  const primary = $$('.app-sidebar .btn-primary');
  assert.deepEqual(ids(primary), ['runFullPipelineButton'], 'the sidebar has exactly one primary action');
  assert.equal(text(primary[0]), 'Run analysis');
  assert.equal($$('.btn-primary').length, 1, 'and no other primary button anywhere');
  assert.equal($('#pipelineSelect, label[for="pipelineSelect"]'), null, 'no visible pipeline selector');
}

// ---- inputs ----
{
  const inputLabels = Object.fromEntries(
    $$('#stepLoadSection label[for]').map(element => [element.getAttribute('for'), text(element)])
  );
  assert.deepEqual(inputLabels, {
    structuralFileInput: 'Structural T1 (NIfTI / DICOM)',
    deepIslesDwiFileInput: 'DWI/TRACE (NIfTI / DICOM)',
    deepIslesAdcFileInput: 'ADC (NIfTI / DICOM)'
  });
  for (const id of Object.keys(inputLabels)) {
    const input = document.getElementById(id);
    assert.equal(input.type, 'file');
    assert.equal(input.dataset.neurodeskInput, 'image', `${id} is a shared scan input`);
    assert.equal(input.multiple, true, `${id} accepts a DICOM series`);
  }
  const structuralHelp = $('#stepLoadSection .help-icon[aria-label="Structural T1 help"] .help-popover');
  assert.match(text(structuralHelp), /Loading the image only displays it; processing starts when you click Run analysis\./);
  // The hidden compatibility hooks behind the compact buttons.
  for (const id of ['lesionFileInput', 'manualMaskFileInput']) {
    const input = document.getElementById(id);
    assert.ok(input.classList.contains('hidden'), `${id} is hidden`);
    assert.equal(input.getAttribute('aria-hidden'), 'true');
    assert.equal(input.tabIndex, -1, `${id} is out of the tab order`);
    assert.equal(input.multiple, true);
  }
}

// ---- atlas selector ----
{
  assert.equal(text($('label[for="atlasSelect"]')), 'Atlas');
  const options = Array.from($('#atlasSelect').options);
  assert.deepEqual(
    options.map(option => [option.value, option.textContent, option.selected]),
    [['schaefer400', 'Schaefer 400 parcels', true], ['yeo7', 'Yeo 7 networks', false]]
  );
}

// ---- advanced workflow, in execution order ----
{
  const advanced = $('#advancedStageControls');
  assert.equal(advanced.tagName, 'DETAILS', 'advanced controls are a collapsible section');
  assert.equal(advanced.open, false, 'collapsed by default');
  const workflow = advanced.querySelector('[aria-label="Advanced workflow order"]');
  const steps = $$('#advancedStageControls [aria-label="Advanced workflow order"] > *')
    .filter(element => !element.classList.contains('hidden'))
    .map(element => element.id || element.getAttribute('aria-label') || element.querySelector('select, input').id);
  assert.deepEqual(steps, [
    'runBrainExtractionButton',
    'prealignToMniButton',
    'Lesion mask source choice',
    'runRegistrationButton',
    'registrationQcMode',
    'checkAtlasAlignmentButton',
    'registrationBlendValue',
    'applyRegistrationToLesionButton',
    'computeOverlapButton',
    'computeNetworkMapButton'
  ]);
  assert.deepEqual(
    Array.from(workflow.querySelectorAll(':scope > button')).map(text),
    [
      '1 Brain extraction',
      '2 Pre-align T1',
      '4 MNI registration (SynthMorph)',
      '5 Check atlas alignment',
      '6 Warp lesion → atlas grid',
      '7 Compute atlas overlap',
      '8 Compute network map'
    ]
  );
  const choice = workflow.querySelector('[aria-label="Lesion mask source choice"]');
  assert.equal(text(choice.querySelector('.param-label')), '3 Lesion mask');
  assert.deepEqual(
    Array.from(choice.querySelectorAll('button')).map(button => [button.id, text(button)]),
    [
      ['runLesionSegmentationButton', 'Auto seed mask'],
      ['runDeepIslesSegmentationButton', 'DeepISLES DWI/ADC seed'],
      ['startManualMaskButton', 'Manual mask'],
      ['uploadManualMaskButton', 'Upload mask']
    ]
  );
  // Compact label; the grid detail lives in the title.
  const prealign = $('#prealignToMniButton');
  assert.equal(prealign.children.length, 0, 'no superscript or unit markup inside the label');
  assert.equal(prealign.title, 'Pre-align T1 to the MNI160 1 mm grid');
  assert.equal($$('.advanced-workflow .btn-primary').length, 0, 'per-stage buttons are secondary');
  assert.equal(advanced.textContent.includes('Researcher mode'), false, 'no researcher-mode upload');
}

// ---- registration QC controls ----
{
  assert.equal(text($('label[for="registrationQcMode"]')), 'Registration QC view');
  assert.deepEqual(
    Array.from($('#registrationQcMode').options).map(option => [option.value, option.textContent, option.selected]),
    [
      ['mni', 'MNI space', true],
      ['patient', 'Patient space', false],
      ['checkerboard', 'Checkerboard', false],
      ['displacement', 'Displacement', false]
    ]
  );
  assert.equal(text($('label[for="registrationBlendValue"]')), 'Patient/MNI blend');
  const blend = $('#registrationBlendValue');
  assert.deepEqual([blend.type, blend.min, blend.max, blend.step, blend.value], ['range', '0', '1', '0.05', '0.5']);
  assert.equal($('#checkAtlasAlignmentButton').disabled, true, 'alignment QC needs a registration first');
}

// ---- results ----
{
  const results = $('#resultsSection');
  assert.ok(results.classList.contains('collapsed'), 'results start collapsed');
  assert.deepEqual(
    Array.from(results.querySelectorAll('h3')).map(text),
    [
      'Direct lesion overlap',
      'Functional associations from direct lesion overlap',
      'Threshold connectivity map',
      'Connectivity-map effects',
      'Functional associations from connectivity-map effects'
    ]
  );
  const minCluster = $('#networkThresholdMinCluster');
  assert.equal(text($('label[for="networkThresholdMinCluster"]')), 'Min cluster size (voxels)');
  assert.deepEqual([minCluster.type, minCluster.value, minCluster.min], ['number', '30', '0']);
  assert.ok(precedes(minCluster, results.querySelector('h3')), 'min cluster size leads the results it filters');

  const columns = id => Array.from(document.getElementById(id).querySelectorAll('thead th')).map(text);
  assert.deepEqual(columns('networkOverlapTable'), ['Atlas label', 'Voxels', 'Lesion %']);
  assert.deepEqual(columns('affectedNetworkTable'), ['Atlas label', 'Voxels', 'Map %']);
  assert.deepEqual(columns('directFunctionProfileTable'), ['Term', 'Score', 'Atlas label drivers']);
  assert.deepEqual(columns('mapFunctionProfileTable'), ['Term', 'Score', 'Atlas label drivers']);
  for (const id of ['outsideAtlasWarning', 'directFunctionProfileResults', 'affectedNetworkResults', 'mapFunctionProfileResults']) {
    assert.ok(document.getElementById(id).classList.contains('hidden'), `${id} is hidden until there is a result`);
  }

  // Top-percent thresholding only.
  assert.equal(text($('label[for="networkThresholdValue"]')), 'Top voxels');
  assert.equal($('#networkThresholdValue').type, 'range');
  assert.equal($('#networkThresholdMode'), null, 'no absolute-vs-percent mode selector');
  assert.equal(/absolute/i.test(text($('#thresholdControls'))), false, 'no absolute t-stat threshold copy');
  const symmetric = $('#networkThresholdSymmetric');
  assert.equal(symmetric.type, 'checkbox');
  assert.equal(text(symmetric.closest('label')), 'Use |t| magnitude');

  const helpFor = name => text($(`#resultsSection .help-icon[aria-label="${name}"] .help-popover`));
  assert.match(helpFor('Direct lesion overlap help'), /^Atlas labels listed here contain lesion voxels directly\./);
  assert.match(helpFor('Threshold connectivity map help'), /group-FC weighted t-map derived from the direct lesion-overlap profile/);
  assert.match(helpFor('Connectivity-map effects help'), /surviving the thresholded connectivity map/);
  for (const name of ['Direct functional associations help', 'Connectivity-map functional associations help']) {
    assert.equal(
      helpFor(name),
      'Exploratory literature terms are available for selected atlas labels; they are not clinical predictions.'
    );
  }

  assert.deepEqual(
    $$('#resultsSection .results-actions button').map(button => [button.id, text(button), button.disabled]),
    [
      ['downloadOverlapCsv', 'Download overlap CSV', true],
      ['downloadNetworkMapButton', 'Download network map', true],
      ['downloadThresholdedNetworkMapButton', 'Download thresholded mask', true],
      ['showSubjectAtlasButton', 'Show subject atlas', true],
      ['downloadSubjectAtlasButton', 'Download subject atlas', true],
      ['clearResultsButton', 'Start over', false]
    ]
  );
  assert.deepEqual(
    ids($$('#resultsSection details button')),
    ['downloadBrainMaskButton', 'downloadLesionMaskButton'],
    'intermediate downloads sit in their own disclosure'
  );
}

// ---- help lives behind compact popovers ----
{
  const helpIcons = $$('.help-icon');
  assert.ok(helpIcons.length >= 8);
  for (const icon of helpIcons) {
    assert.ok(icon.getAttribute('aria-label'), 'every help icon is labelled');
    const popover = icon.querySelector('.help-popover');
    assert.equal(popover?.getAttribute('role'), 'tooltip', `${icon.getAttribute('aria-label')} opens a tooltip`);
  }
  assert.equal($('p.param-help'), null, 'no always-visible helper paragraphs');
  const sidebarCopy = text($('.app-sidebar'));
  assert.equal(/auto-promoted on file drop|auto-fires/i.test(sidebarCopy), false, 'copy never implies processing starts on load');
}

// ---- viewer ----
{
  assert.equal($('#gl1').tagName, 'CANVAS');
  assert.deepEqual(
    $$('.view-tabs .view-tab').map(tab => [tab.dataset.view, text(tab)]),
    [['multiplanar', '3-Plane'], ['axial', 'Axial'], ['coronal', 'Coronal'], ['sagittal', 'Sagittal'], ['render', '3D']]
  );
  assert.deepEqual(
    $$('[aria-label="Viewer layers"] label').map(element => [element.querySelector('input').id, text(element)]),
    [
      ['layerToggleT1', 'T1'],
      ['layerToggleBrainMask', 'Brain mask'],
      ['layerToggleLesionMask', 'Lesion mask'],
      ['layerToggleThresholdMap', 'Threshold map'],
      ['layerToggleAtlasQc', 'Atlas']
    ]
  );
}

// ---- mask review toolbar, grouped by workflow ----
{
  const toolbar = $('#maskDrawingToolbar');
  assert.equal(toolbar.getAttribute('aria-label'), 'Lesion mask drawing tools');
  assert.ok(toolbar.classList.contains('hidden'), 'hidden until a mask is under review');
  const groups = Array.from(toolbar.querySelectorAll(':scope > [role="group"]'));
  const controls = group => Array.from(group.querySelectorAll('button, input, select')).map(element => element.id);
  assert.deepEqual(
    groups.map(group => [group.getAttribute('aria-label'), controls(group)]),
    [
      ['Draw lesion mask', ['maskPaintButton', 'maskEraseButton', 'maskEraseClusterButton', 'maskBrushSize', 'maskShapeSelect', 'maskFilledToggle']],
      ['Mask edit actions', ['maskUndoButton', 'maskBlankButton', 'maskSmoothButton']],
      ['Mask slice interpolation', ['maskInterpolateAxis', 'maskInterpolateButton', 'maskInterpolateHelp']],
      ['Mask review actions', ['confirmLesionMaskButton', 'uploadReviewMaskButton', 'downloadEditedLesionMaskButton']]
    ]
  );
  assert.deepEqual(
    Array.from(toolbar.querySelectorAll('button:not(.help-icon)')).map(button => [label(button), button.title]),
    [
      ['Paint', 'Paint lesion voxels'],
      ['Erase', 'Erase lesion voxels'],
      ['Erase cluster', 'Erase the connected lesion cluster under the cursor'],
      ['Undo', 'Undo mask edit'],
      ['Blank', 'Start a blank mask'],
      ['Smooth', 'Smooth the 3D mask volume'],
      ['Interp', 'Interpolate mask between boundary slices'],
      ['Confirm mask', 'Confirm edited lesion mask and continue analysis'],
      ['Upload', 'Upload a native-space lesion mask into this review'],
      ['Download', 'Download the edited native-space mask']
    ]
  );
  const fileActions = toolbar.querySelector('[aria-label="Mask file actions"]');
  assert.deepEqual(ids(Array.from(fileActions.querySelectorAll('button'))), ['uploadReviewMaskButton', 'downloadEditedLesionMaskButton']);
  assert.deepEqual(
    Array.from($('#maskInterpolateAxis').options).map(option => [option.value, option.textContent]),
    [['0', 'Axial'], ['1', 'Coronal'], ['2', 'Sagittal']]
  );
  const interpolateHelp = $('#maskInterpolateHelp');
  assert.equal(interpolateHelp.getAttribute('aria-label'), 'Interpolate mask help');
  assert.match(text(interpolateHelp.querySelector('.help-popover')), /first and last non-empty slices.*NiiVue mask interpolation/);

  // The approval banner is a prompt only: it carries no buttons of its own.
  const banner = $('#maskApprovalBanner');
  assert.equal(banner.getAttribute('role'), 'status');
  assert.ok(banner.classList.contains('hidden'));
  assert.equal(text(banner), 'Mask approval required Review the lesion mask before analysis continues.');
  assert.equal(banner.querySelector('button'), null, 'confirm and download stay in the toolbar');
}

// ---- logs: two collapsed consoles below the viewer ----
{
  const consoles = $$('.app-main .console-stack > [data-disclosure]');
  assert.deepEqual(ids(consoles), ['analysisLog', 'technicalLogDetails']);
  assert.ok(precedes($('.viewer-canvas-wrapper'), consoles[0]), 'consoles sit below the viewer');
  const expected = [
    ['Analysis log', 'consoleOutput', ['copyConsole', 'clearConsole']],
    ['Technical log', 'technicalConsoleOutput', ['copyTechnicalConsole', 'clearTechnicalConsole']]
  ];
  consoles.forEach((element, i) => {
    const [title, outputId, actionIds] = expected[i];
    assert.ok(element.classList.contains('console-container'));
    assert.ok(element.classList.contains('collapsed'), `${title} is collapsed by default`);
    const toggle = element.querySelector('.console-header [data-disclosure-toggle]');
    assert.equal(text(toggle), title);
    assert.equal(element.querySelector('[data-disclosure-panel]').id, outputId);
    const actions = Array.from(element.querySelectorAll('.console-header .console-actions button'));
    assert.deepEqual(ids(actions), actionIds, 'Copy and Clear live in the console header');
    assert.deepEqual(actions.map(text), ['Copy', 'Clear']);
  });
  assert.equal($('.app-sidebar .console-output'), null, 'no second log in the sidebar');
}

// ---- About and Privacy copy ----
{
  assert.match(
    text($('#aboutModal')),
    /Background execution is possible if this site is added under "Always keep these sites active" in your browser settings\./
  );
  assert.match(
    text($('#privacyModal')),
    /The Neurodesk hosting layer records page views only, unless your browser sends Do Not Track or Global Privacy Control\..*It does not send custom events/
  );
  for (const id of ['aboutModal', 'privacyModal', 'citationsModal']) {
    assert.ok(document.getElementById(id).classList.contains('modal-overlay'));
  }
}

// ---- scripts the page loads ----
{
  const scripts = $$('script[src]').map(script => [script.getAttribute('src'), script.type]);
  assert.deepEqual(scripts.at(-1), ['js/lnm-app.js', 'module'], 'the orchestrator is the last script and an ES module');
  assert.ok(scripts.some(([src]) => src === 'coi-serviceworker.js'), 'the isolation service worker stays loaded');
  assert.ok(scripts.some(([src]) => src === 'nifti-js/index.js'));
  const importMap = JSON.parse($('script[type="importmap"]').textContent);
  assert.equal(importMap.imports['@neurodesk/webapp-components'], './vendor/webapp-components/src/index.js');
}

// =========================================================================
// Part 2: the real app bound to this document
// =========================================================================

for (const name of [
  'window', 'document', 'HTMLElement', 'customElements', 'Event', 'CustomEvent', 'Node',
  'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'
]) {
  globalThis[name] = dom.window[name];
}

const viewerCalls = [];
globalThis.niivue = {
  SHOW_RENDER: { NEVER: 0, AUTO: 2 },
  Niivue: class {
    constructor() {
      this.opts = {};
      this.volumes = [];
      this.sliceTypeMultiplanar = 3;
    }
    async attachTo(id) {
      viewerCalls.push(['attachTo', id]);
    }
    setMultiplanarPadPixels() {}
    setSliceType() {}
    setInterpolation(value) {
      viewerCalls.push(['setInterpolation', value]);
    }
    setCrosshairWidth(value) {
      viewerCalls.push(['setCrosshairWidth', value]);
    }
    drawScene() {}
    addColormap() {}
  }
};
const fetched = [];
globalThis.fetch = async url => {
  const target = String(url);
  fetched.push(target);
  if (target.endsWith('examples.json')) {
    return { ok: true, json: async () => JSON.parse(fs.readFileSync(path.join(ROOT, 'examples.json'), 'utf8')) };
  }
  if (target === 'build-info.json') {
    return { ok: true, json: async () => ({ sha: 'abc1234', branch: 'feature/x', dirty: false }) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};
globalThis.Worker = class {
  postMessage() {}
  terminate() {}
};

const { LesionNetworkMappingApp } = await import(path.join(ROOT, 'web/js/lnm-app.js'));
const { VERSION } = await import(path.join(ROOT, 'web/js/app/config.js'));
const app = new LesionNetworkMappingApp();
await app.init();
await new Promise(resolve => setTimeout(resolve, 0));

const click = id => document.getElementById(id).dispatchEvent(new dom.window.Event('click', { bubbles: true }));
const fire = (id, type) => document.getElementById(id).dispatchEvent(new dom.window.Event(type, { bubbles: true }));

// ---- boot ----
{
  assert.deepEqual(viewerCalls[0], ['attachTo', 'gl1'], 'NiiVue attaches to the #gl1 canvas');
  assert.equal(text($('#statusText')), 'Ready');
  assert.match(text($('#consoleOutput')), /Ready\.$/, 'the analysis log reports readiness');
  assert.equal(text($('#appVersion')), `v${VERSION} (abc1234, feature/x)`, 'header version label');
  assert.equal(text($('#aboutAppVersion')), `v${VERSION} (abc1234, feature/x)`, 'About version label');
  const selector = $('#stepLoadSection .section-content').firstElementChild;
  assert.equal(selector.tagName.toLowerCase(), 'nd-example-selector', 'the example selector leads the input section');
  assert.equal($('#atlasSelect').value, 'schaefer400');
  assert.equal($('#atlasSelect').options.length, 2, 'atlas options are not duplicated at boot');
  assert.equal(app.registrationQcMode, 'mni', 'QC view starts from the selected option');
  assert.equal(text($('#registrationBlendLabel')), '50% patient');
  const slider = $('#networkThresholdValue');
  assert.deepEqual([slider.min, slider.max, slider.step], ['0', '10', '0.1'], 'top-percent slider spans 0 to 10 % in 0.1 % steps');
  assert.equal(text($('#networkThresholdValueLabel')), '5%');
  // Nothing is loaded: every output control is disabled and no layer is on.
  for (const id of [
    'downloadOverlapCsv', 'downloadBrainMaskButton', 'downloadLesionMaskButton', 'downloadNetworkMapButton',
    'downloadThresholdedNetworkMapButton', 'showSubjectAtlasButton', 'downloadSubjectAtlasButton',
    'checkAtlasAlignmentButton', 'downloadEditedLesionMaskButton'
  ]) {
    assert.equal(document.getElementById(id).disabled, true, `${id} is disabled before any result exists`);
  }
  for (const id of ['layerToggleT1', 'layerToggleBrainMask', 'layerToggleLesionMask', 'layerToggleThresholdMap', 'layerToggleAtlasQc']) {
    const toggle = document.getElementById(id);
    assert.deepEqual([toggle.disabled, toggle.checked], [true, false], `${id} is off while its layer is unavailable`);
  }
}

// ---- every button runs its action ----
{
  const calls = [];
  const spy = (target, method, result = Promise.resolve()) => {
    target[method] = (...args) => {
      calls.push([method, ...args]);
      return result;
    };
  };
  for (const method of [
    'runFullPipeline', 'runBrainExtraction', 'prealignToMni160', 'runLesionSegmentation', 'runDeepIslesSegmentation',
    'startLesionMaskReview', 'runRegistration', 'showRegistrationQc', 'applyRegistrationToLesion', 'runAtlasOverlap',
    'runFcNetworkMap', 'exportCsv', 'downloadNetworkMap', 'downloadThresholdedNetworkMap', 'showSubjectSpaceAtlas',
    'downloadSubjectSpaceAtlas', 'clearResults', 'downloadBrainMask', 'downloadLesionMask', 'confirmLesionDrawing',
    'downloadEditedLesionMask', 'setMaskDrawingTool', 'handleRegistrationBlendInput', 'applyNetworkThreshold'
  ]) {
    assert.equal(typeof app[method], 'function', `app.${method} exists`);
    spy(app, method);
  }
  spy(app.maskDrawingController, 'undo', true);
  spy(app.maskDrawingController, 'smoothDrawing', true);
  spy(app.maskDrawingController, 'interpolateAcrossSlices', true);
  spy(app.viewerController, 'setViewType', undefined);

  const expectClick = async (id, expected) => {
    calls.length = 0;
    const element = document.getElementById(id);
    const wasDisabled = element.disabled;
    element.disabled = false;
    click(id);
    await new Promise(resolve => setTimeout(resolve, 0));
    element.disabled = wasDisabled;
    assert.deepEqual(calls, expected, `#${id}`);
  };

  await expectClick('runFullPipelineButton', [['runFullPipeline']]);
  await expectClick('runBrainExtractionButton', [['runBrainExtraction']]);
  await expectClick('prealignToMniButton', [['prealignToMni160']]);
  app.autoLesionSeedFile = { name: 'seed.nii' };
  await expectClick('runLesionSegmentationButton', [
    ['runLesionSegmentation'],
    ['startLesionMaskReview', { seedFile: app.autoLesionSeedFile }]
  ]);
  // A DWI-space DeepISLES seed never opens T1 mask review on its own.
  app.deepIslesSeedCompatibleWithNativeT1 = false;
  await expectClick('runDeepIslesSegmentationButton', [['runDeepIslesSegmentation']]);
  app.deepIslesSeedCompatibleWithNativeT1 = true;
  await expectClick('runDeepIslesSegmentationButton', [
    ['runDeepIslesSegmentation'],
    ['startLesionMaskReview', { seedFile: app.autoLesionSeedFile }]
  ]);
  await expectClick('startManualMaskButton', [['startLesionMaskReview', { blank: true }]]);
  await expectClick('runRegistrationButton', [['runRegistration']]);
  await expectClick('checkAtlasAlignmentButton', [['showRegistrationQc']]);
  await expectClick('applyRegistrationToLesionButton', [['applyRegistrationToLesion']]);
  await expectClick('computeOverlapButton', [['runAtlasOverlap']]);
  await expectClick('computeNetworkMapButton', [['runFcNetworkMap']]);
  await expectClick('downloadOverlapCsv', [['exportCsv']]);
  await expectClick('downloadNetworkMapButton', [['downloadNetworkMap']]);
  await expectClick('downloadThresholdedNetworkMapButton', [['downloadThresholdedNetworkMap']]);
  await expectClick('showSubjectAtlasButton', [['showSubjectSpaceAtlas']]);
  await expectClick('downloadSubjectAtlasButton', [['downloadSubjectSpaceAtlas']]);
  await expectClick('clearResultsButton', [['clearResults', { full: false }]]);
  await expectClick('downloadBrainMaskButton', [['downloadBrainMask']]);
  await expectClick('downloadLesionMaskButton', [['downloadLesionMask']]);

  // Mask review toolbar.
  await expectClick('maskPaintButton', [['setMaskDrawingTool', 'paint']]);
  await expectClick('maskEraseButton', [['setMaskDrawingTool', 'erase']]);
  await expectClick('maskEraseClusterButton', [['setMaskDrawingTool', 'eraseCluster']]);
  await expectClick('maskUndoButton', [['undo']]);
  await expectClick('maskBlankButton', [['startLesionMaskReview', { blank: true }]]);
  await expectClick('maskSmoothButton', [['smoothDrawing']]);
  $('#maskInterpolateAxis').value = '2';
  await expectClick('maskInterpolateButton', [['interpolateAcrossSlices', 2]]);
  await expectClick('confirmLesionMaskButton', [['confirmLesionDrawing', { resumePipeline: true }]]);
  await expectClick('downloadEditedLesionMaskButton', [['downloadEditedLesionMask']]);

  // Both upload buttons open the one hidden mask picker.
  let pickerOpened = 0;
  $('#manualMaskFileInput').click = () => {
    pickerOpened++;
  };
  click('uploadManualMaskButton');
  click('uploadReviewMaskButton');
  assert.equal(pickerOpened, 2, 'Upload mask and the review Upload open the mask picker');

  // Registration QC view and blend.
  calls.length = 0;
  $('#registrationQcMode').value = 'checkerboard';
  fire('registrationQcMode', 'change');
  assert.equal(app.registrationQcMode, 'checkerboard');
  assert.deepEqual(calls, [], 'changing the view before registration only records the choice');
  app.hasRegistrationDisplacement = true;
  $('#registrationQcMode').value = 'displacement';
  fire('registrationQcMode', 'change');
  assert.deepEqual(calls, [['showRegistrationQc']], 'after registration the new view is rendered');
  app.hasRegistrationDisplacement = false;
  calls.length = 0;
  fire('registrationBlendValue', 'input');
  assert.deepEqual(calls, [['handleRegistrationBlendInput']]);

  // Threshold controls recompute only once a network map exists.
  calls.length = 0;
  $('#networkThresholdValue').value = '2.5';
  fire('networkThresholdValue', 'input');
  assert.equal(text($('#networkThresholdValueLabel')), '2.5%', 'the slider label follows the slider');
  assert.deepEqual(calls, [], 'no map yet, nothing to threshold');
  app.networkMapData = new Float32Array(1);
  fire('networkThresholdValue', 'input');
  fire('networkThresholdSymmetric', 'change');
  fire('networkThresholdMinCluster', 'input');
  assert.deepEqual(calls, [['applyNetworkThreshold'], ['applyNetworkThreshold'], ['applyNetworkThreshold']]);
  app.networkMapData = null;

  // Viewer tabs; the 3D tab is refused while a mask is under review.
  calls.length = 0;
  $('.view-tab[data-view="axial"]').dispatchEvent(new dom.window.Event('click'));
  assert.deepEqual(calls, [['setViewType', 'axial']]);
  assert.deepEqual($$('.view-tab.active').map(tab => tab.dataset.view), ['axial']);
  app.maskReviewActive = true;
  $('.view-tab[data-view="render"]').dispatchEvent(new dom.window.Event('click'));
  assert.deepEqual($$('.view-tab.active').map(tab => tab.dataset.view), ['multiplanar'], '3D is replaced by 3-plane during review');
  app.maskReviewActive = false;

  // Viewer checkboxes.
  viewerCalls.length = 0;
  $('#crosshairToggle').checked = false;
  fire('crosshairToggle', 'change');
  $('#interpolation').checked = true;
  fire('interpolation', 'change');
  assert.deepEqual(viewerCalls, [['setCrosshairWidth', 0], ['setInterpolation', false]]);
}

// ---- atlas selection ----
{
  app.overlapResult = { stale: true };
  $('#downloadOverlapCsv').disabled = false;
  $('#atlasSelect').value = 'yeo7';
  fire('atlasSelect', 'change');
  assert.equal(app.selectedAtlasOptionId, 'yeo7');
  assert.equal(app.getAtlasOption().displayName, 'Yeo 7 networks');
  assert.equal(app.overlapResult, null, 'results from the previous atlas are dropped');
  assert.equal($('#downloadOverlapCsv').disabled, true);
  assert.match(text($('#consoleOutput')), /Atlas set to Yeo 7 networks\.$/);
  $('#atlasSelect').value = 'schaefer400';
  fire('atlasSelect', 'change');
  assert.equal(app.selectedAtlasOptionId, 'schaefer400');
}

// ---- file inputs reach their loaders ----
{
  const handled = [];
  app.structuralFileIO.handleFiles = files => handled.push(['structural', files]);
  app.lesionFileIO.handleFiles = files => handled.push(['lesion', files]);
  fire('structuralFileInput', 'change');
  fire('lesionFileInput', 'change');
  assert.deepEqual(handled.map(([kind]) => kind), ['structural', 'lesion']);
  assert.equal(handled[0][1], $('#structuralFileInput').files);
}

// ---- dialogs ----
{
  for (const [button, modal, close] of [
    ['aboutButton', 'aboutModal', 'closeAbout'],
    ['privacyButton', 'privacyModal', 'closePrivacy'],
    ['citationsButton', 'citationsModal', 'closeCitations']
  ]) {
    const overlay = document.getElementById(modal);
    assert.equal(overlay.classList.contains('active'), false);
    click(button);
    assert.equal(overlay.classList.contains('active'), true, `#${button} opens #${modal}`);
    click(close);
    assert.equal(overlay.classList.contains('active'), false, `#${close} closes it`);
  }
}

// ---- consoles: Copy and Clear ----
{
  app.updateOutput('Starting MNI registration (SynthMorph deformable)...');
  assert.match(text($('#consoleOutput')), /MNI registration started\.$/, 'the analysis log shows the condensed message');
  assert.match(
    text($('#technicalConsoleOutput')),
    /Starting MNI registration \(SynthMorph deformable\)\.\.\.$/,
    'the technical log keeps the full message'
  );
  click('clearConsole');
  assert.equal(text($('#consoleOutput')), '');
  assert.notEqual(text($('#technicalConsoleOutput')), '', 'clearing one log leaves the other');
  click('clearTechnicalConsole');
  assert.equal(text($('#technicalConsoleOutput')), '');
}

// ---- cancel ----
{
  let cancelled = 0;
  app.executor.cancel = () => {
    cancelled++;
  };
  app._pipelineRunning = true;
  $('#statusText').classList.add('error');
  click('cancelButton');
  assert.equal(cancelled, 1, 'the footer cancel stops the worker');
  assert.equal(app._pipelineRunning, false);
  assert.equal(text($('#statusText')), 'Cancelled');
  assert.equal($('#statusText').classList.contains('error'), false);
}

// ---- worker failures land in the status footer ----
{
  app.failStatus('Error: synthetic failure');
  assert.equal(text($('#statusText')), 'Error: synthetic failure');
  assert.ok($('#statusText').classList.contains('error'));
}

// =========================================================================
// Part 3: policy lints on the page source
// =========================================================================
// These are properties of the file itself, not of app behaviour.

// Policy: CDN scripts are pinned to an exact version.
for (const script of $$('script[src^="http"]')) {
  assert.match(
    script.getAttribute('src'),
    /^https:\/\/unpkg\.com\/@niivue\/niivue@\d+\.\d+\.\d+\/dist\/niivue\.umd\.js$/,
    `external script ${script.getAttribute('src')} must be the version-pinned NiiVue build`
  );
}

// Policy: analytics belong to the shared hosting shell, never to the app.
for (const script of $$('script')) {
  const source = `${script.getAttribute('src') || ''}\n${script.textContent}`;
  assert.doesNotMatch(
    source,
    /googletagmanager\.com|gtag\(|cloudflareinsights\.com|data-cf-beacon/,
    'the page must not bootstrap analytics itself'
  );
}
assert.equal($('[data-cf-beacon]'), null, 'no Cloudflare beacon attribute');

// Policy: the app hardcodes no colour scheme and draws no dialog element.
assert.equal($('dialog'), null, 'dialogs come from the shared shell, not <dialog> markup');

console.log('index.html OK: document structure, live control wiring and page policies checked with jsdom.');
process.exit(0);
