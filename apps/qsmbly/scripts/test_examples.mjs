import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../js/qsm-app-romeo.js', import.meta.url), 'utf8');
const body = source.split('  async setupExamples() {')[1].split('\n  setupEventListeners() {')[0];
const setup = new Function('createExampleSelector', 'fetch', 'document', `return async function() {${body}`) ;
const examples = JSON.parse(await readFile(new URL('../examples.json', import.meta.url), 'utf8'));

async function loadAdapter() {
  let options;
  const loaded = [];
  const app = { updateOutput() {}, fileIOController: { clearAllFiles() {} }, async _handleUnifiedFiles(files) { loaded.push(...files); } };
  const selector = {};
  const scope = {};
  const input = { closest: () => ({ prepend(element) { assert.equal(element, selector); } }), classList: { remove() {} } };
  const document = { baseURI: 'https://example.org/qsmbly/', getElementById: () => input, querySelector: selector => { assert.equal(selector, '.app-container'); return scope; } };
  await setup(value => { options = value; assert.equal(value.scope, scope); return selector; },
    async () => ({ ok: true, json: async () => examples }), document).call(app);
  return { app, options, loaded };
}

test('selecting the example imports its complete scientific inputs without running processing', async () => {
  const { options, loaded } = await loadAdapter();
  const files = examples[0].files.map(file => new File(['example'], file.name));
  await options.onLoad(examples[0], { fetchFiles: async () => files, assertCurrent() {} });
  assert.equal(loaded.length, 4);
  assert.deepEqual(loaded.map(file => file.name), examples[0].files.map(file => file.name));
});

test('cancelled download never replaces the current inputs', async () => {
  const { options, loaded } = await loadAdapter();
  await assert.rejects(options.onLoad(examples[0], {
    fetchFiles: async () => [],
    assertCurrent() { throw new DOMException('Cancelled', 'AbortError'); },
  }), { name: 'AbortError' });
  assert.deepEqual(loaded, []);
});

test('failed download leaves inputs untouched and can be retried', async () => {
  const { options, loaded } = await loadAdapter();
  await assert.rejects(options.onLoad(examples[0], {
    fetchFiles: async () => { throw new Error('Download failed'); }, assertCurrent() {},
  }), /Download failed/);
  assert.deepEqual(loaded, []);
  const files = examples[0].files.map(file => new File(['example'], file.name));
  await options.onLoad(examples[0], { fetchFiles: async () => files, assertCurrent() {} });
  assert.equal(loaded.length, 4);
});
