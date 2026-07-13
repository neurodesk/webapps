#!/usr/bin/env node --no-warnings
// Phase 35: behavior tests for the three UI modules.
//   - ConsoleOutput: log/clear/copy against a fake DOM
//   - ProgressManager: setProgress/reset, no-op when DOM missing
//   - ModalManager: open/close/toggle/isOpen + overlay-click-to-close

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Minimal DOM stub just rich enough for these modules. Each module calls
// document.getElementById; we hand back recording-fake elements.
function makeFakeElement(id) {
  const el = {
    id,
    children: [],
    classList: {
      _classes: new Set(),
      add(c) { this._classes.add(c); },
      remove(c) { this._classes.delete(c); },
      contains(c) { return this._classes.has(c); }
    },
    listeners: {},
    appendChild(child) { child.parentNode = this; this.children.push(child); },
    removeChild(child) { this.children = this.children.filter(c => c !== child); },
    addEventListener(event, fn) {
      (this.listeners[event] ||= []).push(fn);
    },
    querySelectorAll(sel) {
      // Only used by ConsoleOutput.copyToClipboard for '.console-line';
      // return all appended children.
      return sel === '.console-line' ? this.children : [];
    },
    set innerHTML(v) { if (v === '') this.children = []; },
    get innerHTML() { return ''; },
    set textContent(v) { this._text = v; },
    get textContent() { return this._text || ''; },
    style: {},
    setAttribute(name, value) { this[name] = value; },
    select() { this.selected = true; },
    remove() { this.parentNode?.removeChild(this); },
    scrollTop: 0,
    get scrollHeight() { return this.children.length * 20; }
  };
  return el;
}

function setupDom(elementsById = {}) {
  const body = makeFakeElement('body');
  globalThis.document = {
    _elements: elementsById,
    _lastCommand: null,
    body,
    getElementById(id) { return elementsById[id] || null; },
    createElement(tag) {
      const el = makeFakeElement(`new-${tag}`);
      el.tagName = tag.toUpperCase();
      Object.defineProperty(el, 'className', {
        configurable: true,
        set(v) { el._cls = v; },
        get() { return el._cls || ''; }
      });
      Object.defineProperty(el, 'innerHTML', {
        configurable: true,
        set(v) {
          el._innerHtml = v;
          el._text = v.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
        },
        get() { return el._innerHtml || ''; }
      });
      Object.defineProperty(el, 'textContent', {
        configurable: true,
        set(v) { el._text = v; },
        get() { return el._text || ''; }
      });
      return el;
    },
    execCommand(command) {
      this._lastCommand = command;
      return command === 'copy';
    }
  };
  globalThis.requestAnimationFrame = (cb) => 1;
  globalThis.cancelAnimationFrame = () => {};
  globalThis.setTimeout = () => 1;
  globalThis.performance = globalThis.performance || { now: () => Date.now() };
}

// ---- ConsoleOutput ----
{
  const consoleEl = makeFakeElement('consoleOutput');
  setupDom({ consoleOutput: consoleEl });
  const { ConsoleOutput } = await import(path.join(ROOT, 'web/js/modules/ui/ConsoleOutput.js'));

  const co = new ConsoleOutput('consoleOutput');
  co.log('first message');
  co.log('second message');
  assert.equal(consoleEl.children.length, 2,
    'log() must append one DOM line per call');
  // Each line is an element with .console-line class info inside innerHTML.
  assert.ok(consoleEl.children[0]._innerHtml.includes('first message'),
    'first message must appear in the line innerHTML');
  // scrollTop is set to scrollHeight to autoscroll.
  assert.equal(consoleEl.scrollTop, consoleEl.scrollHeight,
    'log() must autoscroll to the bottom');

  // clear() empties the list.
  co.clear();
  assert.equal(consoleEl.children.length, 0,
    'clear() must remove all lines');

  // copyToClipboard uses navigator.clipboard when available.
  co.log('copy me');
  const copyBtn = makeFakeElement('copyConsole');
  let clipboardText = null;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { clipboard: { writeText: async (text) => { clipboardText = text; } } }
  });
  setupDom({ consoleOutput: consoleEl, copyConsole: copyBtn });
  assert.equal(await co.copyToClipboard(), true,
    'copyToClipboard must report success when navigator.clipboard works');
  assert.match(clipboardText, /copy me/,
    'copyToClipboard must write console text to navigator.clipboard');
  assert.equal(copyBtn.textContent, 'Copied!');

  // If the Clipboard API rejects, fall back to textarea + execCommand.
  let fallbackTextarea = null;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { clipboard: { writeText: async () => { throw new Error('permission denied'); } } }
  });
  setupDom({ consoleOutput: consoleEl, copyConsole: copyBtn });
  const originalCreateElement = document.createElement.bind(document);
  document.createElement = (tag) => {
    const el = originalCreateElement(tag);
    if (tag === 'textarea') fallbackTextarea = el;
    return el;
  };
  assert.equal(await co.copyToClipboard(), true,
    'copyToClipboard must fall back when navigator.clipboard rejects');
  assert.match(fallbackTextarea.value, /copy me/,
    'fallback textarea must receive console text');
  assert.equal(document._lastCommand, 'copy',
    'fallback path must invoke document.execCommand("copy")');

  // Custom log viewers can carry source/level metadata and copy via their own button.
  const techEl = makeFakeElement('technicalConsoleOutput');
  const techCopyBtn = makeFakeElement('copyTechnicalConsole');
  let techClipboardText = null;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { clipboard: { writeText: async (text) => { techClipboardText = text; } } }
  });
  setupDom({ technicalConsoleOutput: techEl, copyTechnicalConsole: techCopyBtn });
  const techConsole = new ConsoleOutput({
    outputElementId: 'technicalConsoleOutput',
    copyButtonId: 'copyTechnicalConsole'
  });
  techConsole.log('worker detail', { source: 'worker', level: 'error' });
  assert.equal(techEl.children.length, 1,
    'custom log viewer must append lines to its configured output element');
  assert.match(techEl.children[0]._cls, /console-line-error/,
    'log level must be reflected in the line class');
  assert.match(techEl.children[0]._innerHtml, /console-source[^>]*>\[worker\]/,
    'log source must be rendered for diagnostic logs');
  assert.equal(await techConsole.copyToClipboard(), true,
    'custom log viewer must copy through its configured copy button');
  assert.match(techClipboardText, /worker detail/,
    'custom log copy must use that viewer text');
  assert.equal(techCopyBtn.textContent, 'Copied!');

  // No-op when the DOM element doesn't exist (use a fresh ID).
  setupDom({});
  const co2 = new ConsoleOutput('missingId');
  // Must not throw.
  co2.log('orphan');
  co2.clear();
}

// ---- ProgressManager ----
{
  const progressEl = makeFakeElement('progressBar');
  setupDom({ progressBar: progressEl });
  const { ProgressManager } = await import(path.join(ROOT, '../../packages/components/src/ui/ProgressManager.js'));

  const pm = new ProgressManager({ animationSpeed: 1.0 });
  pm.setProgress(0.42);
  assert.equal(progressEl.style.width, '42%',
    'setProgress(0.42) must paint width: 42%');
  pm.setProgress(1.0);
  assert.equal(progressEl.style.width, '100%');
  pm.reset();
  assert.equal(progressEl.style.width, '0%');
  // setProgress called when no #progressBar -> safe no-op (no throw).
  setupDom({});
  const pm2 = new ProgressManager({ animationSpeed: 1.0 });
  pm2.setProgress(0.5);   // must not throw
}

// ---- ModalManager ----
{
  const modalEl = makeFakeElement('aboutModal');
  setupDom({ aboutModal: modalEl });
  const { ModalManager } = await import(path.join(ROOT, '../../packages/components/src/ui/ModalManager.js'));

  const mm = new ModalManager('aboutModal');
  assert.equal(mm.isOpen(), false, 'modal starts closed');
  mm.open();
  assert.equal(modalEl.classList.contains('active'), true);
  assert.equal(mm.isOpen(), true);
  mm.toggle();
  assert.equal(mm.isOpen(), false);
  mm.toggle();
  assert.equal(mm.isOpen(), true);
  mm.close();
  assert.equal(mm.isOpen(), false);

  // Overlay-click-to-close: synthesize the click handler we registered
  // and fire it with the modal as e.target.
  mm.open();
  const clickHandler = modalEl.listeners.click[0];
  assert.ok(clickHandler, 'overlay click handler must be registered');
  clickHandler({ target: modalEl });
  assert.equal(mm.isOpen(), false, 'clicking the overlay must close');
  // Click on a child inside the modal: target !== modal, must NOT close.
  mm.open();
  clickHandler({ target: { id: 'inside-modal' } });
  assert.equal(mm.isOpen(), true,
    'clicking inside the modal (not on the overlay) must NOT close');

  // Missing modal id: constructor + every method must no-op.
  setupDom({});
  const orphan = new ModalManager('madeup');
  orphan.open();
  orphan.close();
  orphan.toggle();
  assert.equal(orphan.isOpen(), false,
    'isOpen() must return false when modal does not exist');
}

console.log('ui-modules OK: ConsoleOutput (log/level/source/clear/copy fallback/custom/missing), ProgressManager (setProgress/reset/missing), ModalManager (open/close/toggle/overlay-click/missing).');
