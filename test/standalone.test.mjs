import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { loadAppsRegistry } from '../scripts/lib/apps-registry.mjs';
import { loadStandalone } from '../scripts/lib/standalone.mjs';
import { ciWorkflowApps, cpuWorkflowApps, hardwareWorkflowApps } from '../scripts/desktop/ci-apps.mjs';
import { prepareWorkflow, workflowApps } from '../scripts/desktop/workflows.mjs';
import { openStandalone } from '../packages/components/src/ui/renderStandalone.js';
import { portableCommand, releasePlatform } from '../scripts/lib/portable-command.mjs';
import { nativeReleases, portableSpecs } from '../scripts/lib/native-releases.mjs';

test('scanner packages link the supported apps to their OpenRecon recipes', async () => {
  const catalog = await loadStandalone(await loadAppsRegistry());
  const expected = { musclemap: 'musclemap', qsmbly: 'qsmxt', spinalcordtoolbox: 'spinalcordtoolbox', synthseg: 'synthseg', topofit: 'topofit', vesselboost: 'vesselboost' };
  assert.deepEqual(Object.fromEntries(Object.entries(catalog.apps).filter(([, app]) => app.openrecon).map(([id, app]) => [id, app.openrecon.recipe])), expected);
  const dom = new JSDOM('<html><body></body></html>');
  const dialog = openStandalone({ title: 'QSMbly', app: catalog.apps.qsmbly }, dom.window.document);
  const sections = [...dialog.root.querySelectorAll('section > h3')].map(node => node.textContent);
  assert.deepEqual(sections.filter(name => name !== 'Command line'), ['Neurodesk containers', 'OpenRecon · MRI scanner console']);
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
  const app = { downloads: [{ kind: 'cli', platform: 'macOS ARM64', version: '0.1.20260915', url: 'https://github.com/neurodesk/webapps/releases/download/demo-v0.1.20260915/demo.zip' }], containers: [] };
  const dialog = openStandalone({ title: 'Demo', app }, dom.window.document);
  assert.match(dialog.root.textContent, /Command line/);
  assert.equal(dialog.root.querySelectorAll('a').length, 1);
  assert.match(dialog.root.querySelector('a').href, /demo.zip$/);
  assert.equal(dialog.root.querySelector('dialog'), null);
  dom.window.close();
});


test('every app has an executable offline workflow test', async () => {
  const registry = await loadAppsRegistry();
  assert.deepEqual([...workflowApps].sort(), registry.apps.map(app => app.id).sort(), 'Implement an offline computation or interactive workflow test before adding an app');
});

test('standalone choices are ordered, omit technical clutter and never offer the all-apps suite', async () => {
  const dom = new JSDOM('<html><body></body></html>');
  const download = { kind: 'cli', platform: 'macos-arm64', version: '0.1.20260915', url: 'https://example.test/demo.zip', command: "echo 'hash' | shasum -a 256 -c -\nunzip app.zip" };
  const app = { downloads: [download], containers: [{ id: 'demo', label: 'Demo 1', url: 'https://hub.docker.com/r/demo', dockerImage: 'demo:1', apptainerUrl: 'https://neurocontainers.neurodesk.workers.dev/demo_1_20260915.simg' }] };
  const { suite } = await loadStandalone(await loadAppsRegistry());
  const dialog = openStandalone({ title: 'Demo', app, suite }, dom.window.document);
  assert.deepEqual([...dialog.root.querySelectorAll('section > h3')].map(node => node.textContent), ['Neurodesk containers', 'Command line']);
  const links = [...dialog.root.querySelectorAll('a')].map(node => node.href);
  assert.ok(links.every(href => !/\/webapps-v\d/.test(href)), 'an app links only its own releases, never the desktop suite');
  assert.doesNotMatch(dialog.root.textContent, /sha256|sha-256|shasum|Prepare this upstream|Model pack/i);
  assert.match(dialog.root.textContent, /docker pull demo:1/);
  assert.match(dialog.root.textContent, /curl -X GET https:\/\/neurocontainers.neurodesk.workers.dev\/demo_1_20260915.simg -O/);
  assert.equal(dialog.root.querySelector('details').open, false);
  assert.match(dialog.root.textContent, /unzip app.zip/);
  dom.window.close();
});


// An app's Standalone download is its own command line, never the all-apps desktop suite. Every app ships
// one (packages/<app>/release.json or a Rust release source) unless it is listed here with the reason.
// Remove an entry in the change that adds its command line.
const WITHOUT_COMMAND_LINE = {
  dcm2niix: 'interactive BIDS curation: acquisition labels and fieldmap associations are user decisions; upstream dcm2niix supplies the converter command line',
  surfannotate: 'interactive surface annotation: every result is a manual choice in the viewer',
  zarro: 'interactive OME-Zarr viewer: it has no batch output',
  nesvor: 'needs CUDA; its standalone form is the neurodesk-compute server',
  dicomview: 'interactive DICOM browser: dcm2niix and dicompare already ship as command lines',
  'pipeline-builder': 'writes NeuroFlow workflows: neuroflow-mcp runs and validates them from the command line',
  sdc: 'exes/sdc builds the sdc command line on the same core; its release packaging follows the app (#473)',
  dwicorrect: 'exes/dwi/shoreline builds the shoreline command line on the same core; its release packaging follows the app',
  fastprep: 'exes/fastprep drives separately installed niimath, brainchop, greedy-rs, synthsr, topofit and glm; a bundled release waits on packaging those (TopoFit licence pending)',
  'me-ica': 'its meica CLI is released from niivue/meica-rs; no release is tagged yet',
  bison: 'the bison command line in packages/bison follows the app; its release packaging is not done yet',
};

test('every app ships its own command line or states why it cannot', async () => {
  const registry = await loadAppsRegistry();
  const natives = nativeReleases(await portableSpecs());
  for (const { id } of registry.apps) {
    assert.notEqual(natives.has(id), id in WITHOUT_COMMAND_LINE, natives.has(id) ? `${id} has a command line: remove it from WITHOUT_COMMAND_LINE` : `${id}: add packages/${id}/release.json, or list it in WITHOUT_COMMAND_LINE with the reason`);
  }
  assert.deepEqual(Object.keys(WITHOUT_COMMAND_LINE).filter(id => !registry.apps.some(app => app.id === id)), []);
});

test('future apps automatically receive real offline workflow coverage on hosted CI', () => {
  assert.deepEqual(ciWorkflowApps({ apps: [{ id: 'future-app' }, { id: 'synthseg' }] }), ['future-app']);
});

test('an app whose browser tests need a hardware GPU keeps its desktop workflow off the hosted runners', async () => {
  const registry = await loadAppsRegistry();
  const hosted = new Set(ciWorkflowApps(registry));
  for (const app of registry.apps.filter(app => app.ci?.hardware_gpu && hosted.has(app.id) && !cpuWorkflowApps.has(app.id))) {
    // Only a workflow that computes on a compute server (prepareWorkflow provisions one) runs without the runner's GPU.
    const prepared = await prepareWorkflow(app.id);
    await prepared?.close();
    assert.ok(prepared, `${app.id} declares ci.hardware_gpu and computes in the browser: add it to hardwareWorkflowApps in scripts/desktop/ci-apps.mjs with its hardware evidence, or to cpuWorkflowApps with its hosted runs`);
  }
});

test('an app whose offline workflow completed on every hosted runner without a GPU stays in hosted coverage', async () => {
  const registry = await loadAppsRegistry();
  const hosted = new Set(ciWorkflowApps(registry));
  for (const id of cpuWorkflowApps) {
    assert.ok(registry.apps.some(app => app.id === id), `${id} is not a registered app`);
    assert.ok(registry.apps.find(app => app.id === id).ci?.hardware_gpu, `${id} does not declare ci.hardware_gpu, so cpuWorkflowApps has nothing to override`);
    assert.ok(!hardwareWorkflowApps.has(id) && hosted.has(id), `${id} completed its workflow on the hosted runners: remove it from hardwareWorkflowApps`);
  }
});

test('fastprep is in the hosted desktop workflow selection', async () => {
  // Named independently of cpuWorkflowApps: dropping fastprep from both sets would otherwise pass unnoticed.
  assert.ok(ciWorkflowApps(await loadAppsRegistry()).includes('fastprep'), 'fastprep completed its offline workflow on every hosted runner (standalone-validation.md, 19 October 2026)');
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
