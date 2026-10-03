import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { runJob, readJob } from '../src/jobs.js';
import { completeBrowserArtifacts } from '../src/artifact-completion.js';

async function runCompletedJob(contents, job, outputDirectory, options = {}) {
  const { report } = await completeBrowserArtifacts(contents, {
    outputDirectory, signal: options.signal, assertHostHealthy() {},
  }, async artifacts => ({ report: await runJob(contents, job, { ...options, artifacts }) }));
  return report;
}

test('a batch invocation preserves an existing output directory before touching the browser', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'offline-existing-output-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'result.nii'), 'previous result');
  await assert.rejects(runCompletedJob({}, {}, directory), /Output directory must be empty/);
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
  const session = new EventEmitter();
  let attached = false;
  const contents = {
    session,
    isDestroyed: () => false,
    // Starts a fake Electron download owned by this page; returns a function that ends it.
    startDownload(filename, bytes = 10) {
      let finish;
      const item = { getFilename: () => filename, setSavePath() {}, cancel() {}, getReceivedBytes: () => bytes, once: (_event, handler) => { finish = handler; } };
      session.emit('will-download', {}, item, contents);
      return state => finish({}, state);
    },
    debugger: { attach: () => { attached = true; }, isAttached: () => attached, detach: () => { attached = false; }, sendCommand: async () => ({}) },
    executeJavaScript: async code => vm.runInContext(code, context),
  };
  return contents;
}

const waitForReady = { schemaVersion: 1, app: 'synthseg', expectedDownloads: 1, timeoutMs: 400,
  steps: [{ action: 'wait', selector: '#statusText', condition: 'text', value: 'Labels ready' }] };

test('a job fails as soon as the app reports an error in its status line', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'offline-job-error-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const status = { textContent: 'This volume needs a 3.4 GiB GPU buffer, above the validated 2.0 GiB limit.' };
  const contents = fakeContents({ '#statusText': status, '#statusText.error': status });
  const started = Date.now();
  await assert.rejects(runCompletedJob(contents, structuredClone(waitForReady), join(directory, 'out')),
    /synthseg reported an error: This volume needs a 3\.4 GiB GPU buffer/);
  assert.ok(Date.now() - started < 300, 'the job must not wait for its timeout');
});

test('failSelector null keeps the previous wait-until-timeout behaviour', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'offline-job-nofail-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const status = { textContent: 'Some error' };
  const contents = fakeContents({ '#statusText': status, '#statusText.error': status });
  await assert.rejects(runCompletedJob(contents, { ...structuredClone(waitForReady), failSelector: null }, join(directory, 'out')),
    /Timed out waiting for #statusText/);
});

test('an invalid failure selector is rejected when the job is read', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'offline-job-selector-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'job.json');
  await writeFile(path, JSON.stringify({ ...waitForReady, failSelector: 42 }));
  await assert.rejects(readJob(path), /Invalid failure selector/);
});

const tick = ms => new Promise(resolve => setTimeout(resolve, ms));

test('a job succeeds once its outputs have finished downloading', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'offline-job-success-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const contents = fakeContents({ '#statusText': { textContent: 'Labels ready' } });
  const output = join(directory, 'out');
  const job = runCompletedJob(contents, structuredClone(waitForReady), output);
  await tick(20);
  const finish = contents.startDownload('t1_synthseg.nii.gz', 1234);
  await tick(20);
  finish('completed');
  assert.deepEqual(await job, { app: 'synthseg', downloads: [{ filename: 't1_synthseg.nii.gz', bytes: 1234 }] });
  assert.deepEqual(JSON.parse(await readFile(join(output, 'job-result.json'), 'utf8')), { app: 'synthseg', downloads: [{ filename: 't1_synthseg.nii.gz', bytes: 1234 }] });
});

test('an error reported while an output is still downloading fails the job', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'offline-job-late-error-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const elements = { '#statusText': { textContent: 'Labels ready' } };
  const contents = fakeContents(elements);
  const job = runCompletedJob(contents, structuredClone(waitForReady), join(directory, 'out'));
  await tick(20);
  contents.startDownload('t1_synthseg.nii.gz');
  await tick(20);
  elements['#statusText.error'] = { textContent: 'Could not write the report' };
  const started = Date.now();
  await assert.rejects(job, /synthseg reported an error: Could not write the report/);
  assert.ok(Date.now() - started < 300, 'the job must not wait for its timeout');
});

test('a download that never completes is bounded by the job timeout', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'offline-job-stuck-download-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const contents = fakeContents({ '#statusText': { textContent: 'Labels ready' } });
  const job = runCompletedJob(contents, structuredClone(waitForReady), join(directory, 'out'));
  await tick(20);
  contents.startDownload('t1_synthseg.nii.gz');
  await assert.rejects(job, /Expected 1 outputs, received 0/);
});

const downloadJob = {
  schemaVersion: 1,
  app: 'synthseg',
  expectedDownloads: 1,
  timeoutMs: 400,
  steps: [{ action: 'click', selector: '#download' }],
};

test('a duplicate output still fails after the expected output completes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'offline-job-duplicate-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const contents = fakeContents({
    '#download': { click() {
      contents.startDownload('labels.nii.gz')('completed');
      contents.startDownload('labels.nii.gz');
    } },
  });
  await assert.rejects(runCompletedJob(contents, downloadJob, directory), /Duplicate output: labels.nii.gz/);
  await assert.rejects(readFile(join(directory, 'job-result.json')), { code: 'ENOENT' });
});

test('an app error at download completion prevents a success report', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'offline-job-final-error-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const elements = {
    '#download': { click() {
      contents.startDownload('labels.nii.gz')('completed');
      elements['#statusText.error'] = { textContent: 'Could not write the report' };
    } },
  };
  const contents = fakeContents(elements);
  await assert.rejects(runCompletedJob(contents, downloadJob, directory), /synthseg reported an error: Could not write the report/);
  await assert.rejects(readFile(join(directory, 'job-result.json')), { code: 'ENOENT' });
});

test('a custom failure selector reports its own message', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'offline-job-custom-error-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const contents = fakeContents({ '#failure': { textContent: 'Custom processing error' } });
  const path = join(directory, 'job.json');
  await writeFile(path, JSON.stringify({ ...waitForReady, failSelector: '#failure' }));
  const job = await readJob(path);
  const output = join(directory, 'out');
  await assert.rejects(runCompletedJob(contents, job, output), /synthseg reported an error: Custom processing error/);
  await assert.rejects(readFile(join(output, 'job-result.json')), { code: 'ENOENT' });
});

test('destroyed job contents do not mask the browser failure during debugger cleanup', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'offline-job-destroyed-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const contents = fakeContents({});
  let destroyed = false;
  contents.isDestroyed = () => destroyed;
  contents.executeJavaScript = async () => {
    destroyed = true;
    throw new Error('Window closed during execution');
  };
  contents.debugger.isAttached = () => assert.fail('Destroyed debugger must not be accessed');
  await assert.rejects(runCompletedJob(contents, downloadJob, directory), /Window closed during execution/);
  assert.equal(contents.session.listenerCount('will-download'), 0);
});

test('an unexpected output still downloading prevents a success report', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'offline-job-extra-output-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const contents = fakeContents({
    '#download': { click() {
      contents.startDownload('labels.nii.gz')('completed');
      contents.startDownload('unexpected.nii.gz');
    } },
  });
  await assert.rejects(runCompletedJob(contents, downloadJob, directory), /Batch output validation failed/);
  await assert.rejects(readFile(join(directory, 'job-result.json')), { code: 'ENOENT' });
});

test('cancelling while the success report is written removes the report and rejects', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'offline-job-cancel-write-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const controller = new AbortController();
  const originalWrite = fs.promises.writeFile;
  fs.promises.writeFile = async (path, ...args) => {
    await originalWrite(path, ...args);
    if (String(path).endsWith('.job-result.json.partial')) controller.abort();
  };
  syncBuiltinESMExports();
  try {
    const contents = fakeContents({
      '#download': { click() { contents.startDownload('labels.nii.gz')('completed'); } },
    });
    await assert.rejects(runCompletedJob(contents, downloadJob, directory, { signal: controller.signal }), { name: 'AbortError' });
    await assert.rejects(readFile(join(directory, 'job-result.json')), { code: 'ENOENT' });
    await assert.rejects(readFile(join(directory, '.job-result.json.partial')), { code: 'ENOENT' });
  } finally {
    fs.promises.writeFile = originalWrite;
    syncBuiltinESMExports();
  }
});
