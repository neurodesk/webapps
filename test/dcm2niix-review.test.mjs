import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createSeriesReview } from '../apps/dcm2niix/src/review.js';

function fixture(t) {
  const dom = new JSDOM('<table><tbody id="rows"></tbody></table><div id="editor"></div>');
  const previous = globalThis.document;
  globalThis.document = dom.window.document;
  t.after(() => {
    globalThis.document = previous;
    dom.window.close();
  });
  const item = { id: 'series1', description: 'DWI', type: 'dwi', volumes: 2, metadata: {}, targets: [], reviewed: true, bval: '0 1000', bvec: '0 1\n0 0\n0 0' };
  const review = createSeriesReview({ rows: document.querySelector('#rows'), editor: document.querySelector('#editor'), onChange: () => {} });
  review.render([item]);
  const select = (...files) => {
    const input = document.querySelector('input[type="file"]');
    Object.defineProperty(input, 'files', { configurable: true, value: files });
    input.dispatchEvent(new dom.window.Event('change'));
    return input;
  };
  return { item, review, select, dom };
}

function deferredFile() {
  let resolve;
  let reject;
  const text = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { file: { name: 'replacement.bval', text: () => text }, resolve, reject };
}

const settled = () => new Promise(resolve => setImmediate(resolve));

test('choosing gradients invalidates confirmation before reading and blocks reconfirmation', async t => {
  const { item, review, select, dom } = fixture(t);
  const pending = deferredFile();
  select(pending.file);
  assert.equal(item.reviewed, false);
  assert.equal(review.hasPendingEdits(), true);
  const check = document.querySelector('[data-review]');
  assert.equal(check.disabled, true);
  check.checked = true;
  check.dispatchEvent(new dom.window.Event('change'));
  assert.equal(check.checked, false);
  assert.equal(item.reviewed, false);
  assert.equal(item.bval, '0 1000');
  pending.resolve('0 2000');
  await settled();
  assert.equal(item.bval, '0 2000');
  assert.equal(item.reviewed, false);
  assert.equal(review.hasPendingEdits(), false);
  assert.equal(check.disabled, false);
});

test('a later gradient selection wins when the earlier read finishes last', async t => {
  const { item, review, select } = fixture(t);
  const earlier = deferredFile();
  const latest = deferredFile();
  select(earlier.file);
  select(latest.file);
  latest.resolve('0 3000');
  await settled();
  assert.equal(item.bval, '0 3000');
  earlier.resolve('0 2000');
  await settled();
  assert.equal(item.bval, '0 3000');
  assert.equal(item.bvec, '0 1\n0 0\n0 0');
  assert.equal(review.hasPendingEdits(), false);
});

test('a manual gradient edit supersedes an outstanding file read', async t => {
  const { item, review, select, dom } = fixture(t);
  const pending = deferredFile();
  select(pending.file);
  const text = document.querySelector('#series1-bval');
  text.value = '0 4000';
  text.dispatchEvent(new dom.window.Event('input'));
  pending.resolve('0 2000');
  await settled();
  assert.equal(item.bval, '0 4000');
  assert.equal(review.hasPendingEdits(), false);
});

test('replacing the examination discards outstanding gradient reads', async t => {
  const { item, review, select } = fixture(t);
  const pending = deferredFile();
  select(pending.file);
  review.render([]);
  pending.resolve('0 2000');
  await settled();
  assert.equal(item.bval, '0 1000');
  assert.equal(review.hasPendingEdits(), false);
  assert.equal(document.querySelector('#rows').children.length, 0);
});

test('a failed read preserves the previous pair and releases the pending edit', async t => {
  const { item, review, select } = fixture(t);
  const pending = deferredFile();
  pending.file.name = 'replacement.bvec';
  const input = select({ name: 'replacement.bval', text: async () => '0 2000' }, pending.file);
  await settled();
  assert.equal(item.bval, '0 1000');
  pending.reject(new Error('Read failed'));
  await settled();
  assert.equal(item.bval, '0 1000');
  assert.equal(item.bvec, '0 1\n0 0\n0 0');
  assert.equal(item.reviewed, false);
  assert.equal(review.hasPendingEdits(), false);
  assert.match(input.validationMessage, /read gradient/i);
});
