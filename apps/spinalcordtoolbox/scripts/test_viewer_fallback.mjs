#!/usr/bin/env node
/**
 * Behavioral coverage for the non-WebGL2 viewer fallback.
 *
 * The app mounts FreeBrowse through SctViewer.mount(), which rejects when the
 * NiiVue canvas cannot be attached (WebGL2 unavailable), when NiiVue resolves
 * without a rendering backend, or when the viewer bundle cannot be loaded.
 * When that happens, setupViewer() must engage disableViewer(): mark the
 * viewer unavailable, drop the viewer/NiiVue references so nothing else
 * touches them, hide the FreeBrowse host, arm the 2D fallback preview, disable
 * viewer-only controls, and show an actionable message. This test executes
 * that path against the real SctViewer with a fake viewer module.
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
const embedEl = makeEl();
const elements = {
  freebrowseViewer: embedEl,
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
function makeApp(module) {
  const app = Object.create(SpinalCordToolboxApp.prototype);
  app.viewer = null;
  app.viewerMount = null;
  app.nv = null;
  app.loadViewerModule = typeof module === 'function' ? module : async () => module;
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

// A stand-in for the generated FreeBrowse viewer bundle.
function makeModule({ backend = 'webgl2', attach = (nv) => Promise.resolve(nv) } = {}) {
  const module = {
    mounts: [],
    SHOW_RENDER: { NEVER: 0 },
    mountViewer(element, options, embed) {
      const nv = { backend, volumes: [], addEventListener() {}, drawScene() {} };
      const handle = { nv, ready: attach(nv), destroyed: false, destroy() { this.destroyed = true; } };
      module.mounts.push({ element, options, embed, handle });
      return handle;
    },
  };
  return module;
}

function resetDom() {
  messageEl.hidden = false; messageEl.textContent = ''; messageEl.title = '';
  embedEl.hidden = false;
  primaryEl.textContent = ''; labelEl.textContent = '';
  toolbarControls.forEach((c) => { c.disabled = false; });
  globalThis.document.body.classList = new FakeClassList();
}

// ---------------------------------------------------------------------------
// Case A: WebGL2 available — FreeBrowse mounts and the app exposes it.
// ---------------------------------------------------------------------------
{
  resetDom();
  const module = makeModule();
  const app = makeApp(module);
  const ok = await app.setupViewer();
  assert.equal(ok, true, 'A: setupViewer resolves true when the canvas attaches');
  assert.equal(module.mounts[0].element, embedEl, 'A: FreeBrowse mounts into #freebrowseViewer');
  assert.equal(module.mounts[0].options.backend, 'webgl2', 'A: the WebGL2 renderer is requested');
  assert.equal(module.mounts[0].options.isDragDropEnabled, false, 'A: canvas drops are off; the Input section loads files');
  assert.equal(app.viewerAvailable, true, 'A: viewerAvailable true on success');
  assert.equal(app.isViewerAvailable(), true, 'A: isViewerAvailable true on success');
  assert.equal(app.nv, module.mounts[0].handle.nv, 'A: the NiiVue instance is exposed as app.nv');
  assert.equal(app.viewerMount, module.mounts[0].handle, 'A: the mount handle is exposed as app.viewerMount');
  assert.equal(app.viewer.nv, app.nv, 'A: app.viewer owns the same instance');
  assert.equal(messageEl.hidden, true, 'A: unavailable message hidden on success');
  assert.equal(embedEl.hidden, false, 'A: FreeBrowse host visible on success');
  assert.ok(toolbarControls.every((c) => c.disabled === false), 'A: viewer controls enabled on success');
  assert.ok(!document.body.classList.contains('viewer-unavailable'), 'A: body not marked viewer-unavailable');
  assert.match(primaryEl.textContent, /zoom/i, 'A: the zoom/pan hint is shown until a crosshair readout replaces it');
  assert.match(primaryEl.textContent, /reset/i, 'A: the hint names the reset control');
  assert.ok(SpinalCordToolboxApp.VIEWER_HINT.length <= 90, 'A: the visible hint stays within 90 characters');
}

// ---------------------------------------------------------------------------
// Case B: the canvas attachment rejects (the real WebGL2-unavailable path) —
// graceful 2D fallback with an actionable message; app stays usable.
// ---------------------------------------------------------------------------
{
  resetDom();
  const reason = 'Unable to initialize WebGL2. Your browser may not support it.';
  const module = makeModule({ attach: () => Promise.reject(new Error(reason)) });
  const app = makeApp(module);
  const ok = await app.setupViewer();
  assert.equal(ok, false, 'B: setupViewer resolves false when the attachment rejects');
  assert.equal(app.viewerAvailable, false, 'B: viewerAvailable false after attach failure');
  assert.equal(app.isViewerAvailable(), false, 'B: isViewerAvailable false after attach failure');
  assert.equal(app.viewer, null, 'B: viewer dropped so nothing else touches NiiVue');
  assert.equal(app.nv, null, 'B: app.nv is null in fallback mode');
  assert.equal(app.viewerMount, null, 'B: app.viewerMount is null in fallback mode');
  assert.equal(module.mounts[0].handle.destroyed, true, 'B: the failed FreeBrowse mount is released');
  assert.equal(embedEl.hidden, true, 'B: the FreeBrowse host is hidden so the 2D canvas shows');
  assert.deepEqual(app.fallbackPreview.setUnavailableCalls, [reason], 'B: 2D fallback armed with the failure reason');
  assert.equal(messageEl.hidden, false, 'B: unavailable message shown');
  assert.equal(messageEl.title, reason, 'B: raw WebGL2 reason preserved in the title');
  assert.match(messageEl.textContent, /WebGL2/, 'B: message names WebGL2 as the cause');
  assert.match(messageEl.textContent, /hardware acceleration/i, 'B: message gives the hardware-acceleration remedy');
  assert.ok(toolbarControls.every((c) => c.disabled === true), 'B: viewer-only controls disabled in fallback');
  assert.ok(app.outputs.some((m) => /Image preview unavailable/.test(m)), 'B: reason surfaced to the console output');
  assert.ok(document.body.classList.contains('viewer-unavailable'), 'B: body marked viewer-unavailable');
  assert.equal(primaryEl.textContent, 'Image preview unavailable', 'B: the zoom hint is not shown without a viewer');
}

// ---------------------------------------------------------------------------
// Case C: the attachment resolves but NiiVue has no rendering backend
// (future-proofing against a NiiVue that logs-and-returns instead of throwing).
// ---------------------------------------------------------------------------
{
  resetDom();
  const app = makeApp(makeModule({ backend: null }));
  const ok = await app.setupViewer();
  assert.equal(ok, false, 'C: setupViewer resolves false when no backend was created');
  assert.equal(app.viewerAvailable, false, 'C: viewerAvailable false when the backend is missing');
  assert.equal(app.viewer, null, 'C: fallback engaged when the backend is missing');
  assert.match(messageEl.textContent, /WebGL2/, 'C: actionable message shown for a missing backend');
}

// ---------------------------------------------------------------------------
// Case D: the viewer bundle itself cannot be loaded (offline cache miss,
// blocked script). The app still starts and falls back.
// ---------------------------------------------------------------------------
{
  resetDom();
  const app = makeApp(async () => { throw new Error('Failed to fetch dynamically imported module'); });
  const ok = await app.setupViewer();
  assert.equal(ok, false, 'D: setupViewer resolves false when the bundle fails to load');
  assert.equal(app.isViewerAvailable(), false, 'D: viewer unavailable');
  assert.deepEqual(app.fallbackPreview.setUnavailableCalls, ['Failed to fetch dynamically imported module'], 'D: 2D fallback armed');
  assert.equal(embedEl.hidden, true, 'D: FreeBrowse host hidden');
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
