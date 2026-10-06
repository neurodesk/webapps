import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { loadAppsRegistry } from '../scripts/lib/apps-registry.mjs';
import { loadStandalone } from '../scripts/lib/standalone.mjs';
import { ciWorkflowApps } from '../scripts/desktop/ci-apps.mjs';
import { workflowApps } from '../scripts/desktop/workflows.mjs';
import { openStandalone } from '../packages/components/src/ui/renderStandalone.js';
import { portableCommand, releasePlatform } from '../scripts/lib/portable-command.mjs';

test('standalone catalog covers the entire app registry', async () => {
  const registry = await loadAppsRegistry();
  const catalog = await loadStandalone(registry);
  assert.equal(Object.keys(catalog.apps).length, registry.apps.length);
});

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

test('portable command-line rows show extraction and the release spec run command', async () => {
  const spec = JSON.parse(await readFile(new URL('../packages/topofit/release.json', import.meta.url), 'utf8'));
  const version = '0.13.20261006';
  const archive = platform => `topofit-${version}-${platform}.${spec.targets[platform].archive}`;
  assert.equal(portableCommand(spec, 'linux-x64', archive('linux-x64')), `tar -xzf topofit-${version}-linux-x64.tar.gz\n./topofit-${version}-linux-x64/topofit input.nii.gz results`);
  assert.equal(portableCommand(spec, 'windows-x64', archive('windows-x64')), `Expand-Archive -Path .\\topofit-${version}-windows-x64.zip -DestinationPath .\n.\\topofit-${version}-windows-x64\\topofit.exe input.nii.gz results`);
  assert.equal(portableCommand(spec, 'macos-arm64', archive('macos-arm64')), `sudo installer -pkg topofit-${version}-macos-arm64.pkg -target /\ntopofit self-check\ntopofit input.nii.gz results`);
  assert.throws(() => portableCommand(spec, 'linux-arm64', 'topofit.tar.gz'), /not a release target/);
  assert.equal(releasePlatform(spec, archive('macos-arm64')), 'macos-arm64');
  assert.equal(releasePlatform(spec, `topofit-${version}-macos-arm64-adhoc.pkg`), null);
  assert.equal(releasePlatform(spec, `topofit-${version}-macos-arm64.tar.gz`), null);
  assert.equal(releasePlatform(spec, `${archive('macos-arm64')}.validation.txt`), null);
  assert.equal(releasePlatform(null, 'synthsr-0.3.20260910-macos-arm64.pkg'), 'macos-arm64');
  const downloads = Object.keys(spec.targets).map(platform => ({
    kind: 'cli', platform, version, bytes: 91534072, modelsIncluded: true, sha256: 'a'.repeat(64),
    url: `https://github.com/neurodesk/webapps/releases/download/topofit-v${version}/${archive(platform)}`,
    command: portableCommand(spec, platform, archive(platform)),
  }));
  const dom = new JSDOM('<html><body></body></html>');
  const dialog = openStandalone({ title: 'TopoFit', app: { downloads, containers: [] } }, dom.window.document);
  const section = dialog.root.querySelector('section[aria-labelledby="standalone-downloads"]');
  assert.match(section.textContent, /Models are included\./);
  assert.doesNotMatch(section.textContent, /Models download when first used/);
  assert.deepEqual([...section.querySelectorAll('h4')].map(node => node.textContent), [
    'TopoFit command line · Linux · x64 · 92 MB',
    'TopoFit command line · Windows · x64 · 92 MB',
    'TopoFit command line · macOS · Apple silicon · 92 MB',
  ]);
  assert.deepEqual([...section.querySelectorAll('summary')].map(node => node.textContent), ['Extract and run', 'Extract and run', 'Install and run']);
  assert.ok([...section.querySelectorAll('details')].every(node => !node.open));
  assert.match(section.textContent, new RegExp(`\\./topofit-${version}-linux-x64/topofit input\\.nii\\.gz results`));
  assert.doesNotMatch(section.textContent, /sha256|shasum|xattr|quarantine/i);
  const lines = [...section.querySelectorAll('pre, code')].flatMap(node => node.textContent.split('\n'));
  assert.ok(lines.includes(`sudo installer -pkg topofit-${version}-macos-arm64.pkg -target /`));
  assert.ok(lines.every(line => line.length <= 90), 'visible commands stay within 90 characters');
  dom.window.close();
});
