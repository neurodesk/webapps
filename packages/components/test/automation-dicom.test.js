import test from 'node:test';
import assert from 'node:assert/strict';
import { createDicomConverter } from '../src/automation/index.js';

// Worker cleanup, abort and timeout belong to @niivue/dcm2niix; this checks the hand-off.
const moduleUrl = `data:text/javascript,${encodeURIComponent(
  'export const runDcm2niix = async (files, options) => globalThis.testDicom(files, options);')}`;

test('static converter keeps every generated File and passes signal and deadline', async t => {
  const outputs = [new File(['image'], 'image.nii'), new File(['{}'], 'image.json')];
  const signal = new AbortController().signal;
  let received;
  globalThis.testDicom = async (files, options) => { received = { files, options }; return outputs; };
  t.after(() => { delete globalThis.testDicom; });
  const input = [new File(['slice'], 'slice')];
  assert.deepEqual(await createDicomConverter({ moduleUrl, timeoutMs: 5 })(input, { signal }), outputs);
  assert.deepEqual(received, { files: input, options: { niftiOnly: false, signal, timeoutMs: 5, args: ['-f', '%p_%t_%s'] } });
});

const stalledModule = 'data:text/javascript,await new Promise(() => {});';

test('static converter cancels a pending module load', async () => {
  const controller = new AbortController();
  const result = createDicomConverter({ moduleUrl: stalledModule })([], { signal: controller.signal });
  controller.abort();
  await assert.rejects(result, { name: 'AbortError' });
});

test('static converter times out a pending module load', async () => {
  await assert.rejects(createDicomConverter({ moduleUrl: stalledModule, timeoutMs: 5 })([]), /timed out/);
});
