#!/usr/bin/env node --no-warnings

// UI control tests.
//
// Part 1 parses web/index.html with jsdom and queries the document: presence,
// accessible names and the layout rules of the interface standard.
// Part 2 boots the real application in jsdom (fake NiiVue and Worker at the
// boundary), operates each control and asserts what the user would observe.
//
// Controls whose behaviour is task routing (SCT Task, Run, the advanced
// segmentation settings, SCT Processing, result eye buttons, the Input
// toggle, statistics download) are exercised in test_task_routing.mjs. The
// stylesheet-dependent rule (a hidden viewer message really is not painted)
// needs a layout engine and lives in e2e/controls.spec.js.

import assert from 'node:assert/strict';
import {
  bootApp,
  chooseFiles,
  click,
  emitStage,
  loadInput,
  parseIndexHtml,
  report,
  setChecked,
  setValue,
  settle,
  tinyNiftiFile,
  waitFor
} from './lib/app-harness.mjs';

let checks = 0;
function check(fn) {
  checks++;
  return fn();
}

// ---------------------------------------------------------------------------
// Part 1: the static document.
// ---------------------------------------------------------------------------
{
  const { document } = parseIndexHtml().window;

  // Every interactive control has an accessible name.
  function accessibleName(control) {
    const labelled = control.getAttribute('aria-label') || control.getAttribute('title');
    if (labelled) return labelled.trim();
    if (control.id) {
      const label = document.querySelector(`label[for="${control.id}"]`);
      if (label) return label.textContent.trim();
    }
    const wrapping = control.closest('label');
    if (wrapping) return wrapping.textContent.trim();
    return control.textContent.trim();
  }
  const controls = [...document.querySelectorAll('button, select, input, a[href]')];
  check(() => assert.ok(controls.length >= 40, `expected the full control set, found ${controls.length}`));
  const unnamed = controls.filter(control => !accessibleName(control)).map(control => control.id || control.outerHTML.slice(0, 60));
  check(() => assert.deepEqual(unnamed, [], 'every control has an accessible name'));
  check(() => assert.equal(
    document.querySelector('#inputDropZone .file-drop-label').textContent.trim(),
    'Drop NIfTI or DICOM files'
  ));

  // Control ids are unique, so a label or a handler can only mean one element.
  const ids = [...document.querySelectorAll('[id]')].map(element => element.id);
  check(() => assert.deepEqual(ids.filter((id, index) => ids.indexOf(id) !== index), [], 'element ids are unique'));

  // Form controls in the sidebar are bound to a label.
  for (const id of ['modelSelect', 'thresholdInput', 'minSizeInput', 'processingOperationSelect']) {
    check(() => assert.ok(document.querySelector(`label[for="${id}"]`), `#${id} has a <label for>`));
  }
  check(() => assert.ok(document.getElementById('ttaToggle').closest('label'), 'the TTA checkbox sits inside its label'));
  check(() => assert.equal(document.querySelector('label[for="modelSelect"]').firstChild.textContent.trim(), 'SCT Task'));

  // Status lives in the shared footer: message, native progress, hidden cancel.
  const footer = document.querySelector('footer#status.nd-imaging-status');
  check(() => assert.ok(footer, 'the status footer exists'));
  check(() => assert.equal(document.querySelector('.app-container').lastElementChild, footer, 'the footer is the last child of the app container'));
  const statusText = footer.querySelector('#statusText.nd-status-text');
  check(() => assert.equal(statusText.getAttribute('role'), 'status'));
  check(() => assert.equal(statusText.getAttribute('aria-live'), 'polite'));
  check(() => assert.equal(footer.querySelector('#progress').tagName, 'PROGRESS'));
  check(() => assert.equal(footer.querySelector('#progress').getAttribute('aria-label'), 'Processing progress'));
  const cancel = footer.querySelector('#cancelButton.nd-btn-cancel');
  check(() => assert.equal(cancel.hidden, true, 'cancel is hidden until a run can be cancelled'));
  check(() => assert.equal(cancel.getAttribute('aria-label'), 'Cancel processing'));
  check(() => assert.equal(document.querySelectorAll('.nd-btn-cancel, [id*="abort" i]').length, 1, 'the footer cancel is the only abort control'));
  check(() => assert.equal(document.querySelector('.app-sidebar progress, .app-sidebar [role="status"], .sidebar-status'), null, 'no status or progress in the sidebar'));

  // One primary action in the sidebar; every other action is secondary.
  const primary = [...document.querySelectorAll('.app-sidebar .btn-primary')].map(button => button.id);
  check(() => assert.deepEqual(primary, ['runSegmentation']));
  check(() => assert.ok(document.getElementById('runProcessingBtn').classList.contains('btn-secondary')));

  // The workspace is the first screen.
  check(() => assert.equal(document.querySelector('#startPage, #enterAppButton, .start-page, .hero, .landing'), null, 'no start page'));

  // The technical log is a collapsed console below the viewer.
  const consoleContainer = document.querySelector('main .console-container');
  check(() => assert.ok(consoleContainer.classList.contains('collapsed')));
  check(() => assert.deepEqual(
    [...consoleContainer.querySelectorAll('.console-header button')].map(button => button.textContent.trim()),
    ['Technical log', 'Copy', 'Clear']
  ));
  check(() => assert.equal(document.getElementById('processingOutput'), null, 'processing output goes to the technical log'));

  // Viewer fallback copy: names the cause and the remedy in at most 90 characters.
  const fallbackMessage = document.getElementById('viewerUnavailableMessage');
  const fallbackText = fallbackMessage.textContent.trim();
  check(() => assert.equal(fallbackMessage.hidden, true));
  check(() => assert.ok(fallbackText.length <= 90, `fallback guidance is ${fallbackText.length} characters`));
  check(() => assert.match(fallbackText, /WebGL2/));
  check(() => assert.match(fallbackText, /hardware acceleration/i));

  // Navigation and hosting.
  check(() => assert.equal(document.getElementById('moreAppsLink').getAttribute('href'), '../', 'More Apps returns to the catalog'));
  const external = [...document.querySelectorAll('a[href^="http"]')].map(link => link.getAttribute('href'));
  check(() => assert.ok(external.includes('https://github.com/neurodesk/webapps/tree/main/apps/spinalcordtoolbox'), 'the source link targets the monorepo app'));
  check(() => assert.ok(!external.some(href => href.includes('neurodesk.org/getting-started/hosted/webapps')), 'no link leaves the composite site for the catalog'));
  const scripts = [...document.querySelectorAll('script')];
  check(() => assert.ok(!scripts.some(script => /googletagmanager|gtag\(/.test(`${script.src} ${script.textContent}`)), 'analytics is injected by the hosting shell, not the app'));
  check(() => assert.ok(scripts.some(script => script.getAttribute('src') === 'nifti-js/index.js'), 'the NIfTI parser for the 2D fallback preview is loaded'));

  // Privacy and citation copy.
  const privacy = document.getElementById('privacyModal').textContent.replace(/\s+/g, ' ');
  check(() => assert.match(privacy, /records page views only, unless your browser sends Do Not Track or Global Privacy Control/));
  check(() => assert.match(privacy, /It does not send custom events/));
  const citations = document.getElementById('citationsModal').textContent.replace(/\s+/g, ' ');
  check(() => assert.match(citations, /SCT: Spinal Cord Toolbox, an open-source software for processing spinal cord MRI data/));
  check(() => assert.ok(document.querySelector('#citationsModal a[href="https://spinalcordtoolbox.com/stable/"]')));
}

// ---------------------------------------------------------------------------
// Part 2: operate the controls of the running application.
// ---------------------------------------------------------------------------
{
  const harness = await bootApp();
  const { document } = harness;
  const byId = id => document.getElementById(id);
  const countCalls = name => harness.niivueCalls.filter(call => call[0] === name).length;
  const lastCall = name => harness.niivueCalls.filter(call => call[0] === name).at(-1);

  // Before any input: version shown, steps locked, viewer attached to #gl1.
  check(() => assert.match(byId('appVersion').textContent, /^v\d+\.\d+\.\d{8}$/));
  check(() => assert.equal(byId('runSegmentation').disabled, true));
  check(() => assert.equal(byId('runProcessingBtn').disabled, true));
  check(() => assert.deepEqual(harness.niivueCalls[0], ['attachTo', 'gl1']));
  check(() => assert.equal(byId('viewerUnavailableMessage').hidden, true));
  check(() => assert.equal(byId('statusText').textContent, 'Ready'));
  check(() => assert.ok(document.querySelector('nd-example-selector'), 'the example selector is offered in the Input section'));
  check(() => assert.equal(byId('taskInfoTooltip').textContent.length > 20, true, 'the SCT Task tooltip carries the task description'));
  check(() => assert.equal(byId('taskDetails').textContent.startsWith('Input: '), true));

  // #fileInput: choosing a file loads it into the viewer and the worker.
  await loadInput(harness, 'first.nii');
  check(() => assert.equal(harness.postedOfType('load').length, 1));
  check(() => assert.ok(harness.postedOfType('load')[0].message.data.inputData instanceof ArrayBuffer));
  check(() => assert.deepEqual(harness.viewerStack(), [{ name: 'first.nii', colormap: 'gray' }]));
  check(() => assert.equal(document.querySelector('#inputDropZone .file-drop-label span').textContent, 'first.nii'));
  check(() => assert.ok(byId('inputDropZone').classList.contains('has-files')));
  check(() => assert.deepEqual([...document.querySelectorAll('#fileList .file-session-select')].map(button => button.textContent), ['first.nii']));
  check(() => assert.equal(byId('runSegmentation').disabled, false, 'Run unlocks once the input is loaded'));
  check(() => assert.equal(byId('runProcessingBtn').disabled, false));
  check(() => assert.equal(byId('stepInferenceSection').classList.contains('step-disabled'), false));

  // Compare needs two inputs.
  check(() => assert.equal(byId('compareViewButton').disabled, true));

  // #inputDropZone: dropping a NIfTI adds a second session.
  const zone = byId('inputDropZone');
  const dragover = new harness.window.Event('dragover', { bubbles: true, cancelable: true });
  zone.dispatchEvent(dragover);
  check(() => assert.ok(zone.classList.contains('dragover')));
  check(() => assert.equal(dragover.defaultPrevented, true, 'dragover is accepted so the browser allows a drop'));
  const drop = new harness.window.Event('drop', { bubbles: true, cancelable: true });
  const dropped = tinyNiftiFile('second.nii');
  drop.dataTransfer = { items: [{ getAsFile: () => dropped }] };
  zone.dispatchEvent(drop);
  await waitFor(() => harness.postedOfType('load').length === 2, 'the dropped file to reach the worker');
  harness.worker().emit({ type: 'step-complete', step: 'load' });
  await settle(harness);
  check(() => assert.equal(zone.classList.contains('dragover'), false));
  check(() => assert.deepEqual([...document.querySelectorAll('#fileList .file-session-select')].map(button => button.textContent), ['first.nii', 'second.nii']));
  check(() => assert.equal(document.querySelector('#inputDropZone .file-drop-label span').textContent, '2 images loaded'));
  check(() => assert.equal(document.querySelector('#fileList .file-item.active .file-session-select').textContent, 'second.nii'));

  // #compareViewButton / #singleViewButton.
  check(() => assert.equal(byId('compareViewButton').disabled, false));
  click(byId('compareViewButton'));
  await settle(harness);
  check(() => assert.ok(byId('compareViewButton').classList.contains('active')));
  check(() => assert.equal(byId('singleViewButton').classList.contains('active'), false));
  check(() => assert.equal(byId('comparisonGrid').hidden, false));
  check(() => assert.equal(byId('comparisonGrid').querySelectorAll('canvas').length, 2, 'one canvas per loaded image'));
  check(() => assert.equal(byId('viewerInfoPrimary').textContent, 'Comparison: 2 images'));
  click(byId('singleViewButton'));
  await settle(harness);
  check(() => assert.ok(byId('singleViewButton').classList.contains('active')));
  check(() => assert.equal(byId('comparisonGrid').hidden, true));
  check(() => assert.equal(byId('comparisonGrid').querySelectorAll('canvas').length, 0));

  // #fileList: the × removes a session; removing the last one clears the input.
  click(document.querySelector('#fileList .file-remove[aria-label="Remove first.nii"]'));
  await waitFor(() => harness.postedOfType('load').length === 3 || document.querySelectorAll('#fileList .file-item').length === 1, 'the session list to shrink');
  check(() => assert.deepEqual([...document.querySelectorAll('#fileList .file-session-select')].map(button => button.textContent), ['second.nii']));
  check(() => assert.equal(byId('compareViewButton').disabled, true));
  await settle(harness);

  // View tabs change the slice type (NiiVue: axial 0, coronal 1, sagittal 2, multiplanar 3, render 4).
  const tab = view => document.querySelector(`.view-tab[data-view="${view}"]`);
  for (const [view, sliceType] of [['axial', 0], ['coronal', 1], ['sagittal', 2], ['render', 4], ['multiplanar', 3]]) {
    click(tab(view));
    check(() => assert.deepEqual(lastCall('setSliceType'), ['setSliceType', sliceType], `${view} tab`));
    check(() => assert.deepEqual([...document.querySelectorAll('.view-tab[data-view].active')].map(button => button.dataset.view), [view]));
  }

  // Display toggles.
  setChecked(byId('interpolation'), true);
  check(() => assert.deepEqual(lastCall('setInterpolation'), ['setInterpolation', false], 'Interp on means nearest-neighbour off'));
  setChecked(byId('interpolation'), false);
  check(() => assert.deepEqual(lastCall('setInterpolation'), ['setInterpolation', true]));
  setChecked(byId('colorbarToggle'), true);
  check(() => assert.equal(harness.app.nv.opts.isColorbar, true));
  setChecked(byId('colorbarToggle'), false);
  check(() => assert.equal(harness.app.nv.opts.isColorbar, false));
  setChecked(byId('crosshairToggle'), false);
  check(() => assert.deepEqual(lastCall('setCrosshairWidth'), ['setCrosshairWidth', 0]));
  setChecked(byId('crosshairToggle'), true);
  check(() => assert.deepEqual(lastCall('setCrosshairWidth'), ['setCrosshairWidth', 1]));

  // #colormapSelect recolours the base volume.
  setValue(byId('colormapSelect'), 'viridis');
  check(() => assert.equal(harness.app.nv.volumes[0].colormap, 'viridis'));
  setValue(byId('colormapSelect'), 'gray');

  // Display window: the fake volume spans 0..1.
  const volume = () => harness.app.nv.volumes[0];
  setValue(byId('windowMin'), '0.25');
  check(() => assert.equal(volume().cal_min, 0.25));
  setValue(byId('windowMax'), '0.75');
  check(() => assert.equal(volume().cal_max, 0.75));
  setValue(byId('rangeMin'), '10', 'input');
  check(() => assert.ok(Math.abs(volume().cal_min - 0.1) < 1e-9, `rangeMin 10% of 0..1 is 0.1, got ${volume().cal_min}`));
  setValue(byId('rangeMax'), '90', 'input');
  check(() => assert.ok(Math.abs(volume().cal_max - 0.9) < 1e-9, `rangeMax 90% of 0..1 is 0.9, got ${volume().cal_max}`));
  click(byId('resetWindow'));
  check(() => assert.notEqual(volume().cal_max, 0.9, 'Auto replaces the manual window'));

  // #downloadCurrentVolume and #screenshotViewer.
  click(byId('downloadCurrentVolume'));
  check(() => assert.deepEqual(harness.downloads.map(download => download.name), ['second.nii']));
  click(byId('screenshotViewer'));
  check(() => assert.deepEqual(lastCall('saveScene'), ['saveScene', 'second_screenshot.png']));

  // #runSegmentation starts a cancellable run; the footer shows it.
  click(byId('runSegmentation'));
  await waitFor(() => harness.postedOfType('run-inference').length === 1, 'run-inference');
  check(() => assert.equal(byId('cancelButton').hidden, false, 'the × appears while the run can be cancelled'));
  check(() => assert.equal(byId('statusText').textContent, 'Running segmentation…'));
  check(() => assert.equal(byId('stepInferenceBadge').textContent.length > 0, true));
  harness.worker().emit({ type: 'progress', value: 0.4, text: 'Sliding window 4/10' });
  check(() => assert.equal(byId('statusText').textContent, 'Sliding window 4/10'));

  // #cancelButton stops the worker and restores the pre-run state.
  const runningWorker = harness.worker();
  click(byId('cancelButton'));
  await waitFor(() => runningWorker.terminated, 'the running worker to be terminated');
  await waitFor(() => harness.worker() !== runningWorker && harness.postedOfType('restore-state').length === 1, 'a fresh worker to be asked to restore state');
  harness.worker().emit({ type: 'state-restored' });
  await waitFor(() => byId('statusText').textContent === 'Cancelled', 'the footer to report Cancelled');
  check(() => assert.equal(byId('cancelButton').hidden, true));
  check(() => assert.equal(byId('runSegmentation').disabled, false, 'Run is available again after a cancel'));
  check(() => assert.equal(byId('resultsSection').classList.contains('hidden'), true, 'a cancelled run leaves no results'));

  // A worker error ends the run with the message in the footer.
  click(byId('runSegmentation'));
  await waitFor(() => harness.postedOfType('run-inference').length === 2, 'second run-inference');
  harness.worker().emit({ type: 'error', message: 'Model download failed (503)' });
  await settle(harness);
  check(() => assert.equal(byId('statusText').textContent, 'Error: Model download failed (503)'));
  check(() => assert.ok(byId('statusText').classList.contains('error')));
  check(() => assert.equal(byId('cancelButton').hidden, true));
  check(() => assert.equal(byId('runSegmentation').disabled, false));

  // A completed run: results appear, with a per-stage download.
  click(byId('runSegmentation'));
  await waitFor(() => harness.postedOfType('run-inference').length === 3, 'third run-inference');
  check(() => assert.equal(byId('statusText').classList.contains('error'), false, 'a new run clears the error state'));
  await emitStage(harness, 'segmentation', { taskId: 'spinalcord' });
  harness.worker().emit({ type: 'step-complete', step: 'inference' });
  harness.worker().emit({ type: 'complete' });
  await settle(harness);
  check(() => assert.equal(byId('statusText').textContent, 'Complete'));
  check(() => assert.equal(byId('progress').value, 1));
  check(() => assert.equal(byId('cancelButton').hidden, true));
  check(() => assert.equal(byId('resultsSection').classList.contains('hidden'), false));
  check(() => assert.deepEqual([...document.querySelectorAll('#stageButtons .stage-label')].map(label => label.textContent), ['Input', 'SCT Segmentation']));
  click(document.querySelector('#stageButtons .download-btn[title="Download SCT Segmentation"]'));
  check(() => assert.equal(harness.downloads.at(-1).name, 'spinalcord_segmentation.nii'));

  // #overlayOpacity drives the overlay and its readout.
  check(() => assert.equal(byId('overlayControl').classList.contains('hidden'), false));
  check(() => assert.equal(byId('overlayOpacity').value, '0.7'));
  check(() => assert.equal(byId('overlayOpacityValue').textContent, '70%'));
  setValue(byId('overlayOpacity'), '0.4', 'input');
  check(() => assert.equal(byId('overlayOpacityValue').textContent, '40%'));
  check(() => assert.deepEqual(lastCall('setOpacity'), ['setOpacity', 1, 0.4], 'opacity is applied to the overlay volume, not the base'));

  // Technical log: Copy and Clear.
  check(() => assert.match(harness.logText(), /Pipeline completed successfully/));
  click(byId('copyConsole'));
  await waitFor(() => harness.clipboard.length === 1, 'the log to be copied');
  check(() => assert.match(harness.clipboard[0], /Pipeline completed successfully/));
  check(() => assert.equal(byId('copyConsole').textContent, 'Copied!'));
  click(byId('clearConsole'));
  check(() => assert.equal(byId('consoleOutput').children.length, 0));

  // Section disclosure: the log header toggles its panel.
  const logContainer = document.querySelector('.console-container');
  check(() => assert.ok(logContainer.classList.contains('collapsed')));
  click(logContainer.querySelector('[data-disclosure-toggle]'));
  check(() => assert.equal(logContainer.classList.contains('collapsed'), false));

  // #clearResults removes results and overlays, keeps the input.
  click(byId('clearResults'));
  await settle(harness);
  check(() => assert.equal(byId('resultsSection').classList.contains('hidden'), true));
  check(() => assert.equal(byId('stageButtons').children.length, 0));
  check(() => assert.equal(byId('overlayControl').classList.contains('hidden'), true));
  check(() => assert.deepEqual(harness.app.inferenceExecutor.getStageOrder(), []));
  check(() => assert.deepEqual(harness.viewerStack().map(item => item.name), ['second.nii']));

  // Shell dialogs open and close.
  for (const [open, close, modal] of [
    ['aboutButton', 'closeAbout', 'aboutModal'],
    ['citationsButton', 'closeCitations', 'citationsModal'],
    ['privacyButton', 'closePrivacy', 'privacyModal']
  ]) {
    check(() => assert.equal(byId(modal).classList.contains('active'), false));
    click(byId(open));
    check(() => assert.equal(byId(modal).classList.contains('active'), true, `${open} opens ${modal}`));
    click(byId(close));
    check(() => assert.equal(byId(modal).classList.contains('active'), false, `${close} closes ${modal}`));
  }
  check(() => assert.match(byId('aboutAppVersion').textContent, /^v\d+\.\d+\.\d{8}$/));

  // Removing the last session clears the input and locks the steps again.
  click(document.querySelector('#fileList .file-remove'));
  await waitFor(() => byId('runSegmentation').disabled, 'the steps to lock after the input is cleared');
  check(() => assert.equal(document.querySelectorAll('#fileList .file-item').length, 0));
  check(() => assert.equal(document.querySelector('#inputDropZone .file-drop-label span').textContent, 'Drop NIfTI or DICOM files'));
  check(() => assert.equal(byId('runProcessingBtn').disabled, true));
}

// ---------------------------------------------------------------------------
// Part 3: no WebGL2. The app still starts and processing stays usable.
// ---------------------------------------------------------------------------
{
  const harness = await bootApp({ niivueAttachError: 'WebGL2 context creation failed' });
  const { document } = harness;
  const message = document.getElementById('viewerUnavailableMessage');
  check(() => assert.equal(message.hidden, false));
  check(() => assert.equal(message.textContent, 'No preview: WebGL2 failed. Enable hardware acceleration (see chrome://gpu), then reload.'));
  check(() => assert.equal(message.title, 'WebGL2 context creation failed'));
  check(() => assert.ok(document.body.classList.contains('viewer-unavailable')));
  const toolbar = [...document.querySelectorAll('.viewer-toolbar button, .viewer-toolbar input, .viewer-toolbar select')];
  check(() => assert.ok(toolbar.length >= 15));
  check(() => assert.deepEqual(toolbar.filter(control => !control.disabled).map(control => control.id), [], 'viewer-only controls are disabled'));

  chooseFiles(harness, [tinyNiftiFile('nogl.nii')]);
  await waitFor(() => harness.postedOfType('load').length === 1, 'the input to load without a viewer');
  harness.worker().emit({ type: 'step-complete', step: 'load' });
  await settle(harness);
  check(() => assert.equal(document.getElementById('runSegmentation').disabled, false, 'segmentation stays usable without WebGL2'));
  click(document.getElementById('runSegmentation'));
  await waitFor(() => harness.postedOfType('run-inference').length === 1, 'run-inference without a viewer');
  check(() => assert.equal(harness.niivueCalls.filter(call => call[0] === 'loadVolumes').length, 0, 'nothing is sent to the dead viewer'));
}

report(`UI controls OK: ${checks} checks (static document, operated controls, no-WebGL2 start).`);
process.exit(0);
