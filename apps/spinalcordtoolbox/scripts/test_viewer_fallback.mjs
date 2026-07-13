#!/usr/bin/env node
/**
 * Behavioral coverage for the non-WebGL2 viewer fallback.
 *
 * The app relies on NiiVue's `attachTo('gl1')` rejecting when WebGL2 is
 * unavailable (and, defensively, on a missing GL context after a resolved
 * attach). When that happens, setupViewer() must engage disableViewer(): mark
 * the viewer unavailable, null ViewerController.nv so nothing else touches
 * NiiVue, arm the 2D fallback preview, disable viewer-only controls, and show
 * an actionable message. Previously this catch path was only grep-asserted in
 * test_ui_coverage.cjs; this test actually executes it.
 */

import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Minimal fake DOM covering exactly what setupViewer/disableViewer touch.
// ---------------------------------------------------------------------------
class FakeClassList {
  constructor() { this.set = new Set(); }
  add(c) { this.set.add(c); }
  remove(c) { this.set.delete(c); }
  contains(c) { return this.set.has(c); }
  toggle(c, force) {
    const want = force === undefined ? !this.set.has(c) : !!force;
    if (want) this.set.add(c); else this.set.delete(c);
    return want;
  }
}

function makeEl() {
  return {
    hidden: false,
    textContent: '',
    title: '',
    disabled: false,
    classList: new FakeClassList(),
    style: {},
  };
}

const messageEl = makeEl();
const primaryEl = makeEl();
const labelEl = makeEl();
const elements = {
  viewerUnavailableMessage: messageEl,
  viewerInfoPrimary: primaryEl,
  viewerInfoLabel: labelEl,
};
const toolbarControls = [makeEl(), makeEl(), makeEl()];

globalThis.document = {
  body: { classList: new FakeClassList() },
  getElementById: (id) => elements[id] || null,
  querySelectorAll: (sel) => (/viewer-toolbar/.test(sel) ? toolbarControls : []),
  createElement: () => makeEl(),
  addEventListener: () => {},
};
globalThis.window = { addEventListener: () => {}, devicePixelRatio: 1 };
globalThis.self = globalThis;
globalThis.performance = globalThis.performance || { now: () => 0 };
globalThis.requestAnimationFrame = globalThis.requestAnimationFrame || (() => 1);
globalThis.cancelAnimationFrame = globalThis.cancelAnimationFrame || (() => {});

// Dynamic import AFTER globals exist so the app module's top-level code (and its
// imports) can reference document/window safely.
const { SpinalCordToolboxApp } = await import('../web/js/spinalcordtoolbox-app.js');
assert.ok(SpinalCordToolboxApp, 'SpinalCordToolboxApp is exported for testing');

// ---------------------------------------------------------------------------
// Build a real-prototype instance without running the heavy constructor/init.
// Internal method calls (disableViewer, setViewerUnavailableMessage, etc.)
// dispatch to the real implementations under test.
// ---------------------------------------------------------------------------
function makeApp(nv) {
  const app = Object.create(SpinalCordToolboxApp.prototype);
  app.nv = nv;
  app.viewerController = { nv: {}, isAvailable() { return !!this.nv; } };
  app.fallbackPreview = {
    setUnavailableCalls: [],
    setUnavailable(reason) { this.setUnavailableCalls.push(reason); },
    isSupported() { return true; },
  };
  app.viewerAvailable = false;
  app.viewerUnavailableReason = '';
  app.outputs = [];
  app.updateOutput = (msg) => app.outputs.push(msg);
  return app;
}

function makeNv({ gl = {}, attach = () => Promise.resolve() } = {}) {
  return {
    gl,
    sliceTypeMultiplanar: 0,
    attachTo: attach,
    setMultiplanarPadPixels() {},
    setSliceType() {},
    setInterpolation() {},
    drawScene() {},
  };
}

function resetDom() {
  messageEl.hidden = false; messageEl.textContent = ''; messageEl.title = '';
  primaryEl.textContent = ''; labelEl.textContent = '';
  toolbarControls.forEach((c) => { c.disabled = false; });
  globalThis.document.body.classList = new FakeClassList();
}

// ---------------------------------------------------------------------------
// Case A: WebGL2 available — viewer initializes normally.
// ---------------------------------------------------------------------------
{
  resetDom();
  const app = makeApp(makeNv({ gl: { context: true } }));
  const ok = await app.setupViewer();
  assert.equal(ok, true, 'A: setupViewer resolves true when a GL context is created');
  assert.equal(app.viewerAvailable, true, 'A: viewerAvailable true on success');
  assert.equal(app.isViewerAvailable(), true, 'A: isViewerAvailable true on success');
  assert.equal(messageEl.hidden, true, 'A: unavailable message hidden on success');
  assert.ok(toolbarControls.every((c) => c.disabled === false), 'A: viewer controls enabled on success');
  assert.ok(!document.body.classList.contains('viewer-unavailable'), 'A: body not marked viewer-unavailable');
}

// ---------------------------------------------------------------------------
// Case B: attachTo() rejects (the real WebGL2-unavailable path) — graceful 2D
// fallback with an actionable message; app stays usable.
// ---------------------------------------------------------------------------
{
  resetDom();
  const reason = 'Unable to initialize WebGL2. Your browser may not support it.';
  const app = makeApp(makeNv({ attach: () => Promise.reject(new Error(reason)) }));
  const ok = await app.setupViewer();
  assert.equal(ok, false, 'B: setupViewer resolves false when attachTo rejects');
  assert.equal(app.viewerAvailable, false, 'B: viewerAvailable false after attach failure');
  assert.equal(app.isViewerAvailable(), false, 'B: isViewerAvailable false after attach failure');
  assert.equal(app.viewerController.nv, null, 'B: ViewerController.nv nulled so nothing else touches NiiVue');
  assert.deepEqual(app.fallbackPreview.setUnavailableCalls, [reason], 'B: 2D fallback armed with the failure reason');
  assert.equal(messageEl.hidden, false, 'B: unavailable message shown');
  assert.equal(messageEl.title, reason, 'B: raw WebGL2 reason preserved in the title');
  assert.match(messageEl.textContent, /WebGL2/, 'B: message names WebGL2 as the cause');
  assert.match(messageEl.textContent, /hardware acceleration/i, 'B: message gives the hardware-acceleration remedy');
  assert.ok(toolbarControls.every((c) => c.disabled === true), 'B: viewer-only controls disabled in fallback');
  assert.ok(app.outputs.some((m) => /Image preview unavailable/.test(m)), 'B: reason surfaced to the console output');
  assert.ok(document.body.classList.contains('viewer-unavailable'), 'B: body marked viewer-unavailable');
}

// ---------------------------------------------------------------------------
// Case C: attachTo() resolves but no GL context (future-proofing against a
// niivue that logs-and-returns instead of throwing).
// ---------------------------------------------------------------------------
{
  resetDom();
  const app = makeApp(makeNv({ gl: null, attach: () => Promise.resolve() }));
  const ok = await app.setupViewer();
  assert.equal(ok, false, 'C: setupViewer resolves false when attach resolves without a GL context');
  assert.equal(app.viewerAvailable, false, 'C: viewerAvailable false when GL context missing');
  assert.equal(app.viewerController.nv, null, 'C: fallback engaged when GL context missing');
  assert.match(messageEl.textContent, /WebGL2/, 'C: actionable message shown for missing GL context');
}

// ---------------------------------------------------------------------------
// Guard: the actionable guidance string itself names cause and remedy.
// ---------------------------------------------------------------------------
{
  const guidance = SpinalCordToolboxApp.VIEWER_UNAVAILABLE_GUIDANCE;
  assert.match(guidance, /WebGL2/, 'guidance names WebGL2');
  assert.match(guidance, /hardware acceleration/i, 'guidance names the hardware-acceleration remedy');
  assert.match(guidance, /chrome:\/\/gpu/, 'guidance points at chrome://gpu for diagnosis');
}

console.log('Viewer fallback behavioral tests passed');
