#!/usr/bin/env node

import assert from 'node:assert/strict';

// Shared fake-DOM helpers covering the surface that ProgressManager,
// ConsoleOutput, and ModalManager touch.

class FakeClassList {
  constructor() { this.classes = new Set(); }
  add(c) { this.classes.add(c); }
  remove(c) { this.classes.delete(c); }
  contains(c) { return this.classes.has(c); }
  toggle(c) { if (this.classes.has(c)) this.classes.delete(c); else this.classes.add(c); }
}

function makeStubElement(tag = 'div') {
  return {
    tag,
    className: '',
    classList: new FakeClassList(),
    style: {},
    textContent: '',
    innerHTML: '',
    scrollTop: 0,
    scrollHeight: 100,
    children: [],
    listeners: {},
    appendChild(child) { this.children.push(child); },
    append(...children) { this.children.push(...children); },
    addEventListener(evt, fn) { this.listeners[evt] = fn; },
    querySelectorAll() { return []; }
  };
}

function installFakeDom(elementIds = []) {
  const elements = new Map();
  for (const id of elementIds) elements.set(id, makeStubElement());
  const document = {
    getElementById: (id) => elements.get(id) || null,
    createElement: (tag) => {
      const element = makeStubElement(tag);
      element.ownerDocument = document;
      return element;
    }
  };
  for (const element of elements.values()) element.ownerDocument = document;
  globalThis.document = document;
  return elements;
}

// performance/requestAnimationFrame for ProgressManager.animate (we only test
// setProgress/reset/updateProgressBar, which never touch rAF; but constructor
// touches performance.now lazily — provide a stub so import can't fail).
globalThis.performance = globalThis.performance || { now: () => 0 };
globalThis.requestAnimationFrame = globalThis.requestAnimationFrame || (() => 1);
globalThis.cancelAnimationFrame = globalThis.cancelAnimationFrame || (() => {});

// ============================================================
// ProgressManager
// ============================================================
{
  const elements = installFakeDom(['progressBar']);
  const { ProgressManager } = await import('../../../packages/components/src/ui/ProgressManager.js');

  const pm = new ProgressManager({ animationSpeed: 1 });
  assert.equal(pm.progress, 0);
  assert.equal(pm.targetProgress, 0);

  pm.setProgress(0.5);
  assert.equal(pm.progress, 0.5);
  assert.equal(pm.animatedProgress, 0.5);
  assert.equal(elements.get('progressBar').style.width, '50%');

  pm.setProgress(1);
  assert.equal(elements.get('progressBar').style.width, '100%');

  pm.reset();
  assert.equal(pm.progress, 0);
  assert.equal(elements.get('progressBar').style.width, '0%');

  // setProgress stops any animation
  pm.animationFrame = 42;
  pm.setProgress(0.25);
  assert.equal(pm.animationFrame, null);

  // missing element doesn't crash
  installFakeDom([]);
  const pm2 = new ProgressManager({ animationSpeed: 1 });
  pm2.setProgress(0.5);
  // no assertion needed — just confirming no throw
}

// ============================================================
// ConsoleOutput
// ============================================================
{
  const elements = installFakeDom(['consoleOutput']);
  const { ConsoleOutput } = await import('../../../packages/components/src/ui/ConsoleOutput.js');

  const co = new ConsoleOutput();
  co.log('hello world');
  const out = elements.get('consoleOutput');
  assert.equal(out.children.length, 1);
  assert.equal(out.children[0].children.at(-1).textContent, 'hello world');
  assert.equal(out.children[0].children[0].className, 'nd-console-time');
  assert.equal(out.scrollTop, out.scrollHeight, 'scrolls to bottom');

  co.log('second line');
  assert.equal(out.children.length, 2);

  co.clear();
  assert.equal(out.innerHTML, '');

  // Custom element id is honored
  installFakeDom(['myCustomConsole']);
  const co2 = new ConsoleOutput('myCustomConsole');
  co2.log('routed to custom');
  // No throw == pass; the new fake DOM has the element.

  // Missing element is a silent no-op (but still console.logs)
  installFakeDom([]);
  const co3 = new ConsoleOutput();
  co3.log('nowhere'); // must not throw
  co3.clear();        // must not throw
}

// ============================================================
// ModalManager
// ============================================================
{
  const elements = installFakeDom(['myModal']);
  const { ModalManager } = await import('../../../packages/components/src/ui/ModalManager.js');

  const mm = new ModalManager('myModal');
  const modal = elements.get('myModal');
  assert.equal(mm.isOpen(), false);

  mm.open();
  assert.equal(mm.isOpen(), true);
  assert.equal(modal.classList.contains('active'), true);

  mm.close();
  assert.equal(mm.isOpen(), false);
  assert.equal(modal.classList.contains('active'), false);

  mm.toggle();
  assert.equal(mm.isOpen(), true);
  mm.toggle();
  assert.equal(mm.isOpen(), false);

  // Overlay click handler closes when target is the modal itself
  mm.open();
  const handler = modal.listeners.click;
  assert.equal(typeof handler, 'function', 'click handler installed');
  handler({ target: modal });
  assert.equal(mm.isOpen(), false);

  // Click on a child does not close
  mm.open();
  handler({ target: { tag: 'button' } });
  assert.equal(mm.isOpen(), true);

  // Missing element is a silent no-op
  installFakeDom([]);
  const mm2 = new ModalManager('doesNotExist');
  assert.equal(mm2.isOpen(), false);
  mm2.open();   // no throw
  mm2.close();  // no throw
  mm2.toggle(); // no throw
}

// ============================================================
// Analysis and technical logs: routing, and the console built from the app's own markup
// ============================================================
{
  const { ANALYSIS, TECHNICAL, describeRun, routePipelineMessage, routeWorkerLog } = await import('../web/js/app/log-channels.js');

  assert.deepEqual(routeWorkerLog('Session created. Input: input, Output: output'), { channel: TECHNICAL, level: 'info' });
  assert.deepEqual(routeWorkerLog('Warning: Could not cache model (storage full?)'), { channel: TECHNICAL, level: 'warning' });
  assert.deepEqual(routeWorkerLog('segmentation: 2400 voxels (1505.3 mm^3)', { channel: 'analysis', level: 'info' }), { channel: ANALYSIS, level: 'info' });
  assert.deepEqual(routeWorkerLog('WARNING: Segmentation is empty.', { channel: 'analysis', level: 'warning' }), { channel: ANALYSIS, level: 'warning' });
  assert.deepEqual(routeWorkerLog('x', { channel: 'unknown' }), { channel: TECHNICAL, level: 'info' });

  assert.deepEqual(routePipelineMessage('Initializing worker...'), { channel: TECHNICAL, level: 'info' });
  assert.deepEqual(routePipelineMessage('ONNX Runtime ready'), { channel: TECHNICAL, level: 'info' });
  assert.deepEqual(routePipelineMessage('Pipeline completed successfully'), { channel: TECHNICAL, level: 'info' });
  assert.deepEqual(routePipelineMessage('Cancelling...'), { channel: TECHNICAL, level: 'info' });
  assert.deepEqual(routePipelineMessage('Error: Model download failed'), { channel: ANALYSIS, level: 'error' });
  assert.deepEqual(routePipelineMessage('Worker error: out of memory'), { channel: ANALYSIS, level: 'error' });
  assert.deepEqual(routePipelineMessage('Aborted inference. Restored previous state.'), { channel: ANALYSIS, level: 'warning' });

  assert.deepEqual(describeRun({
    task: 'Spinal cord', input: 't2.nii.gz', model: 'sct-spinalcord.onnx', sourceVersion: 'r20250101',
    threshold: 0.5, minComponentSize: 0, overlap: 0.5, testTimeAugmentation: false, patchSize: [64, 224, 160],
  }), [
    'Task: Spinal cord on t2.nii.gz',
    'Parameters: model sct-spinalcord.onnx (r20250101), threshold 0.5, min component 0 voxels, overlap 0.5, TTA off, patch 64x224x160',
  ]);

  // The console element the app declares in index.html, driven the way the app drives it.
  const { readFileSync } = await import('node:fs');
  const { JSDOM } = await import('jsdom');
  const { defineConsole } = await import('../../../packages/components/src/elements/console.js');
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const markup = html.match(/<nd-console\b[^>]*><\/nd-console>/)[0];
  const { window } = new JSDOM(`<main><div id="canvas"></div>${markup}</main>`);
  defineConsole(window);
  const log = window.document.getElementById('spinalcordtoolbox-log');
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const write = (message, details) => {
    const { channel, level } = details === 'pipeline' ? routePipelineMessage(message) : routeWorkerLog(message, details);
    log.log(message, level, channel);
  };
  assert.equal(log.collapsed, true, 'console starts collapsed');
  assert.deepEqual(log.channels, [ANALYSIS, TECHNICAL]);
  assert.equal(log.activeChannel, ANALYSIS, 'the analysis log is shown first');
  assert.deepEqual([...log.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent), ['Analysis', 'Technical']);
  assert.equal(log.querySelector('[data-disclosure-toggle]').textContent, 'Log');

  write('Task: Spinal cord on t2.nii.gz', { channel: 'analysis' });
  write('Creating ONNX InferenceSession (wasm - 3D ops require WASM backend)...');
  write('segmentation: 2400 voxels (1505.3 mm^3)', { channel: 'analysis' });
  write('Inference complete in 12.3s');
  write('Pipeline completed successfully', 'pipeline');
  assert.equal(log.collapsed, true, 'ordinary lines leave the console collapsed');
  const lines = (channel) => [...log.querySelectorAll(`#spinalcordtoolbox-logOutput-${channel} .nd-console-message`)].map((node) => node.textContent);
  assert.deepEqual(lines(ANALYSIS), ['Task: Spinal cord on t2.nii.gz', 'segmentation: 2400 voxels (1505.3 mm^3)']);
  assert.deepEqual(lines(TECHNICAL), [
    'Creating ONNX InferenceSession (wasm - 3D ops require WASM backend)...',
    'Inference complete in 12.3s',
    'Pipeline completed successfully',
  ]);
  assert.equal(lines(ANALYSIS).filter((line) => lines(TECHNICAL).includes(line)).length, 0, 'no line is in both logs');

  // Toggle open and closed: both logs keep their entries.
  const toggle = log.querySelector('[data-disclosure-toggle]');
  toggle.click();
  await tick();
  assert.equal(log.collapsed, false);
  toggle.click();
  await tick();
  assert.equal(log.collapsed, true);
  assert.equal(log.querySelectorAll('.nd-console-line').length, 5, 'entries survive collapse and reopen');

  // Clear acts on the visible log only.
  log.querySelector('[role="tab"][data-console-channel="technical"]').click();
  await tick();
  assert.equal(log.collapsed, false, 'choosing a tab opens the console');
  log.querySelector('#spinalcordtoolbox-logClear').click();
  assert.equal(log.getText(TECHNICAL), '');
  assert.match(log.getText(ANALYSIS), /segmentation: 2400 voxels/);

  // A failed run opens the console on the analysis log.
  toggle.click();
  await tick();
  write('Error: Model download failed', 'pipeline');
  await tick();
  assert.equal(log.collapsed, false);
  assert.equal(log.activeChannel, ANALYSIS);

  // Enlarge with the keyboard; the size is kept while collapsed.
  const height = () => log.style.getPropertyValue('--nd-console-height');
  log.getBoundingClientRect = () => ({ height: parseFloat(height()) || 120 });
  window.document.getElementById('canvas').getBoundingClientRect = () => ({ height: 600 - (parseFloat(height()) || 120) });
  const handle = log.querySelector('.nd-console-resizer');
  assert.equal(handle.getAttribute('role'), 'separator');
  handle.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'PageUp', bubbles: true, cancelable: true }));
  assert.equal(height(), '216px');
  handle.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
  assert.equal(height(), '440px', 'the viewer keeps 160px');
  toggle.click();
  await tick();
  toggle.click();
  await tick();
  assert.equal(height(), '440px', 'size survives collapse and reopen');
  window.close();
}

console.log('UI module tests passed');
