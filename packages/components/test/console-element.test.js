import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { JSDOM } from 'jsdom';
import { createConsole, defineConsole } from '../src/elements/console.js';

test('console imports without a browser and registers separately in each document', () => {
  assert.equal(globalThis.window, undefined);
  const first = new JSDOM();
  const second = new JSDOM();
  assert.equal(first.window.customElements.get('nd-console'), undefined);
  const constructor = defineConsole(first.window);
  assert.equal(defineConsole(first.window), constructor);
  assert.notEqual(defineConsole(second.window), constructor);
  first.window.close();
  second.window.close();
});

test('declarative console upgrades properties and keeps accessible disclosure state', async (t) => {
  const { window } = new JSDOM('<nd-console label="Worker log" max-lines="2"></nd-console>');
  t.after(() => window.close());
  const element = window.document.querySelector('nd-console');
  element.collapsed = true;
  defineConsole(window);
  const toggle = element.querySelector('[data-disclosure-toggle]');
  assert.equal(toggle.textContent, 'Worker log');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(toggle.getAttribute('aria-controls'), element.output.id);
  assert.equal(element.output.hidden, true);
  element.log('one');
  element.log('two');
  element.log('three');
  assert.equal(element.output.children.length, 2);
  element.log('Failure', 'error');
  await setImmediate();
  assert.equal(element.collapsed, false);
  assert.equal(element.output.hidden, false);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  element.setAttribute('label', 'Updated log');
  assert.equal(toggle.textContent, 'Updated log');
  element.close();
  await setImmediate();
  assert.equal(element.output.hidden, true);
  assert.equal(element.output.inert, true);
});

test('two consoles keep IDs, contents and clear actions independent', (t) => {
  const { window } = new JSDOM();
  t.after(() => window.close());
  const first = createConsole({}, window.document);
  const second = createConsole({}, window.document);
  window.document.body.append(first, second);
  const ids = [...window.document.querySelectorAll('[id]')].map((element) => element.id);
  assert.equal(new Set(ids).size, ids.length);
  first.log('First');
  second.log('Second');
  [...first.querySelectorAll('button')].find((button) => button.textContent === 'Clear').click();
  assert.equal(first.getText(), '');
  assert.match(second.getText(), /Second/);
});

test('console releases disclosure listeners and observers, then reconnects once', async (t) => {
  const { window } = new JSDOM('<main></main><aside></aside>');
  t.after(() => window.close());
  const element = createConsole({}, window.document);
  window.document.querySelector('main').append(element);
  element.log('Preserved');
  const output = element.output;
  const toggle = element.querySelector('[data-disclosure-toggle]');
  element.remove();
  await setImmediate();
  toggle.click();
  assert.equal(element.classList.contains('collapsed'), true);
  element.classList.remove('collapsed');
  await setImmediate();
  assert.equal(element.collapsed, true, 'detached observer does not mirror classes');
  assert.equal(output.hidden, true, 'detached disclosure observer does not alter panel');
  window.document.querySelector('aside').append(element);
  assert.equal(element.collapsed, false);
  assert.equal(output.hidden, false);
  assert.equal(element.output, output);
  assert.match(element.getText(), /Preserved/);
  window.document.querySelector('main').append(element);
  toggle.click();
  await setImmediate();
  assert.equal(element.collapsed, true, 'one click invokes one toggle after moving');
  assert.equal(output.hidden, true);
});

test('console reconciles errors logged through ConsoleOutput while disconnected', async (t) => {
  const { window } = new JSDOM();
  t.after(() => window.close());
  const element = createConsole({}, window.document);
  window.document.body.append(element);
  element.remove();
  await setImmediate();
  element.console.log('Offline error', 'error');
  window.document.body.append(element);
  assert.equal(element.collapsed, false);
  assert.equal(element.output.hidden, false);
  assert.equal(element.querySelector('[data-disclosure-toggle]').getAttribute('aria-expanded'), 'true');
});

test('copy feedback follows the latest request and ignores results after disconnect', async (t) => {
  const { window } = new JSDOM();
  t.after(() => window.close());
  const pending = [];
  Object.defineProperty(window.navigator, 'clipboard', {
    value: { writeText: (text) => new Promise((resolve, reject) => pending.push({ text, resolve, reject })) },
  });
  const element = createConsole({}, window.document);
  window.document.body.append(element);
  element.log('Copied text');
  const button = element.querySelector('[data-console-copy]');
  button.click();
  button.click();
  assert.match(pending[0].text, /Copied text/);
  pending[1].reject(new Error('Clipboard unavailable'));
  await setImmediate();
  assert.equal(button.textContent, 'Copy failed');
  pending[0].resolve();
  await setImmediate();
  assert.equal(button.textContent, 'Copy failed', 'stale success cannot overwrite the latest failure');
  button.click();
  element.remove();
  await setImmediate();
  window.document.body.append(element);
  pending[2].resolve();
  await setImmediate();
  assert.equal(button.textContent, 'Copy');
});

function layout(element, height) {
  element.getBoundingClientRect = () => ({ height: height() });
}

test('resizable console grows by drag and keyboard, keeps the viewer visible and survives collapse', async (t) => {
  const { window } = new JSDOM('<main><div id="canvas"></div></main>');
  t.after(() => window.close());
  const element = createConsole({ id: 'log', resizable: true }, window.document);
  window.document.querySelector('main').append(element);
  const stored = () => element.style.getPropertyValue('--nd-console-height');
  // The column is 600px: the canvas takes whatever the console does not.
  layout(element, () => parseFloat(stored()) || 120);
  layout(window.document.getElementById('canvas'), () => 600 - (parseFloat(stored()) || 120));
  const handle = element.firstElementChild;
  assert.equal(handle.className, 'nd-console-resizer');
  assert.equal(handle.getAttribute('role'), 'separator');
  assert.equal(handle.getAttribute('aria-orientation'), 'horizontal');
  assert.equal(handle.tabIndex, 0);
  assert.equal(handle.getAttribute('aria-controls'), element.output.id);
  assert.ok(element.hasAttribute('data-console-resizable'));
  const events = [];
  window.document.addEventListener('nd-console-resize', (event) => events.push(event.detail.height));
  const key = (name) => handle.dispatchEvent(new window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));

  element.open();
  key('ArrowUp');
  assert.equal(stored(), '144px');
  assert.equal(handle.getAttribute('aria-valuenow'), '144');
  key('PageUp');
  assert.equal(stored(), '240px');
  key('End');
  assert.equal(stored(), '440px', 'the viewer keeps 160px');
  assert.equal(handle.getAttribute('aria-valuemax'), '440');
  key('ArrowUp');
  assert.equal(stored(), '440px');
  key('Home');
  assert.equal(stored(), '120px');
  key('ArrowDown');
  assert.equal(stored(), '120px', 'never smaller than the default');
  key('Tab');
  assert.deepEqual(events, [144, 240, 440, 120]);

  const pointer = (type, clientY) => {
    const event = new window.Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { clientY, pointerId: 1, button: 0 });
    handle.dispatchEvent(event);
  };
  pointer('pointerdown', 400);
  pointer('pointermove', 300);
  assert.equal(stored(), '220px', 'dragging up enlarges');
  pointer('pointermove', 0);
  assert.equal(stored(), '440px');
  pointer('pointermove', 320);
  pointer('pointerup', 320);
  assert.equal(stored(), '200px');
  pointer('pointermove', 100);
  assert.equal(stored(), '200px', 'moves after release are ignored');

  element.close();
  await setImmediate();
  assert.equal(element.output.hidden, true);
  element.open();
  await setImmediate();
  assert.equal(stored(), '200px', 'size survives collapse and reopen');

  handle.dispatchEvent(new window.Event('dblclick'));
  assert.equal(stored(), '');
  element.resizable = false;
  assert.equal(element.querySelector('.nd-console-resizer'), null);
  assert.equal(element.hasAttribute('data-console-resizable'), false);
});

test('declarative resizable attribute binds the separator; plain consoles have none', (t) => {
  const { window } = new JSDOM('<nd-console id="a" collapsed resizable></nd-console><nd-console id="b" collapsed></nd-console>');
  t.after(() => window.close());
  defineConsole(window);
  assert.ok(window.document.querySelector('#a > .nd-console-resizer'));
  assert.equal(window.document.querySelector('#b > .nd-console-resizer'), null);
});

test('channels give one console two logs with tabs, independent Copy and Clear', async (t) => {
  const { window } = new JSDOM();
  t.after(() => window.close());
  const copied = [];
  Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async (text) => { copied.push(text); } } });
  const element = createConsole({
    id: 'log',
    channels: [{ id: 'analysis', label: 'Analysis' }, { id: 'technical', label: 'Technical' }],
  }, window.document);
  window.document.body.append(element);
  const toggle = element.querySelector('[data-disclosure-toggle]');
  const panel = element.querySelector('[data-disclosure-panel]');
  const tabs = [...element.querySelectorAll('[role="tab"]')];
  assert.equal(toggle.textContent, 'Log');
  assert.equal(panel.className, 'nd-console-panels');
  assert.equal(toggle.getAttribute('aria-controls'), panel.id);
  assert.equal(element.querySelector('[role="tablist"]').className, 'nd-console-tabs');
  assert.deepEqual(
    tabs.map((tab) => [tab.textContent, tab.getAttribute('aria-selected'), tab.tabIndex]),
    [['Analysis', 'true', 0], ['Technical', 'false', -1]],
  );
  assert.deepEqual(element.channels, ['analysis', 'technical']);
  assert.equal(element.activeChannel, 'analysis');
  for (const tab of tabs) {
    assert.equal(window.document.getElementById(tab.getAttribute('aria-controls')).getAttribute('role'), 'tabpanel');
  }
  assert.equal(panel.hidden, true, 'starts collapsed');

  element.log('Task: spinal cord', 'info', 'analysis');
  element.log('Session created', 'info', 'technical');
  element.log('Defaults to the first channel');
  assert.match(element.getText('analysis'), /Task: spinal cord[\s\S]*Defaults to the first channel/);
  assert.doesNotMatch(element.getText('analysis'), /Session created/);
  assert.match(element.getText('technical'), /Session created$/);
  assert.throws(() => element.log('x', 'info', 'missing'), /Unknown console channel/);

  const changes = [];
  element.addEventListener('nd-console-channel', (event) => changes.push(event.detail.channel));
  tabs[1].click();
  await setImmediate();
  assert.equal(element.collapsed, false, 'choosing a tab opens the log');
  assert.equal(panel.hidden, false);
  assert.equal(element.activeChannel, 'technical');
  assert.equal(element.console, element.channel('technical'));
  assert.equal(element.output.hidden, false);
  assert.equal(window.document.getElementById('logOutput-analysis').hidden, true);
  assert.deepEqual(changes, ['technical']);

  element.querySelector('[data-console-copy]').click();
  await setImmediate();
  assert.equal(copied.length, 1);
  assert.match(copied[0], /Session created/);
  assert.doesNotMatch(copied[0], /Task: spinal cord/);
  element.querySelector('#logClear').click();
  assert.equal(element.getText('technical'), '');
  assert.match(element.getText('analysis'), /Task: spinal cord/, 'Clear leaves the other log alone');

  tabs[1].dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
  assert.equal(element.activeChannel, 'analysis');
  assert.equal(window.document.activeElement, tabs[0]);
  tabs[0].dispatchEvent(new window.KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
  assert.equal(element.activeChannel, 'technical');

  element.selectChannel('analysis');
  toggle.click();
  await setImmediate();
  assert.equal(panel.hidden, true);
  element.log('Model fetch failed', 'error', 'technical');
  await setImmediate();
  assert.equal(element.collapsed, false, 'an error reopens the log');
  assert.equal(element.activeChannel, 'technical', 'on the channel that holds it');
  assert.match(element.getText('analysis'), /Task: spinal cord/, 'entries survive collapse and reopen');
});

test('declarative channels attribute builds labelled tabs', (t) => {
  const { window } = new JSDOM('<nd-console id="log" collapsed channels="analysis:Analysis,technical"></nd-console>');
  t.after(() => window.close());
  defineConsole(window);
  const element = window.document.getElementById('log');
  assert.deepEqual([...element.querySelectorAll('.nd-console-tab')].map((tab) => tab.textContent), ['Analysis', 'Technical']);
  assert.deepEqual(
    [...element.querySelectorAll('.nd-console-output')].map((output) => output.id),
    ['logOutput-analysis', 'logOutput-technical'],
  );
});
