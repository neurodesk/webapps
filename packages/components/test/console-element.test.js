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
