import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadAppsRegistry, repoRoot } from '../scripts/lib/apps-registry.mjs';
import { loadAppExamples } from '../scripts/lib/app-examples.mjs';

const example = {
  id: 't1', label: 'T1-weighted head MRI',
  url: 'https://huggingface.co/datasets/neurodeskorg/webapps/resolve/356a4adbce52cf9052d61ef90b14ba263e7c25e9/synthseg/validation/T1_head.nii.gz',
};

test('new apps cannot omit examples or browser coverage', async t => {
  const root = await mkdtemp(join(tmpdir(), 'app-examples-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = { id: 'future-app', ci: { browser_test: true } };
  await mkdir(join(root, 'apps/future-app'), { recursive: true });
  const path = join(root, 'apps/future-app/examples.json');
  await assert.rejects(loadAppExamples(app, root), /provide examples.json/);
  for (const [value, message] of [
    [[], /at least one/],
    [[{ ...example, url: example.url.replace(/[a-f0-9]{40}/, 'main') }], /pin example URLs/],
    [[{ ...example, label: 'TODO' }], /descriptive label/],
    [[example, example], /unique lowercase ids/],
  ]) {
    await writeFile(path, JSON.stringify(value));
    await assert.rejects(loadAppExamples(app, root), message);
  }
  await writeFile(path, JSON.stringify([example]));
  assert.deepEqual(await loadAppExamples(app, root), [example]);
  await assert.rejects(loadAppExamples({ ...app, ci: { browser_test: false } }, root), /enable ci.browser_test/);
});

test('every declared example is available in the locked offline inventory', async () => {
  const { apps } = await loadAppsRegistry();
  const sources = JSON.parse(await readFile(join(repoRoot, 'registry/offline-assets.sources.json')));
  const lock = JSON.parse(await readFile(join(repoRoot, 'registry/offline-assets.lock.json')));
  for (const app of apps) {
    for (const example of await loadAppExamples(app) || []) {
      assert.ok(sources.apps[app.id].some(asset => asset.url === example.url), `${app.id}: register ${example.id} offline source`);
      assert.ok(lock.apps[app.id].includes(example.url), `${app.id}: register ${example.id} offline lock`);
      assert.match(lock.assets[example.url].sha256, /^[a-f0-9]{64}$/);
      assert.ok(lock.assets[example.url].bytes > 0);
    }
  }
});
