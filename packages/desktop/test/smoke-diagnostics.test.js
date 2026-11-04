import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startOfflineServer } from '../src/server.js';

test('diagnostics distinguish stream failure and socket closure without hiding failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'smoke-diagnostics-'));
  const records = [];
  const original = console.error;
  const previous = process.env.NEURODESK_SMOKE_DIAGNOSTICS;
  process.env.NEURODESK_SMOKE_DIAGNOSTICS = '1';
  console.error = line => records.push(JSON.parse(line));
  let local;
  try {
    await mkdir(join(root, 'site'));
    // A directory passes stat but is rejected before streaming; /proc/self/mem
    // is a regular file whose stream fails on Linux without reading user data.
    local = await startOfflineServer(root, { resolveFile: () => '/proc/self/mem' });
    if (process.platform !== 'linux') return;
    await assert.rejects(fetch(`${local.origin}/synthseg/app-shell.js?secret=never-log`));
    local.close();
    await new Promise(resolve => local.server.once('close', resolve));
    assert.ok(records.some(record => record.event === 'stream-error' && record.code === 'EIO'));
    assert.ok(records.some(record => record.event === 'response-close' && !record.finished));
    assert.ok(records.some(record => record.event === 'close'));
    await assert.rejects(fetch(`${local.origin}/synthseg/app-shell.js`));
    assert.ok(records.every(record => !JSON.stringify(record).includes('never-log')));
    assert.ok(records.every(record => !Number.isNaN(Date.parse(record.time))));
  } finally {
    if (local?.server.listening) local.close();
    console.error = original;
    if (previous === undefined) delete process.env.NEURODESK_SMOKE_DIAGNOSTICS;
    else process.env.NEURODESK_SMOKE_DIAGNOSTICS = previous;
    await rm(root, { recursive: true, force: true });
  }
});
