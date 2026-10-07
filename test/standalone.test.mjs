import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { loadAppsRegistry } from '../scripts/lib/apps-registry.mjs';
import { loadStandalone } from '../scripts/lib/standalone.mjs';
import { ciWorkflowApps } from '../scripts/desktop/ci-apps.mjs';
import { workflowApps } from '../scripts/desktop/workflows.mjs';
import { openStandalone } from '../packages/components/src/ui/renderStandalone.js';

test('scanner packages link the supported apps to their OpenRecon recipes', async () => {
  const catalog = await loadStandalone(await loadAppsRegistry());
  const expected = { musclemap: 'musclemap', qsmbly: 'qsmxt', spinalcordtoolbox: 'spinalcordtoolbox', synthseg: 'synthseg', topofit: 'topofit', vesselboost: 'vesselboost' };
  assert.deepEqual(Object.fromEntries(Object.entries(catalog.apps).filter(([, app]) => app.openrecon).map(([id, app]) => [id, app.openrecon.recipe])), expected);
  const dom = new JSDOM('<html><body></body></html>');
  const dialog = openStandalone({ title: 'QSMbly', app: catalog.apps.qsmbly, suite: catalog.suite }, dom.window.document);
  assert.deepEqual([...dialog.root.querySelectorAll('section > h3')].map(node => node.textContent), ['Neurodesk containers', 'OpenRecon · MRI scanner console', 'Webapp standalone', 'Model pack · optional']);
  const scanner = dialog.root.querySelector('section[aria-labelledby="standalone-openrecon"]');
  assert.match(scanner.textContent, /Run the QSMxT container on the MRI scanner console/);
  assert.match(scanner.textContent, /official OpenRecon package/);
  assert.deepEqual([...scanner.querySelectorAll('a')].map(node => node.href), ['https://webclient.us.api.teamplay.siemens-healthineers.com/c2p', 'https://github.com/neurodesk/openrecon/', 'https://github.com/neurodesk/openrecon/tree/main/recipes/qsmxt']);
  dom.window.close();
});

test('a future app cannot be silently omitted from desktop packaging', async t => {
  const root = await mkdtemp(join(tmpdir(), 'standalone-registry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'registry'));
  await writeFile(join(root, 'registry/standalone.json'), JSON.stringify({ schema_version: 1, apps: {} }));
  await assert.rejects(loadStandalone({ apps: [{ id: 'new-app' }] }, root), /every registered app/);
});

test('shared dialog displays verified releases and keeps unpublished platforms unlinked', () => {
  const dom = new JSDOM('<html><body></body></html>');
  const app = { downloads: [{ kind: 'desktop', platform: 'macOS ARM64', version: '0.1.20260915', url: 'https://github.com/neurodesk/webapps/releases/download/demo-v0.1.20260915/demo.zip' }], containers: [] };
  const dialog = openStandalone({ title: 'Demo', app }, dom.window.document);
  assert.match(dialog.root.textContent, /Webapp standalone/);
  assert.doesNotMatch(dialog.root.textContent, /Model pack/);
  assert.equal(dialog.root.querySelectorAll('a').length, 1);
  assert.match(dialog.root.querySelector('a').href, /demo.zip$/);
  assert.equal(dialog.root.querySelector('dialog'), null);
  dom.window.close();
});


test('every app has an executable offline workflow test', async () => {
  const registry = await loadAppsRegistry();
  assert.deepEqual([...workflowApps].sort(), registry.apps.map(app => app.id).sort(), 'Implement an offline computation or interactive workflow test before adding an app');
});

test('standalone choices are ordered and omit technical clutter', () => {
  const dom = new JSDOM('<html><body></body></html>');
  const download = { kind: 'desktop', platform: 'macos-arm64', version: '0.1.20260915', url: 'https://example.test/install.txt', archiveSha256: 'b'.repeat(64), parts: [{ url: 'https://example.test/part1' }], command: "echo 'hash' | shasum -a 256 -c -\nunzip app.zip" };
  const models = { kind: 'models', platform: 'any', version: download.version, bytes: 2.1e9, url: 'https://example.test/models.install.txt', archiveSha256: 'c'.repeat(64), parts: [{ url: 'https://example.test/models.part01' }, { url: 'https://example.test/models.part02' }], command: "cat models.part01 models.part02 > models.tar.gz\nmkdir models\ntar -xzf models.tar.gz -C models" };
  const suite = { downloads: [download], models };
  const app = { downloads: [], containers: [{ id: 'demo', label: 'Demo 1', url: 'https://hub.docker.com/r/demo', dockerImage: 'demo:1', apptainerUrl: 'https://neurocontainers.neurodesk.workers.dev/demo_1_20260915.simg' }] };
  const dialog = openStandalone({ title: 'Demo', app, suite }, dom.window.document);
  assert.deepEqual([...dialog.root.querySelectorAll('section > h3')].map(node => node.textContent), ['Neurodesk containers', 'Webapp standalone', 'Model pack · optional']);
  const pack = dialog.root.querySelector('section[aria-labelledby="standalone-models"]');
  assert.match(pack.textContent, /Every platform · 2.10 GB/);
  assert.match(pack.textContent, /NEURODESK_MODELS_DIR/);
  assert.deepEqual([...pack.querySelectorAll('a')].map(node => node.href), ['https://example.test/models.part01', 'https://example.test/models.part02']);
  assert.match(pack.textContent, /tar -xzf models.tar.gz -C models/);
  assert.doesNotMatch(dialog.root.textContent, /sha256|sha-256|shasum|Prepare this upstream/i);
  assert.match(dialog.root.textContent, /docker pull demo:1/);
  assert.match(dialog.root.textContent, /curl -X GET https:\/\/neurocontainers.neurodesk.workers.dev\/demo_1_20260915.simg -O/);
  assert.equal(dialog.root.querySelector('details').open, false);
  assert.match(dialog.root.textContent, /unzip app.zip/);
  dom.window.close();
});


test('future apps automatically receive real offline workflow coverage on hosted CI', () => {
  assert.deepEqual(ciWorkflowApps({ apps: [{ id: 'future-app' }, { id: 'synthseg' }] }), ['future-app']);
});

test('compute server setup leads with download, startup and pairing for the current webapp origin', async () => {
  const catalog = await loadStandalone(await loadAppsRegistry());
  const app = structuredClone(catalog.apps.nesvor);
  const filename = 'neurodesk-compute-0.1.20260921-linux-x64.tar.gz';
  app.computeServer.download = { filename, url: `/nesvor/downloads/${filename}`, checksumUrl: `/nesvor/downloads/${filename}.sha256`, bytes: 28000000, sha256: 'a'.repeat(64), preview: true };
  const dom = new JSDOM('<html><body></body></html>', { url: 'https://preview.example/nesvor/' });
  const dialog = openStandalone({ title: 'NeSVoR', app }, dom.window.document);
  const section = dialog.root.querySelector('section');
  assert.equal(section.getAttribute('aria-labelledby'), 'standalone-compute');
  assert.match(section.querySelector('a[download]').href, /neurodesk-compute-.*\.tar\.gz$/);
  assert.match(section.textContent, /Preview build for testing/);
  assert.match(section.querySelector('#compute-extract').textContent, /tar -xzf neurodesk-compute/);
  assert.equal(section.querySelector('#compute-doctor').textContent, './neurodesk-compute doctor');
  assert.equal(section.querySelector('#compute-start').textContent, "./start.sh --runner docker --allow-origin 'https://preview.example'");
  assert.match(section.textContent, /Pairing code/);
  assert.match(section.textContent, /port 8765/);
  dom.window.close();
});

test('compute server setup does not fabricate an unpublished backend download', async () => {
  const catalog = await loadStandalone(await loadAppsRegistry());
  const dom = new JSDOM('<html><body></body></html>');
  const app = structuredClone(catalog.apps.nesvor);
  app.computeServer.download = null;
  const dialog = openStandalone({ title: 'NeSVoR', app }, dom.window.document);
  const section = dialog.root.querySelector('#standalone-compute').parentElement;
  assert.match(section.textContent, /released backend download is not available/);
  assert.equal(section.querySelector('a[download]'), null);
  dom.window.close();
});
