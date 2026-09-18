import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const examples = JSON.parse(await readFile(new URL('../../examples.json', import.meta.url)));
const source = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
const setupBody = source.split('async function setupExamples() {')[1].split('\nvoid setupExamples()')[0];
const makeSetup = new Function('createExampleSelector', 'fetch', 'document', '$', 'running', 'state', 'setAppMode', 'readImageRecord', 'renderTable', 'refreshRunState', 'log', `let exampleSelector; const clearOutputs = () => {}; const revokeDownloadUrls = () => {}; const setViewerVisible = () => {}; return async function() {${setupBody}`);

test('the real brain example loads its complete bundle and matched acquisition parameters', async () => {
  let options;
  const selector = {};
  const state = { files: [], jsons: [] };
  const fields = new Map();
  const $ = id => {
    if (!fields.has(id)) fields.set(id, { value: '', replaceChildren() {}, before(element) { assert.equal(element, selector); } });
    return fields.get(id);
  };
  $('#taskSel').value = 'b1only';
  const setup = makeSetup(value => { options = value; return selector; },
    async () => ({ ok: true, json: async () => examples }), { baseURI: 'https://example.org/easy-mp2rage/' },
    $, false, state, () => {}, async file => ({ name: file.name }), () => {}, () => {}, () => {});
  await setup();
  const files = examples[0].files.map(file => new File(['volume'], file.name));
  await options.onLoad(examples[0], { fetchFiles: async () => files, assertCurrent() {} });
  assert.deepEqual(state.files.map(file => file.name), ['MP2RAGE_UNI.nii.gz', 'MP2RAGE_INV1.nii.gz', 'MP2RAGE_INV2.nii.gz', 'B1map_relative.nii.gz']);
  assert.equal($('#mp_tr').value, 6);
  assert.equal($('#mp_ti1').value, 0.8);
  assert.equal($('#b1_type').value, 'relative');
  assert.equal($('#taskSel').value, 'b1only');
});

for (const stage of ['file read', 'NIfTI decode']) {
  test(`cancelled example preserves replacement inputs and parameters during ${stage}`, async () => {
    let options;
    const selector = {};
    let resume;
    let entered;
    const paused = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { resume = resolve; });
    const state = { files: [{ name: 'original_UNI.nii' }], jsons: [] };
    const fields = new Map();
    const $ = id => {
      if (!fields.has(id)) fields.set(id, { value: 'original', replaceChildren() {}, before(element) { assert.equal(element, selector); } });
      return fields.get(id);
    };
    const controller = new AbortController();
    const recordBody = source.split('async function readImageRecord(file, buffer) {')[1].split('\nasync function addFiles(')[0];
    const makeRecord = new Function('readNifti', 'guessRole', `return async function(file, buffer) {${recordBody}`);
    const readRecord = makeRecord(async () => {
      if (stage === 'NIfTI decode') { entered(); await gate; }
      return { dims: [1, 1, 1], affine: [], data: new Float32Array([1]) };
    }, () => 'UNI');
    const file = new File(['image'], 'phantom_UNI.nii');
    if (stage === 'file read') file.arrayBuffer = async () => { entered(); await gate; return new ArrayBuffer(1); };
    const setup = makeSetup(value => { options = value; return selector; },
      async () => ({ ok: true, json: async () => examples }), { baseURI: 'https://example.org/easy-mp2rage/' },
      $, false, state, () => {}, readRecord, () => {}, () => {}, () => {});
    await setup();
    const loading = options.onLoad(examples[0], { fetchFiles: async () => [file], assertCurrent: () => controller.signal.throwIfAborted() });
    await paused;
    assert.equal(state.files[0].name, 'original_UNI.nii');
    controller.abort();
    state.files = [{ name: 'patient_UNI.nii' }];
    $('#mp_tr').value = 'patient parameter';
    resume();
    await assert.rejects(loading, { name: 'AbortError' });
    assert.deepEqual(state.files, [{ name: 'patient_UNI.nii' }]);
    assert.equal($('#mp_tr').value, 'patient parameter');
  });
}
