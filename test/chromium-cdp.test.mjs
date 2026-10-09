import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { test } from 'node:test';
import { waitForChromiumEndpoint } from '../test-utils/chromium-cdp.mjs';

async function profile(t) {
  const directory = await mkdtemp(join(tmpdir(), 'chromium-cdp-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('Chromium can publish its debugging endpoint after the browser launch returns', async t => {
  const directory = await profile(t);
  const endpoint = waitForChromiumEndpoint(directory);
  await setTimeout(50);
  await writeFile(join(directory, 'DevToolsActivePort'), '43210\n');
  await setTimeout(50);
  await writeFile(join(directory, 'DevToolsActivePort'), '43210\n/devtools/browser/test-browser\n');
  assert.equal(await endpoint, 'ws://127.0.0.1:43210/devtools/browser/test-browser');
});

test('cancelling a browser lease interrupts the endpoint wait', async t => {
  const directory = await profile(t);
  const controller = new AbortController();
  const waiting = waitForChromiumEndpoint(directory, { signal: controller.signal });
  const rejected = assert.rejects(waiting, { name: 'AbortError' });
  controller.abort();
  await rejected;
});

test('a browser that never publishes its endpoint fails within the deadline', async t => {
  const directory = await profile(t);
  await assert.rejects(waitForChromiumEndpoint(directory, { timeout: 50 }), { name: /AbortError|TimeoutError/ });
});

test('endpoint discovery preserves filesystem errors other than a pending file', async t => {
  const directory = await profile(t);
  await writeFile(join(directory, 'not-a-directory'), 'fixture');
  await assert.rejects(waitForChromiumEndpoint(join(directory, 'not-a-directory')), { code: 'ENOTDIR' });
});
