import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { completeBrowserArtifacts } from '../src/artifact-completion.js';

async function fixture(t) {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'artifact-completion-'));
  t.after(() => rm(outputDirectory, { recursive: true, force: true }));
  const contents = { session: new EventEmitter() };
  function download(filename, bytes = Buffer.from('scientific output'), owner = contents) {
    const item = new EventEmitter();
    Object.assign(item, {
      cancelled: false,
      getFilename: () => filename,
      getReceivedBytes: () => bytes.length,
      setSavePath(path) { item.path = path; },
      cancel() { item.cancelled = true; item.emit('done', {}, 'cancelled'); },
      async finish(state = 'completed') {
        if (item.path) await writeFile(item.path, bytes);
        item.emit('done', {}, state);
      },
    });
    contents.session.emit('will-download', {}, item, owner);
    return item;
  }
  const report = { app: 'example', status: 'succeeded' };
  async function verify(artifacts) {
    await artifacts.download('output-7', () => download('result.nii').finish(), async () => {});
    return artifacts.verify(({ downloads }) => {
      assert.deepEqual(downloads, [{ filename: 'result.nii', bytes: 17, role: 'output-7' }]);
      return report;
    });
  }
  const run = (execute, options = {}) => completeBrowserArtifacts(contents, {
    outputDirectory, assertHostHealthy() {}, ...options,
  }, execute);
  async function assertNoReport() {
    for (const filename of ['job-result.json', '.job-result.json.partial']) {
      await assert.rejects(readFile(join(outputDirectory, filename)), { code: 'ENOENT' });
    }
    assert.equal(contents.session.listenerCount('will-download'), 0);
  }
  return { outputDirectory, contents, download, report, verify, run, assertNoReport };
}

test('completion is published only after host acceptance and ignores other windows', async t => {
  const f = await fixture(t);
  const outcome = await f.run(async artifacts => {
    const foreign = f.download('result.nii', Buffer.from('foreign'), {});
    assert.equal(foreign.path, undefined);
    assert.equal(foreign.cancelled, false);
    const report = await f.verify(artifacts);
    await assert.rejects(readFile(join(f.outputDirectory, 'job-result.json')), { code: 'ENOENT' });
    return { report, accepted: true };
  });
  assert.equal(outcome.accepted, true);
  assert.deepEqual(JSON.parse(await readFile(join(f.outputDirectory, 'job-result.json'))), f.report);
  assert.equal(f.contents.session.listenerCount('will-download'), 0);
});

test('a rejected host check retains scientific files without completion evidence', async t => {
  const f = await fixture(t);
  let blocked = false;
  await assert.rejects(f.run(async artifacts => {
    const report = await f.verify(artifacts);
    blocked = true;
    return { report };
  }, { assertHostHealthy() { if (blocked) throw new Error('Offline asset missing'); } }), /Offline asset missing/);
  await f.assertNoReport();
  assert.equal(await readFile(join(f.outputDirectory, 'result.nii'), 'utf8'), 'scientific output');
});

for (const stage of ['validation', 'acceptance', 'publication']) {
  test(`late duplicate downloads during ${stage} prevent publication`, async t => {
    const f = await fixture(t);
    const originalWrite = fs.promises.writeFile;
    if (stage === 'publication') {
      fs.promises.writeFile = async (path, ...args) => {
        await originalWrite(path, ...args);
        if (String(path).endsWith('.job-result.json.partial')) f.download('result.nii');
      };
      syncBuiltinESMExports();
    }
    try {
      await assert.rejects(f.run(async artifacts => {
        await artifacts.download('output', () => f.download('result.nii').finish(), async () => {});
        const report = await artifacts.verify(() => {
          if (stage === 'validation') assert.equal(f.download('result.nii').cancelled, true);
          return f.report;
        });
        if (stage === 'acceptance') assert.equal(f.download('result.nii').cancelled, true);
        return { report };
      }), /Duplicate output/);
      await f.assertNoReport();
    } finally {
      fs.promises.writeFile = originalWrite;
      syncBuiltinESMExports();
    }
  });
}

for (const mode of ['abort', 'host', 'rename']) {
  test(`${mode} failure at publication removes partial and final reports`, async t => {
    const f = await fixture(t);
    const controller = new AbortController();
    let blocked = false;
    const originalWrite = fs.promises.writeFile;
    const originalRename = fs.renameSync;
    fs.promises.writeFile = async (path, ...args) => {
      await originalWrite(path, ...args);
      if (String(path).endsWith('.job-result.json.partial')) {
        if (mode === 'abort') controller.abort();
        blocked = true;
      }
    };
    if (mode === 'rename') fs.renameSync = () => { throw new Error('Rename failed'); };
    syncBuiltinESMExports();
    try {
      await assert.rejects(f.run(async artifacts => ({ report: await f.verify(artifacts) }), {
        signal: controller.signal,
        assertHostHealthy() { if (mode === 'host' && blocked) throw new Error('Late offline failure'); },
      }), mode === 'abort' ? { name: 'AbortError' } : mode === 'host' ? /Late offline failure/ : /Rename failed/);
      await f.assertNoReport();
      assert.equal(await readFile(join(f.outputDirectory, 'result.nii'), 'utf8'), 'scientific output');
    } finally {
      fs.promises.writeFile = originalWrite;
      fs.renameSync = originalRename;
      syncBuiltinESMExports();
    }
  });
}

test('existing completion files are preserved when directory admission fails', async t => {
  const f = await fixture(t);
  for (const filename of ['job-result.json', '.job-result.json.partial']) await writeFile(join(f.outputDirectory, filename), 'previous');
  await assert.rejects(f.run(() => assert.fail('Browser must not execute')), /Output directory must be empty/);
  for (const filename of ['job-result.json', '.job-result.json.partial']) assert.equal(await readFile(join(f.outputDirectory, filename), 'utf8'), 'previous');
});

test('window destruction preserves the original failure and releases its captured session', async t => {
  const f = await fixture(t);
  const session = f.contents.session;
  let destroyed = false;
  Object.defineProperty(f.contents, 'session', { get() {
    if (destroyed) throw new Error('Object has been destroyed');
    return session;
  } });
  const failure = new Error('Window closed during export');
  await assert.rejects(f.run(async () => {
    destroyed = true;
    throw failure;
  }), error => error === failure);
  assert.equal(session.listenerCount('will-download'), 0);
  await assert.rejects(readFile(join(f.outputDirectory, 'job-result.json')), { code: 'ENOENT' });
});

test('unverified and substituted reports cannot complete', async t => {
  for (const substitute of [false, true]) {
    const f = await fixture(t);
    await assert.rejects(f.run(async artifacts => {
      if (substitute) await f.verify(artifacts);
      return { report: { ...f.report } };
    }), /requires its verified report/);
    await f.assertNoReport();
  }
});

test('cancellation after committed completion preserves its report', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  await f.run(async artifacts => ({ report: await f.verify(artifacts) }), { signal: controller.signal });
  controller.abort();
  assert.deepEqual(JSON.parse(await readFile(join(f.outputDirectory, 'job-result.json'))), f.report);
  assert.equal(f.contents.session.listenerCount('will-download'), 0);
});

for (const filename of ['job-result.json', '.job-result.json.partial', 'run.json']) {
  test(`reserved output ${filename} is cancelled`, async t => {
    const f = await fixture(t);
    await assert.rejects(f.run(async artifacts => {
      await artifacts.download('output', () => {
        assert.equal(f.download(filename).cancelled, true);
      }, async () => {});
    }), /Unexpected output/);
    await f.assertNoReport();
  });
}

test('duplicate identities, interrupted and empty downloads fail', async t => {
  for (const defect of ['identity', 'interrupted', 'empty']) {
    const f = await fixture(t);
    await assert.rejects(f.run(async artifacts => {
      await artifacts.download('output', async () => {
        const item = f.download('result.nii', defect === 'empty' ? Buffer.alloc(0) : Buffer.from('output'));
        if (defect === 'identity') assert.equal(f.download('other.nii').cancelled, true);
        await item.finish(defect === 'interrupted' ? 'interrupted' : 'completed');
      }, async () => {});
      return { report: await artifacts.verify(() => f.report) };
    }), /Duplicate artifact output|interrupted|validation failed/);
    await f.assertNoReport();
  }
});
