import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadAppsRegistry, repoRoot } from '../scripts/lib/apps-registry.mjs';
import { loadAppExamples, exampleAssets } from '../scripts/lib/app-examples.mjs';

const example = {
  id: 't1', label: 'T1-weighted head MRI',
  description: 'A full-head anatomical MRI for brain extraction.',
  expectedResult: 'A downloadable extracted brain and brain mask.',
  files: [{ role: 'image', name: 'T1_head.nii.gz', url: 'https://huggingface.co/datasets/neurodeskorg/webapps/resolve/356a4adbce52cf9052d61ef90b14ba263e7c25e9/synthseg/validation/T1_head.nii.gz' }],
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
    [[{ ...example, files: [] }], /complete files bundle/],
    [[{ ...example, generated: { generator: 'phantom-v1' }, files: [] }], /export synthetic examples/],
    [[{ ...example, files: [{ ...example.files[0], url: example.files[0].url.replace(/[a-f0-9]{40}/, 'main') }] }], /pin example URLs/],
    [[{ ...example, files: [{ ...example.files[0], url: example.files[0].url.replace('/neurodeskorg/webapps/', '/another/dataset/') }] }], /pin example URLs/],
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
    for (const example of exampleAssets(await loadAppExamples(app))) {
      assert.ok(sources.apps[app.id].some(asset => asset.url === example.url), `${app.id}: register ${example.name} offline source`);
      assert.ok(lock.apps[app.id].includes(example.url), `${app.id}: register ${example.name} offline lock`);
      assert.match(lock.assets[example.url].sha256, /^[a-f0-9]{64}$/);
      assert.ok(lock.assets[example.url].bytes > 0);
    }
  }
});


test('existing apps cannot omit examples through a legacy exemption', async t => {
  const root = await mkdtemp(join(tmpdir(), 'app-examples-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(loadAppExamples({ id: 'musclemap', ci: { browser_test: true } }, root), /provide examples.json/);
});

test('all catalog apps retain a browser workflow command', async () => {
  for (const app of (await loadAppsRegistry()).apps) {
    const manifest = JSON.parse(await readFile(join(repoRoot, 'apps', app.id, 'package.json')));
    assert.equal(app.ci.browser_test, true, `${app.id}: enable browser coverage`);
    assert.ok(manifest.scripts['test:e2e']?.trim(), `${app.id}: provide test:e2e`);
  }
});

test('SeedSeg has withdrawn its unsuitable example', async () => {
  assert.deepEqual(await loadAppExamples({ id: 'seedseg', ci: { browser_test: true } }), []);
});
