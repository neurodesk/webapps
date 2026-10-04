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

test('toggleable results can also offer an independent View action', () => {
  const { window } = new JSDOM();
  const calls = [];
  const result = { visible: false, viewable: true };
  const element = createResultList({ onView: (...args) => calls.push(args) }, window.document);
  element.render({ surface: result });
  element.querySelector('.nd-view-btn').click();
  assert.deepEqual(calls, [['surface', result]]);
  assert.equal(element.querySelector('input').checked, false);
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
  assert.deepEqual([...element.querySelectorAll('[data-stage]')].map(row => row.dataset.stage), ['second', 'first']);
  window.document.body.append(element);
  assert.deepEqual([...element.querySelectorAll('.nd-stage-label')].map((label) => label.textContent), ['<img src=x>', 'first']);
  assert.equal(element.querySelector('img'), null);
  window.close();
});

test('a result marked not viewable keeps its row but disables View', () => {
  const { window } = new JSDOM();
  const element = createResultList({}, window.document);
  window.document.body.append(element);
  element.render({ mask: { description: 'Lesion mask' }, table: { description: 'Lesion table', viewable: false } });
  const [mask, table] = element.querySelectorAll('.nd-view-btn');
  assert.equal(mask.disabled, false);
  assert.equal(table.disabled, true);
  assert.equal(table.title, 'Download to open');
  assert.equal(element.querySelectorAll('.nd-download-btn').length, 2);
  window.close();
});

test('re-rendering keeps the buttons of unchanged rows, so a click in progress still lands', () => {
  const { window } = new JSDOM();
  const downloads = [];
  const element = createResultList({ onDownload: (stage, result) => downloads.push([stage, result]) }, window.document);
  window.document.body.append(element);
  const first = { description: 'Table', viewable: false };
  element.render({ table: first, report: { description: 'Report' } });
  const button = element.querySelector('[data-stage="table"] .nd-download-btn');
  // An app re-renders on a field's change event, between pointerdown and click.
  const second = { description: 'Table', viewable: false };
  element.render({ table: second, report: { description: 'Report' } });
  assert.equal(element.querySelector('[data-stage="table"] .nd-download-btn'), button);
  button.click();
  assert.deepEqual(downloads, [['table', second]]);
  window.close();
});

test('re-rendering replaces changed rows, drops removed ones and follows the new order', () => {
  const { window } = new JSDOM();
  const element = createResultList({}, window.document);
  element.render({ a: { description: 'A' }, b: { description: 'B' }, c: { description: 'C' } });
  const rowB = element.querySelector('[data-stage="b"]');
  const rowA = element.querySelector('[data-stage="a"]');
  element.render({ c: { description: 'C' }, b: { description: 'B' }, a: { description: 'A, renamed' } });
  assert.deepEqual([...element.children].map((row) => row.dataset.stage), ['c', 'b', 'a']);
  assert.equal(element.querySelector('[data-stage="b"]'), rowB);
  assert.notEqual(element.querySelector('[data-stage="a"]'), rowA);
  assert.equal(element.querySelector('[data-stage="a"] .nd-stage-label').textContent, 'A, renamed');
  element.render({ b: { description: 'B', viewable: false } });
  assert.deepEqual([...element.children].map((row) => row.dataset.stage), ['b']);
  assert.notEqual(element.querySelector('[data-stage="b"]'), rowB);
  assert.equal(element.querySelector('.nd-view-btn').disabled, true);
  element.render({});
  assert.equal(element.textContent, 'No results yet');
  element.render({ b: { description: 'B' } });
  assert.equal(element.children.length, 1);
  window.close();
});

test('a kept checkbox row follows the new visibility', () => {
  const { window } = new JSDOM();
  const element = createResultList({}, window.document);
  element.render({ surface: { visible: true } });
  const checkbox = element.querySelector('input');
  element.render({ surface: { visible: false } });
  assert.equal(element.querySelector('input'), checkbox);
  assert.equal(checkbox.checked, false);
  window.close();
});

test('editable results offer Edit between the label and Download, and edited ones say so', () => {
  const { window } = new JSDOM();
  const edits = [];
  const list = createResultList({ onEdit: (stage, result) => edits.push([stage, result]) }, window.document);
  window.document.body.append(list);
  const mask = { description: 'Brain mask', editable: true };
  list.render({ input: { description: 'T1w' }, mask });
  assert.equal(list.querySelector('[data-stage="input"] .nd-edit-btn'), null);
  const row = list.querySelector('[data-stage="mask"]');
  assert.deepEqual([...row.children].map(child => child.className), ['nd-view-btn', 'nd-stage-label', 'nd-edit-btn', 'nd-download-btn']);
  const edit = row.querySelector('.nd-edit-btn');
  assert.deepEqual([edit.textContent, edit.title], ['Edit', 'Edit in the viewer']);
  edit.click();
  assert.deepEqual(edits, [['mask', mask]]);

  list.setEditingEnabled(false);
  assert.equal(edit.disabled, true);
  list.render({ input: { description: 'T1w' }, mask: { ...mask, edited: true } });
  const replaced = list.querySelector('[data-stage="mask"]');
  assert.notEqual(replaced, row, 'the edited flag changes the row');
  assert.equal(replaced.querySelector('.nd-stage-label').textContent, 'Brain mask (edited)');
  assert.equal(replaced.querySelector('.nd-edit-btn').disabled, true, 'a new row keeps editing disabled');
  list.setEditingEnabled(true);
  assert.equal(replaced.querySelector('.nd-edit-btn').disabled, false);
  window.close();
});
