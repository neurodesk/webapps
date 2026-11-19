import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createAgentPrompts } from '../src/ui/agentPrompt.js';

function page(url = 'about:blank') {
  const { window } = new JSDOM('<!doctype html><body></body>', { url });
  // As in a browser, close() fires the close event in a later task.
  window.HTMLDialogElement.prototype.showModal = function showModal() { this.setAttribute('open', ''); };
  window.HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open');
    setTimeout(() => this.dispatchEvent(new window.Event('close')));
  };
  return window.document;
}

const tick = () => new Promise(resolve => setTimeout(resolve, 5));
const dialog = document => document.getElementById('neurodeskAgentPrompt');
const buttons = document => [...dialog(document).querySelectorAll('.nd-dialog-actions button')];
const press = (document, text) => buttons(document).find(button => button.textContent === text).click();

test('a question names the agent and returns the chosen option', async () => {
  const document = page();
  const answer = createAgentPrompts(document).ask({ question: 'Which series?', options: ['T1', 'T2'] });
  await tick();
  assert.equal(dialog(document).open, true);
  assert.match(dialog(document).textContent, /AI agent you started/);
  assert.match(dialog(document).textContent, /Which series\?/);
  assert.equal(dialog(document).querySelector('textarea'), null, 'options alone offer no text answer');
  press(document, 'T2');
  assert.deepEqual(await answer, { answer: 'T2' });
  assert.equal(dialog(document).open, false);
});

test('a free-text question returns what the person typed', async () => {
  const document = page();
  const answer = createAgentPrompts(document).ask({ question: 'Which threshold?' });
  await tick();
  dialog(document).querySelector('textarea').value = '0.4';
  press(document, 'Send answer');
  assert.deepEqual(await answer, { answer: '0.4' });
});

test('closing or declining a question dismisses it', async () => {
  const document = page();
  const prompts = createAgentPrompts(document);
  const closed = prompts.ask({ question: 'One?' });
  await tick();
  dialog(document).close();
  assert.deepEqual(await closed, { dismissed: true });
  const declined = prompts.ask({ question: 'Two?' });
  await tick();
  press(document, 'Decline');
  assert.deepEqual(await declined, { dismissed: true });
});

test('prompts show one at a time, and an aborted signal closes or drops its prompt', async () => {
  const document = page();
  const prompts = createAgentPrompts(document);
  const first = prompts.ask({ question: 'First?', options: ['yes'] });
  const queued = new AbortController();
  const second = prompts.ask({ question: 'Second?', options: ['yes'] }, { signal: queued.signal });
  const third = prompts.ask({ question: 'Third?', options: ['ok'] });
  await tick();
  assert.match(dialog(document).textContent, /First\?/);
  queued.abort();
  assert.deepEqual(await second, { dismissed: true }, 'a queued prompt answers as soon as its signal aborts');
  press(document, 'yes');
  assert.deepEqual(await first, { answer: 'yes' });
  await tick();
  assert.match(dialog(document).textContent, /Third\?/, 'the aborted prompt never showed');
  assert.equal(dialog(document).open, true, 'the late close event of the first prompt does not decline the third');
  const shown = new AbortController();
  const fourth = prompts.ask({ question: 'Fourth?' }, { signal: shown.signal });
  press(document, 'ok');
  await third;
  await tick();
  shown.abort();
  assert.deepEqual(await fourth, { dismissed: true });
  assert.equal(dialog(document).open, false);
});

test('a file request returns the chosen files and enforces the count', async () => {
  const document = page();
  const { File } = document.defaultView;
  const request = createAgentPrompts(document).requestFiles({ label: 'One anatomical head image', formats: ['nifti'], minimum: 1, maximum: 1, message: 'Your T1 scan, please.' });
  await tick();
  assert.match(dialog(document).textContent, /One anatomical head image \(nifti\)/);
  assert.match(dialog(document).textContent, /Your T1 scan, please\./);
  const field = dialog(document).querySelector('nd-file-field');
  const choose = files => {
    Object.defineProperty(field.input, 'files', { configurable: true, value: files });
    field.input.dispatchEvent(new document.defaultView.Event('change'));
  };
  choose([new File(['a'], 'a.nii'), new File(['b'], 'b.nii')]);
  await tick();
  assert.match(dialog(document).querySelector('[role="alert"]').textContent, /exactly 1 file/);
  assert.equal(dialog(document).open, true);
  const image = new File(['a'], 'a.nii');
  choose([image]);
  assert.deepEqual(await request, [image]);
});

test('a folder request offers a folder field, and declining returns null', async () => {
  const document = page();
  const request = createAgentPrompts(document).requestFiles({ label: 'DICOM series', formats: ['dicom'], folder: true, maximum: 1 });
  await tick();
  const fields = [...dialog(document).querySelectorAll('nd-file-field')];
  assert.equal(fields.length, 2);
  assert.equal(fields[1].input.hasAttribute('webkitdirectory'), true);
  assert.equal(fields[0].input.multiple, true, 'a folder-capable role takes many slices');
  press(document, 'Decline');
  assert.equal(await request, null);
});

test('a prompt that fails to render leaves the queue working for the next one', async () => {
  const document = page();
  const prompts = createAgentPrompts(document);
  await assert.rejects(prompts.ask({ question: 'Broken', options: 'not a list' }));
  const next = prompts.ask({ question: 'Valid?', options: ['OK'] });
  await tick();
  assert.match(dialog(document).textContent, /Valid\?/);
  press(document, 'OK');
  assert.deepEqual(await next, { answer: 'OK' });
});

test('a fetch approval names the app and every address, resolved, and only Allow approves it', async () => {
  const document = page('https://apps.test/brain-extraction/');
  const prompts = createAgentPrompts(document);
  const asked = prompts.confirmFetch({ app: 'Brain Extraction', addresses: ['https://elsewhere.test/scan.nii.gz', 'tables/atlas.json'] });
  await tick();
  assert.match(dialog(document).textContent, /Let Brain Extraction load the files at these addresses into the page\?/);
  assert.match(dialog(document).textContent, /nothing they redirect to\. The servers at https:\/\/elsewhere\.test, https:\/\/apps\.test see the request/);
  const shown = [...dialog(document).querySelectorAll('code')].map(code => code.textContent);
  assert.deepEqual(shown, ['https://elsewhere.test/scan.nii.gz', 'https://apps.test/brain-extraction/tables/atlas.json']);
  press(document, 'Allow');
  assert.equal(await asked, true);
  const declined = prompts.confirmFetch({ app: 'Brain Extraction', addresses: ['https://elsewhere.test/x'] });
  await tick();
  press(document, 'Decline');
  assert.equal(await declined, false);
  const closed = prompts.confirmFetch({ app: 'Brain Extraction', addresses: ['https://elsewhere.test/x'] });
  await tick();
  dialog(document).close();
  assert.equal(await closed, false);
});

test('a store approval names the root the app reads under, and which server sees the requests', async () => {
  const document = page('https://apps.test/zarro/');
  const asked = createAgentPrompts(document).confirmFetch({ app: 'ZARRo', addresses: ['https://data.test/brain.ome.zarr'], readsUnder: true });
  await tick();
  assert.match(dialog(document).textContent, /Let ZARRo read the data stored under this address\?/);
  assert.match(dialog(document).textContent, /ZARRo reads the addresses under it, such as a store's metadata and chunks\. The server at https:\/\/data\.test sees every request\./);
  press(document, 'Allow');
  assert.equal(await asked, true);
});

test('confirming page files lists them and only Allow approves', async () => {
  const document = page();
  const prompts = createAgentPrompts(document);
  const asked = prompts.confirmFiles({ app: 'NiiMath', label: 'Choose NIfTI files', files: [{ name: 'exam-a.nii.gz', bytes: 4 }] });
  await tick();
  assert.match(dialog(document).textContent, /Let the agent run NiiMath on these files from Choose NIfTI files\?/);
  assert.match(dialog(document).textContent, /The page received them but may not show them now\./);
  assert.deepEqual([...dialog(document).querySelectorAll('li')].map(item => item.textContent), ['exam-a.nii.gz']);
  press(document, 'Decline');
  assert.equal(await asked, false);
  const allowed = prompts.confirmFiles({ app: 'NiiMath', label: 'Choose NIfTI files', files: [{ name: 'exam-a.nii.gz', bytes: 4 }] });
  await tick();
  press(document, 'Allow');
  assert.equal(await allowed, true);
});
