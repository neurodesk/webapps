import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const examples = JSON.parse(await readFile(new URL('../../examples.json', import.meta.url)));
const source = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
const setupBody = source.split('async function setupExamples() {')[1].split('\nvoid setupExamples()')[0];
const makeSetup = new Function('renderExampleSelector', 'fetch', 'document', '$', 'running', 'state', 'setAppMode', 'addFiles', 'refreshRunState', 'log', `return async function() {${setupBody}`);

test('the synthetic example loads its complete bundle and matched acquisition parameters', async () => {
  let options;
  const state = { files: [], jsons: [] };
  const fields = new Map();
  const $ = id => {
    if (!fields.has(id)) fields.set(id, { value: '', before() {} });
    return fields.get(id);
  };
  $('#taskSel').value = 'b1only';
  const setup = makeSetup(value => { options = value; return { root: {} }; },
    async () => ({ ok: true, json: async () => examples }), { baseURI: 'https://example.org/easy-mp2rage/' },
    $, false, state, () => {}, async files => { state.files.push(...files); }, () => {}, () => {});
  await setup();
  const files = examples[0].files.map(file => new File(['volume'], file.name));
  await options.onLoad(examples[0], { fetchFiles: async () => files, assertCurrent() {} });
  assert.deepEqual(state.files.map(file => file.name), ['phantom_UNI.nii.gz', 'phantom_INV2.nii.gz', 'phantom_SA2RAGE.nii.gz']);
  assert.equal($('#mp_tr').value, 4.3);
  assert.equal($('#mp_ti1').value, 0.840);
  assert.equal($('#sa_trflash').value, 0.005);
  assert.equal($('#taskSel').value, 'b1only');
});
