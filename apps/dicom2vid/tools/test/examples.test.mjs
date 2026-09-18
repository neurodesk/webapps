import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const examples = JSON.parse(await readFile(new URL('../../examples.json', import.meta.url)));
const source = await readFile(new URL('../../web/js/app.js', import.meta.url), 'utf8');
const setupBody = source.split('async function setupExamples() {')[1].split('\nvoid setupExamples()')[0];
const makeSetup = new Function('createExampleSelector', 'fetch', 'document', '$', 'handleFiles', 'collectFromPicker', 'S', 'setStatus', `return async function() {${setupBody}`);

test('example selection passes the hosted volume through the normal ingest path', async () => {
  let options;
  const selector = {};
  let imported;
  const file = new File(['volume'], 'T1_head.nii.gz');
  const setup = makeSetup(value => { options = value; return selector; },
    async () => ({ ok: true, json: async () => examples }), { baseURI: 'https://example.org/dicom2vid/' },
    () => ({ before(element) { assert.equal(element, selector); } }), async files => { imported = files; }, files => files,
    { volume: {} }, () => {});
  await setup();
  await options.onLoad(examples[0], { fetchFiles: async () => [file], assertCurrent() {} });
  assert.deepEqual(imported, [file]);
  imported = null;
  await assert.rejects(options.onLoad(examples[0], {
    fetchFiles: async () => [file], assertCurrent() { throw new DOMException('Cancelled', 'AbortError'); },
  }), { name: 'AbortError' });
  assert.equal(imported, null);
});
