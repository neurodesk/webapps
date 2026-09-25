import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import vm from 'node:vm';
import { runJob, readJob } from '../src/jobs.js';

test('a batch invocation preserves an existing output directory before touching the browser', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'offline-existing-output-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'result.nii'), 'previous result');
  await assert.rejects(runJob({}, {}, directory), /Output directory must be empty/);
  assert.equal(await readFile(join(directory, 'result.nii'), 'utf8'), 'previous result');
});

test('missing batch inputs fail before an application is started', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'offline-job-input-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'job.json');
  await writeFile(path, JSON.stringify({ schemaVersion: 1, app: 'niimath', expectedDownloads: 1, steps: [{ action: 'upload', selector: '#input', paths: ['missing.nii'] }] }));
  await assert.rejects(readJob(path), { code: 'ENOENT' });
});

// A stand-in for Electron webContents whose page is a fixed set of elements.
function fakeContents(elements) {
  const document = { querySelector: selector => elements[selector] ?? null };
  const context = vm.createContext({ document, getComputedStyle: () => ({ visibility: 'visible' }) });
  const session = { on() {}, off() {} };
  let attached = false;
  return {
    session,
    debugger: { attach: () => { attached = true; }, isAttached: () => attached, detach: () => { attached = false; }, sendCommand: async () => ({}) },
    executeJavaScript: async code => vm.runInContext(code, context),
  };
}

const waitForReady = { schemaVersion: 1, app: 'synthseg', expectedDownloads: 1, timeoutMs: 400,
  steps: [{ action: 'wait', selector: '#statusText', condition: 'text', value: 'Labels ready' }] };

test('a job fails as soon as the app reports an error in its status line', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'offline-job-error-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const status = { textContent: 'This volume needs a 3.4 GiB GPU buffer, above the validated 2.0 GiB limit.' };
  const contents = fakeContents({ '#statusText': status, '#statusText.error': status });
  const started = Date.now();
  await assert.rejects(runJob(contents, structuredClone(waitForReady), join(directory, 'out')),
    /synthseg reported an error: This volume needs a 3\.4 GiB GPU buffer/);
  assert.ok(Date.now() - started < 300, 'the job must not wait for its timeout');
});

test('failSelector null keeps the previous wait-until-timeout behaviour', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'offline-job-nofail-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const status = { textContent: 'Some error' };
  const contents = fakeContents({ '#statusText': status, '#statusText.error': status });
  await assert.rejects(runJob(contents, { ...structuredClone(waitForReady), failSelector: null }, join(directory, 'out')),
    /Timed out waiting for #statusText/);
});

test('an invalid failure selector is rejected when the job is read', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'offline-job-selector-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'job.json');
  await writeFile(path, JSON.stringify({ ...waitForReady, failSelector: 42 }));
  await assert.rejects(readJob(path), /Invalid failure selector/);
});
