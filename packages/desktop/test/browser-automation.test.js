import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { runBrowserOperation } from '../src/browser-automation.js';
import { completeBrowserArtifacts } from '../src/artifact-completion.js';
import { generateJob, operationFor, parseContract, validateRequest } from '../src/contracts.js';
import { readJob } from '../src/jobs.js';
import { describeFile } from '../src/reports.js';

const contract = parseContract({ schemaVersion: 2, app: 'registration', appVersion: '0.1.20260928',
  title: 'Registration', description: 'Register a moving image.', defaultOperation: 'register', operations: {
    register: { title: 'Register', description: 'Register two inputs.', mode: 'batch', engines: ['browser'], parameters: {},
      inputs: Object.fromEntries(['moving', 'fixed'].map(role => [role, {
        type: 'neuro:volume', source: 'files', formats: ['nifti'], minimum: 1, maximum: 1, description: role,
      }])),
      artifacts: { registered: { type: 'neuro:volume', mediaType: 'application/x-nifti', minimum: 1, maximum: 1 } },
    },
  },
});

async function fixture(t, { tamperInput = false, tamperOutput = false, failure } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'desktop-browser-operation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inputs = {};
  for (const role of ['moving', 'fixed']) {
    const file = join(root, `${role}.nii`);
    await writeFile(file, role);
    inputs[role] = [file];
  }
  const request = await validateRequest(contract, { inputs });
  const adopted = {};
  const session = new EventEmitter();
  let uploaded;
  let attached = false;
  let report;
  const data = Buffer.from('registered-image');
  const descriptor = { role: 'registered', type: 'neuro:volume', mediaType: 'application/x-nifti',
    filename: 'registered.nii', bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
  const contents = {
    session,
    isDestroyed: () => false,
    debugger: {
      attach() { attached = true; }, isAttached: () => attached, detach() { attached = false; },
      async sendCommand(command, args) {
        if (command === 'DOM.getDocument') return { root: { nodeId: 1 } };
        if (command === 'DOM.querySelector') return { nodeId: 2 };
        if (command === 'DOM.setFileInputFiles') uploaded = args.files;
      },
    },
    async executeJavaScript(code) { return vm.runInNewContext(code, { neurodeskAutomation: { dispatch } }); },
  };
  async function dispatch(command, args = {}) {
    if (command === 'describe') return contract;
    if (command === 'adopt') {
      adopted[args.role] = await Promise.all(uploaded.map(describeFile));
      return { count: uploaded.length };
    }
    if (command === 'start') {
      report = { schemaVersion: 2, app: contract.app, appVersion: contract.appVersion, operation: 'register',
        runId: 'run-one', status: 'succeeded', inputs: structuredClone(adopted), parameters: {}, artifacts: { registered: descriptor } };
      if (tamperInput) report.inputs.fixed = report.inputs.moving;
      return { runId: 'run-one' };
    }
    if (command === 'snapshot') return failure
      ? { runId: 'run-one', state: 'failed', error: failure }
      : { runId: 'run-one', state: 'succeeded', report };
    if (command === 'download') {
      const item = new EventEmitter();
      const bytes = args.artifactId === 'report' ? Buffer.from(JSON.stringify(report)) : tamperOutput ? Buffer.from('tampered image') : data;
      let path;
      Object.assign(item, { getFilename: () => args.artifactId === 'report' ? 'report.json' : 'registered.nii',
        getReceivedBytes: () => bytes.length, setSavePath(value) { path = value; }, cancel() {} });
      session.emit('will-download', {}, item, contents);
      await writeFile(path, bytes);
      item.emit('done', {}, 'completed');
    }
  }
  const run = async ({ signal, assertHostHealthy = () => {}, accept = async () => {} } = {}) => {
    const { report } = await completeBrowserArtifacts(contents, { outputDirectory: join(root, 'outputs'), signal, assertHostHealthy }, async artifacts => {
      const report = await runBrowserOperation(contents, { contract, operation: operationFor(contract), request, artifacts, signal });
      await accept(report);
      return { report };
    });
    return report;
  };
  return { root, request, run, contents, adopted };
}

test('operation jobs round-trip two typed inputs and verify exact output/report downloads', async t => {
  const { root, request, run, contents, adopted } = await fixture(t);
  const path = join(root, 'job.json');
  await writeFile(path, JSON.stringify(generateJob(contract, request)));
  const job = await readJob(path);
  assert.deepEqual(job.request, request);
  const report = await run();
  assert.deepEqual(report.inputs, adopted);
  assert.equal(report.artifacts.registered.role, 'registered');
  assert.ok(report.artifacts.report.sha256);
  assert.equal(JSON.parse(await readFile(join(root, 'outputs/job-result.json'))).runId, 'run-one');
  assert.equal(contents.debugger.isAttached(), false);
  assert.equal(contents.session.listenerCount('will-download'), 0);
});

test('reports cannot substitute an input role or stale downloaded artifact', async t => {
  for (const options of [{ tamperInput: true }, { tamperOutput: true }]) {
    const { root, run } = await fixture(t, options);
    await assert.rejects(run(), /input hashes|checksum/);
    await assert.rejects(readFile(join(root, 'outputs/job-result.json')), { code: 'ENOENT' });
  }
});

test('ambiguous DICOM series returns actionable candidates immediately', async t => {
  const candidates = [{ sha256: 'a'.repeat(64), filename: 'series-1.nii.gz' }, { sha256: 'b'.repeat(64), filename: 'series-2.nii.gz' }];
  const { run, contents } = await fixture(t, { failure: { code: 'SERIES_SELECTION_REQUIRED', message: 'Choose a series', candidates } });
  await assert.rejects(run(), error => error.code === 'SERIES_SELECTION_REQUIRED' && assert.deepEqual(error.candidates, candidates) === undefined);
  assert.equal(contents.session.listenerCount('will-download'), 0);
});

test('host rejection after an operation verifies preserves downloads without publishing completion', async t => {
  const { root, run } = await fixture(t);
  let blocked = false;
  await assert.rejects(run({
    accept: async report => {
      assert.equal(report.runId, 'run-one');
      await assert.rejects(readFile(join(root, 'outputs/job-result.json')), { code: 'ENOENT' });
      blocked = true;
    },
    assertHostHealthy() { if (blocked) throw new Error('Offline asset missing'); },
  }), /Offline asset missing/);
  assert.equal(await readFile(join(root, 'outputs/registered.nii'), 'utf8'), 'registered-image');
  await assert.rejects(readFile(join(root, 'outputs/job-result.json')), { code: 'ENOENT' });
});
