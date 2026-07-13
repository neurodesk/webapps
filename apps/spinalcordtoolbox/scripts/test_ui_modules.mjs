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

console.log('UI module tests passed');
