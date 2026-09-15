import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
