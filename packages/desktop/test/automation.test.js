import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAutomationService, loadAutomationContracts } from '../src/automation.js';
import { parseContract, readContract } from '../src/contracts.js';
import { describeFile } from '../src/reports.js';
import { EventEmitter } from 'node:events';
import { completeBrowserArtifacts } from '../src/artifact-completion.js';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const contract = { ...await readContract(new URL('../../../apps/synthseg/automation.json', import.meta.url)), appVersion: '0.3.20260928' };

async function fixture(t, execute) {
  const root = await mkdtemp(join(tmpdir(), 'automation-service-'));
  const image = join(root, 'head.nii.gz');
  await writeFile(image, await readFile(new URL('../../../exes/synthseg/test/fixtures/small.nii.gz', import.meta.url)));
  const service = createAutomationService({
    contracts: [{ contract, sha256: 'a'.repeat(64) }], outputRoot: join(root, 'runs'), execute,
  });
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  return { root, service, request: { inputs: { image: [image] } } };
}

async function completed(service, id) {
  for (let i = 0; i < 100; i++) {
    const run = await service.get(id);
    if (run.state !== 'running') return run;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Run did not terminate');
}

test('completed runs expose only their verified artifacts and persist execution provenance', async t => {
  const { root, service, request } = await fixture(t, async ({ outputDirectory, acceptBrowserOutcome }) => {
    const path = join(outputDirectory, 'labels.nii');
    await writeFile(path, 'labels');
    const report = { artifacts: { labels: { ...await describeFile(path), mediaType: 'application/x-nifti' } } };
    acceptBrowserOutcome({ report });
    return report;
  });
  const started = await service.start('synthseg', request);
  const run = await completed(service, started.id);
  assert.equal(run.state, 'succeeded');
  assert.equal(run.report.contractSha256, 'a'.repeat(64));
  const resources = await service.listResources();
  const uri = resources.find(resource => resource.name === 'labels.nii').uri;
  assert.equal(Buffer.from((await service.readResource(uri))[0].blob, 'base64').toString(), 'labels');
  await assert.rejects(service.readResource('file:///etc/passwd'), /Unknown/);
  const saved = JSON.parse(await readFile(join(root, 'runs', started.id, 'run.json')));
  assert.equal(saved.state, 'succeeded');
  await writeFile(join(run.report.outputDirectory, 'labels.nii'), 'tampered');
  await assert.rejects(service.readResource(uri), /changed/);
});

test('cancellation clears partial outputs and permits a subsequent run', async t => {
  const { root, service, request } = await fixture(t, async ({ signal, outputDirectory }) => {
    await writeFile(join(outputDirectory, 'partial.nii'), 'partial');
    signal.throwIfAborted();
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  const first = await service.start('synthseg', request);
  await assert.rejects(service.start('synthseg', request), /active/);
  const cancelled = await service.cancel(first.id);
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.error.code, 'CANCELLED');
  assert.deepEqual(await service.listResources(), []);
  await assert.rejects(readFile(join(root, 'runs', first.id, 'outputs', 'partial.nii')), { code: 'ENOENT' });
  const second = await service.start('synthseg', request);
  assert.notEqual(second.id, first.id);
  await service.cancel(second.id);
});

for (const state of ['succeeded', 'failed']) {
  test(`a ${state} snapshot permits an immediate retry while its record is being saved`, { timeout: 5000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'automation-retry-'));
    const contract = parseContract({ schemaVersion: 2, app: 'demo', title: 'Demo', description: 'Demo', appVersion: '0.1.20260928',
      defaultOperation: 'run', operations: { run: { title: 'Run', description: 'Run', mode: 'batch', inputs: {}, parameters: {}, artifacts: {}, engines: ['browser'] } } });
    const service = createAutomationService({
      contracts: [{ contract, sha256: 'a'.repeat(64) }], outputRoot: root,
      execute: async ({ acceptBrowserOutcome }) => {
        if (state === 'failed') throw new Error('Processing failed');
        const report = { artifacts: {} };
        acceptBrowserOutcome({ report });
        return report;
      },
    });
    t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
    const first = await service.start('demo', {});
    let run;
    do {
      await new Promise(resolve => setImmediate(resolve));
      run = await service.get(first.id);
    } while (run.state === 'running');
    assert.equal(run.state, state);
    const retries = await Promise.allSettled([service.start('demo', {}), service.start('demo', {})]);
    assert.equal(retries.filter(result => result.status === 'fulfilled').length, 1);
    assert.match(retries.find(result => result.status === 'rejected').reason.message, /Another scientific run is active/);
    assert.equal(JSON.parse(await readFile(join(root, first.id, 'run.json'))).state, state);
  });
}

test('timeouts and unavailable native engines return actionable failures', async t => {
  const { service, request } = await fixture(t, async ({ signal }) => {
    signal.throwIfAborted();
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  await assert.rejects(service.validate('synthseg', { ...request, engine: 'native' }), /NEURODESK_SYNTHSEG_BIN/);
  const started = await service.start('synthseg', { ...request, timeoutMs: 20 });
  const run = await completed(service, started.id);
  assert.equal(run.state, 'failed');
  assert.equal(run.error.code, 'TIMEOUT');
  assert.deepEqual(await service.listResources(), []);
});

test('discovery verifies the contract against the offline inventory', async t => {
  const root = await mkdtemp(join(tmpdir(), 'automation-published-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'site/synthseg'), { recursive: true });
  const path = 'site/synthseg/automation.json';
  const bytes = JSON.stringify(contract);
  await writeFile(join(root, path), bytes);
  const bundle = { apps: [{ id: 'synthseg', path: 'synthseg' }], files: { [path]: { bytes: Buffer.byteLength(bytes), sha256: createHash('sha256').update(bytes).digest('hex') } } };
  assert.equal((await loadAutomationContracts(root, bundle))[0].contract.app, 'synthseg');
  await writeFile(join(root, path), `${bytes} `);
  await assert.rejects(loadAutomationContracts(root, bundle), /corrupt/);
});

test('viewer sessions remain usable across scientific runs and closing them preserves reports', async t => {
  const root = await mkdtemp(join(tmpdir(), 'automation-viewer-'));
  let closed = 0;
  const viewer = parseContract({ schemaVersion: 2, app: 'viewer', title: 'Viewer', description: 'View an image', appVersion: '0.1.20260928',
    defaultOperation: 'open', operations: { open: { title: 'Open', description: 'Open image', mode: 'viewer', inputs: {}, parameters: {}, artifacts: {}, engines: ['browser'] } } });
  const service = createAutomationService({
    contracts: [{ contract: viewer, sha256: 'b'.repeat(64) }], outputRoot: join(root, 'runs'), sessionOptions: { maximum: 1 },
    execute: async ({ acceptBrowserOutcome }) => {
      const outcome = { report: { artifacts: {}, summary: { dimensions: [10, 20, 30] } }, session: {
        close() { closed++; }, command: async () => ({ position: { frame: 'mm', value: [1, 2, 3] } }),
      } };
      acceptBrowserOutcome(outcome);
      return outcome;
    },
  });
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  assert.deepEqual((await service.listApps())[0].availableEngines, ['browser']);
  const started = await service.start('viewer', {});
  const run = await completed(service, started.id);
  assert.equal(run.state, 'succeeded');
  assert.equal((await service.listSessions())[0].runId, run.id);
  assert.deepEqual(await service.viewerCommand(run.session.id, 'viewers.state', { viewerId: 'image' }), { position: { frame: 'mm', value: [1, 2, 3] } });
  await assert.rejects(service.start('viewer', {}), /limit/);
  await service.closeSession(run.session.id);
  assert.equal(closed, 1);
  assert.equal(JSON.parse((await service.readResource(run.reportUri))[0].text).executionId, run.id);
  const second = await service.start('viewer', {});
  assert.equal((await completed(service, second.id)).state, 'succeeded');
  await service.close();
  assert.equal(closed, 2);
});

for (const result of ['success', 'host failure', 'cancelled', 'publication failure']) {
  test(`browser completion keeps its pending viewer private on ${result}`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'automation-completion-'));
    if (result === 'publication failure') {
      t.mock.method(fs, 'renameSync', () => { throw new Error('Publication failed'); });
      syncBuiltinESMExports();
      t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    }
    const viewer = parseContract({ schemaVersion: 2, app: 'viewer', title: 'Viewer', description: 'View an image', appVersion: '0.1.20260928',
      defaultOperation: 'open', operations: { open: { title: 'Open', description: 'Open image', mode: 'viewer', inputs: {}, parameters: {}, artifacts: {}, engines: ['browser'] } } });
    let accepted;
    const acceptance = new Promise(resolve => { accepted = resolve; });
    let release;
    const publishing = new Promise(resolve => { release = resolve; });
    let closed = 0;
    let blocked = false;
    const service = createAutomationService({
      contracts: [{ contract: viewer, sha256: 'b'.repeat(64) }], outputRoot: root, sessionOptions: { maximum: 1 },
      execute: async ({ outputDirectory, signal, acceptBrowserOutcome }) => completeBrowserArtifacts({ session: new EventEmitter() }, {
        outputDirectory, signal,
        assertHostHealthy() { if (blocked) throw new Error('Offline asset missing'); },
      }, async artifacts => {
        const report = await artifacts.verify(() => ({ artifacts: {} }));
        const outcome = { report, session: { close() { closed++; }, command: async () => 'viewer state' } };
        acceptBrowserOutcome(outcome);
        accepted();
        await publishing;
        return outcome;
      }),
    });
    t.after(async () => { release(); await service.close(); await rm(root, { recursive: true, force: true }); });
    const started = await service.start('viewer', {});
    await acceptance;
    assert.deepEqual(await service.listSessions(), []);
    const marker = join(root, started.id, 'outputs/job-result.json');
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
    let cancellation;
    if (result === 'host failure') blocked = true;
    if (result === 'cancelled') cancellation = service.cancel(started.id);
    release();
    const run = cancellation ? await cancellation : await completed(service, started.id);
    if (result === 'success') {
      assert.equal(run.state, 'succeeded');
      assert.equal((await service.listSessions())[0].id, run.session.id);
      assert.deepEqual(JSON.parse(await readFile(marker)), { artifacts: {} });
      assert.equal(closed, 0);
    } else {
      assert.equal(run.state, result === 'cancelled' ? 'cancelled' : 'failed');
      assert.deepEqual(await service.listSessions(), []);
      assert.equal(closed, 1);
      await assert.rejects(readFile(marker), { code: 'ENOENT' });
      await assert.rejects(readFile(join(root, started.id, 'outputs')), { code: 'ENOENT' });
    }
  });
}
