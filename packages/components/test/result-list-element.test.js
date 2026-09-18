import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createResultList, defineResultList } from '../src/elements/result-list.js';

test('result list registers explicitly and upgrades preconfigured declarative markup', () => {
  const { window } = new JSDOM('<nd-result-list></nd-result-list>');
  const element = window.document.querySelector('nd-result-list');
  element.stageLabels = { surface: 'Left pial surface' };
  const constructor = defineResultList(window);
  assert.equal(defineResultList(window), constructor);
  assert.equal(element.textContent, 'No results yet');
  element.render({ surface: { visible: true } });
  assert.equal(element.querySelector('input').getAttribute('aria-label'), 'Show Left pial surface');
  window.close();
});

test('result actions bubble with stage and result from independent instances', () => {
  const { window } = new JSDOM();
  const first = createResultList({}, window.document);
  const second = createResultList({}, window.document);
  window.document.body.append(first, second);
  const result = { description: 'Brain mask' };
  first.render({ mask: result });
  second.render({ image: {} });
  const events = [];
  for (const name of ['nd-view', 'nd-download']) {
    window.document.body.addEventListener(name, (event) => events.push(event));
  }
  first.querySelector('.nd-view-btn').click();
  first.querySelector('.nd-download-btn').click();
  assert.equal(events.length, 2);
  for (const event of events) {
    assert.equal(event.target, first);
    assert.equal(event.composed, true);
    assert.deepEqual(event.detail, { stage: 'mask', result });
  }
  assert.equal(second.querySelector('.nd-stage-label').textContent, 'image');
  window.close();
});

test('checkbox state and listeners survive detach, reconnect and moving the element', () => {
  const { window } = new JSDOM('<main></main><aside></aside>');
  const changes = [];
  const result = { visible: true };
  const element = createResultList({ onVisibilityChange: (...args) => changes.push(args) }, window.document);
  window.document.querySelector('main').append(element);
  element.render({ surface: result });
  const checkbox = element.querySelector('input');
  checkbox.click();
  element.remove();
  window.document.querySelector('aside').append(element);
  assert.equal(element.querySelector('input'), checkbox);
  assert.equal(checkbox.checked, false);
  checkbox.click();
  assert.deepEqual(changes, [
    ['surface', false, result, checkbox],
    ['surface', true, result, checkbox],
  ]);
  window.close();
});

test('factory migrates placeholders in place and preserves callbacks and attributes', () => {
  const { window } = new JSDOM('<main><div id="results" class="custom" aria-label="Outputs"></div><p>After</p></main>');
  const calls = [];
  const result = { description: 'Result' };
  const element = createResultList({
    element: 'results',
    onView: (...args) => calls.push(['view', ...args]),
    onDownload: (...args) => calls.push(['download', ...args]),
  }, window.document);
  assert.equal(element.localName, 'nd-result-list');
  assert.equal(element, window.document.querySelector('main').firstElementChild);
  assert.equal(element.id, 'results');
  assert.equal(element.className, 'custom');
  assert.equal(element.getAttribute('aria-label'), 'Outputs');
  element.render({ output: result });
  element.querySelector('.nd-view-btn').click();
  element.querySelector('.nd-download-btn').click();
  assert.deepEqual(calls, [['view', 'output', result], ['download', 'output', result]]);
  element.render();
  assert.equal(element.textContent, 'No results yet');
  assert.equal(element.querySelector('button'), null);
  window.close();
});

test('render keeps explicit ordering and treats labels as plain text', () => {
  const { window } = new JSDOM();
  const element = createResultList({ stageLabels: { second: '<img src=x>' } }, window.document);
  element.render({ first: {}, second: {} }, ['second', 'first']);
  window.document.body.append(element);
  assert.deepEqual([...element.querySelectorAll('.nd-stage-label')].map((label) => label.textContent), ['<img src=x>', 'first']);
  assert.equal(element.querySelector('img'), null);
  window.close();
});
