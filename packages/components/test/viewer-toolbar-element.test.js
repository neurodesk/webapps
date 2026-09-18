import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createViewerToolbar, defineViewerToolbar } from '../src/elements/viewer-toolbar.js';
import { WindowControls } from '../src/ui/WindowControls.js';

test('toolbar imports in Node and registration is explicit and per-window', () => {
  assert.equal(globalThis.window, undefined);
  const first = new JSDOM();
  const second = new JSDOM();
  assert.equal(first.window.customElements.get('nd-viewer-toolbar'), undefined);
  const constructor = defineViewerToolbar(first.window);
  assert.equal(defineViewerToolbar(first.window), constructor);
  assert.notEqual(defineViewerToolbar(second.window), constructor);
  first.window.close();
  second.window.close();
});

test('toolbar upgrades declarative options and preserves controls and listeners on reconnect', (t) => {
  const { window } = new JSDOM('<nd-viewer-toolbar></nd-viewer-toolbar><aside></aside>');
  t.after(() => window.close());
  const element = window.document.querySelector('nd-viewer-toolbar');
  element.options = { views: [{ id: 'axial', label: 'Axial' }], window: false, download: false };
  defineViewerToolbar(window);
  assert.equal(element.control('windowMin'), null);
  assert.equal(element.control('downloadCurrentVolume'), null);
  const events = [];
  window.document.body.addEventListener('nd-view-change', (event) => events.push(event));
  const tab = element.querySelector('.nd-view-tab');
  const opacity = element.control('overlayOpacity');
  opacity.value = '0.8';
  element.remove();
  window.document.querySelector('aside').append(element);
  assert.equal(element.control('overlayOpacity'), opacity);
  assert.equal(opacity.value, '0.8');
  tab.click();
  assert.equal(events.length, 1);
  assert.equal(events[0].target, element);
  assert.equal(events[0].composed, true);
  assert.deepEqual(events[0].detail, { value: 'axial' });
  assert.equal(tab.getAttribute('aria-pressed'), 'true');
});

test('setActive initializes a detached declarative toolbar', (t) => {
  const { window } = new JSDOM();
  t.after(() => window.close());
  defineViewerToolbar(window);
  const element = window.document.createElement('nd-viewer-toolbar');
  element.setActive('axial');
  window.document.body.append(element);
  assert.deepEqual([...element.querySelectorAll('[aria-pressed="true"]')].map((tab) => tab.dataset.view), ['axial']);
  assert.equal(element.querySelectorAll('.nd-view-tabs').length, 1);
});

test('two toolbars have unique IDs and WindowControls updates only its own volume', (t) => {
  const { window } = new JSDOM();
  t.after(() => window.close());
  const first = createViewerToolbar({}, window.document);
  const second = createViewerToolbar({}, window.document);
  window.document.body.append(first, second);
  const ids = [...window.document.querySelectorAll('[id]')].map((element) => element.id);
  assert.equal(new Set(ids).size, ids.length);
  const firstVolume = { global_min: 0, global_max: 200, cal_min: 0, cal_max: 200 };
  const secondVolume = { global_min: 0, global_max: 100, cal_min: 10, cal_max: 90 };
  const updates = [];
  const firstControls = new WindowControls({ root: first, getVolume: () => firstVolume, updateVolume: () => updates.push('first') });
  const secondControls = new WindowControls({ root: second, getVolume: () => secondVolume, updateVolume: () => updates.push('second') });
  assert.equal(firstControls.bind(), true);
  assert.equal(secondControls.bind(), true);
  firstControls.sync();
  secondControls.sync();
  first.control('rangeMin').value = '25';
  first.control('rangeMin').dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(firstVolume.cal_min, 50);
  assert.equal(secondVolume.cal_min, 10);
  assert.equal(Number(second.control('windowMin').value), 10);
  assert.deepEqual(updates, ['first']);
  second.control('resetWindow').click();
  assert.equal(secondVolume.cal_min, 0);
  assert.equal(firstVolume.cal_min, 50);
  assert.deepEqual(updates, ['first', 'second']);
});

test('toolbar changes emit local values and update only their own presentation', (t) => {
  const { window } = new JSDOM();
  t.after(() => window.close());
  const first = createViewerToolbar({}, window.document);
  const second = createViewerToolbar({}, window.document);
  window.document.body.append(first, second);
  const events = [];
  for (const name of ['nd-overlay-change', 'nd-colormap-change', 'nd-window-change', 'nd-download', 'nd-screenshot']) {
    window.document.body.addEventListener(name, (event) => events.push(event));
  }
  first.control('overlayOpacity').value = '0.7';
  first.control('overlayOpacity').dispatchEvent(new window.Event('input', { bubbles: true }));
  first.control('colormapSelect').value = 'red';
  first.control('colormapSelect').dispatchEvent(new window.Event('change', { bubbles: true }));
  first.control('windowMin').value = '12';
  first.control('windowMin').dispatchEvent(new window.Event('change', { bubbles: true }));
  first.control('downloadCurrentVolume').disabled = false;
  first.control('downloadCurrentVolume').click();
  first.control('screenshotViewer').click();
  assert.equal(first.control('overlayOpacityValue').textContent, '70%');
  assert.equal(second.control('overlayOpacityValue').textContent, '50%');
  assert.deepEqual(events.slice(0, 3).map((event) => event.detail), [{ value: 0.7 }, { value: 'red' }, { control: 'windowMin', value: 12 }]);
  assert.equal(events.length, 5);
  assert.ok(events.every((event) => event.target === first && event.composed));
});

test('app-controlled views retain their active state when the viewer is not ready', (t) => {
  const { window } = new JSDOM();
  t.after(() => window.close());
  let ready = false;
  const toolbar = createViewerToolbar({ views: [
    { id: 'multiplanar', label: '3-Plane', active: true },
    { id: 'axial', label: 'Axial', onClick: () => {
      if (!ready) return;
      toolbar.setActive('axial');
    } },
  ] }, window.document);
  window.document.body.append(toolbar);
  const axial = toolbar.querySelector('[data-view="axial"]');
  axial.click();
  assert.equal(toolbar.querySelector('[aria-pressed="true"]').dataset.view, 'multiplanar');
  ready = true;
  axial.click();
  assert.equal(toolbar.querySelector('[aria-pressed="true"]').dataset.view, 'axial');
});
