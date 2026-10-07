import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import YAML from 'yaml';
import { openStandalone } from '../packages/components/src/ui/renderStandalone.js';
import { nativeReleases, portableSpecs, portableSpecsAt } from '../scripts/lib/native-releases.mjs';
import { applyCatalogUpdate, catalogReleases, catalogUpdate, parseReleases, releaseFromTag } from '../scripts/lib/standalone-import.mjs';

const CATALOG_DISPATCH = 'gh api "repos/$GITHUB_REPOSITORY/dispatches" -f event_type=standalone-catalog -f "client_payload[releases]=$RELEASE"';

async function workflow(name) {
  return YAML.parse(await readFile(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8'));
}

function asset(name, digit = 'a') {
  return { name, digest: `sha256:${digit.repeat(64)}`, size: 10, browser_download_url: `https://github.com/neurodesk/webapps/releases/download/x/${name}` };
}

const spec = {
  app: 'tool',
  run: 'input.nii.gz results',
  targets: {
    'linux-x64': { archive: 'tar.gz', executable: 'tool' },
    'windows-x64': { archive: 'zip', executable: 'tool.exe' },
    'macos-arm64': { archive: 'pkg', executable: 'tool' },
  },
};
const portable = nativeReleases(new Map([['tool', { packageDir: 'packages/elsewhere', spec }]]));
const archives = ['tool-0.2.20261006-linux-x64.tar.gz', 'tool-0.2.20261006-windows-x64.zip', 'tool-0.2.20261006-macos-arm64.pkg'];

function verifiedRelease(names, tag = 'tool-v0.2.20261006') {
  return { tag_name: tag, draft: false, prerelease: false, assets: names.flatMap((name) => [asset(name), asset(`${name}.validation.txt`, 'b')]) };
}

// A receipt as exes/node-cli writes it: "PASS <target>" and the archive's digest.
function passingReceipt(url) {
  const platform = /-(linux-x64|windows-x64|macos-arm64)\./.exec(url)[1];
  return `PASS ${platform}\narchive_sha256=${'a'.repeat(64)}\n`;
}

function update(catalog, release, natives = portable, value = 'tool@0.2.20261006', fetchText = async (url) => passingReceipt(url)) {
  return catalogUpdate(catalog, parseReleases([value]), { fetchRelease: async () => release, fetchText, nativeAt: () => natives });
}

test('a verified portable release becomes one download per target with its install commands', async () => {
  const catalog = { apps: { tool: { downloads: [] } } };
  const release = verifiedRelease(archives);
  release.assets.push(asset('tool-0.2.20261006-macos-arm64-adhoc.pkg'));
  const changes = await update(catalog, release);
  assert.deepEqual(catalog.apps.tool.downloads, [], 'computing an update writes nothing');
  applyCatalogUpdate(catalog, changes);
  const downloads = catalog.apps.tool.downloads;
  assert.deepEqual(downloads.map((download) => download.platform), ['linux-x64', 'macos-arm64', 'windows-x64'], 'sorted by platform, as registry/standalone.json lists them');
  assert.ok(downloads.every((download) => download.modelsIncluded && download.validationUrl.endsWith('.validation.txt')));
  assert.match(downloads[1].command, /^sudo installer -pkg tool-0\.2\.20261006-macos-arm64\.pkg -target \//);
});

test('incomplete, unverified, draft or prerelease releases never reach the catalog', async () => {
  const catalog = { apps: { tool: { downloads: [] } } };
  await assert.rejects(update(catalog, verifiedRelease(archives.slice(0, 2))), /lacks macos-arm64/);
  const unverified = verifiedRelease(archives);
  unverified.assets = unverified.assets.filter((item) => !item.name.endsWith('.zip.validation.txt'));
  await assert.rejects(update(catalog, unverified), /no validation receipt/);
  await assert.rejects(update(catalog, { ...verifiedRelease(archives), draft: true }), /not released yet/);
  await assert.rejects(update(catalog, { ...verifiedRelease(archives), prerelease: true }), /not released yet/);
  await assert.rejects(update(catalog, verifiedRelease(archives), new Map()), /ships no native command line/);
  assert.throws(() => parseReleases(['tool@latest']), /app@MAJOR\.MINOR\.YYYYMMDD/);
});

test('a receipt must pass the exact bytes released, and the catalog never moves to an older release', async () => {
  const catalog = { apps: { tool: { downloads: [] } } };
  const release = verifiedRelease(archives);
  await assert.rejects(update(catalog, release, portable, undefined, async (url) => passingReceipt(url).replace('a'.repeat(64), 'c'.repeat(64))), /validated different bytes/);
  await assert.rejects(update(catalog, release, portable, undefined, async () => ''), /does not pass these exact bytes/);
  await assert.rejects(update(catalog, release, portable, undefined, async (url) => passingReceipt(url).replace('PASS', 'FAIL')), /does not pass these exact bytes/);
  const rust = nativeReleases(new Map());
  const names = ['synthseg-0.2.20260910-macos-arm64.pkg'];
  const rustRelease = verifiedRelease(names, 'synthseg-v0.2.20260910');
  await assert.rejects(update({ apps: { synthseg: { downloads: [] } } }, rustRelease, rust, 'synthseg@0.2.20260910', async () => ' \n'), /receipt is empty/);
  await assert.rejects(update({ apps: { synthseg: { downloads: [] } } }, rustRelease, rust, 'synthseg@0.2.20260910', async () => `sha256: ${'c'.repeat(64)}\n`), /validated different bytes/);
  assert.ok(await update(catalog, release, portable, undefined, async (url) => passingReceipt(url).replace(/\n/g, '\r\n')), 'Windows line endings are the same receipt');
  const newer = await update(catalog, release);
  applyCatalogUpdate(catalog, newer);
  const older = structuredClone(newer);
  older[0].version = '0.1.20261001';
  for (const download of older[0].downloads) download.version = '0.1.20261001';
  applyCatalogUpdate(catalog, older);
  assert.ok(catalog.apps.tool.downloads.every((download) => download.version === '0.2.20261006'), 'a slow run for an older release keeps the newer entry');
});

test('Rust tools need every target and a receipt per archive, and keep their embedded-model note', async () => {
  const rust = nativeReleases(new Map());
  const catalog = { apps: { synthsr: { downloads: [{ kind: 'cli', platform: 'linux-x64', version: '0.3.20260910', modelsIncluded: true }] } } };
  assert.deepEqual(catalogReleases(catalog, rust), [{ id: 'synthsr', version: '0.3.20260910' }]);
  const names = ['synthsr-0.3.20260910-linux-x64.tar.gz', 'synthsr-0.3.20260910-windows-x64.zip', 'synthsr-0.3.20260910-macos-arm64.pkg'];
  await assert.rejects(update(catalog, verifiedRelease(names.slice(0, 1), 'synthsr-v0.3.20260910'), rust, 'synthsr@0.3.20260910'), /lacks/);
  const bare = { tag_name: 'synthsr-v0.3.20260910', draft: false, prerelease: false, assets: names.map((name) => asset(name)) };
  await assert.rejects(update(catalog, bare, rust, 'synthsr@0.3.20260910'), /no validation receipt/);
  applyCatalogUpdate(catalog, await update(catalog, verifiedRelease(names, 'synthsr-v0.3.20260910'), rust, 'synthsr@0.3.20260910', async () => 'packaged CPU inference: ok\n'));
  assert.ok(catalog.apps.synthsr.downloads.every((download) => download.modelsIncluded && !download.command));
});

// SynthSEG as it ships: the Rust workflow builds the Metal macOS installer at its Cargo version, and the
// portable Node release builds Linux and Windows at the app's version.
const nodeSpec = {
  app: 'synthseg',
  workflow: 'synthseg-portable.yml',
  run: 'input.nii.gz results',
  targets: {
    'linux-x64': { archive: 'tar.gz', executable: 'synthseg' },
    'windows-x64': { archive: 'zip', executable: 'synthseg.exe' },
  },
};
const split = nativeReleases(new Map([['synthseg', { packageDir: 'packages/synthseg', spec: nodeSpec }]]));
const rustMacos = Object.freeze({
  kind: 'cli',
  platform: 'macos-arm64',
  version: '0.2.20260910',
  url: 'https://github.com/neurodesk/webapps/releases/download/synthseg-v0.2.20260910/synthseg-0.2.20260910-macos-arm64.pkg',
  sha256: 'fe2e4c27c041c477b300b13a9c41e185720c8ac0f476052b24a2aae471b6eb70',
  bytes: 57289186,
  validationUrl: 'https://github.com/neurodesk/webapps/releases/download/synthseg-v0.2.20260910/synthseg-0.2.20260910-macos-arm64.pkg.validation.txt',
  modelsIncluded: true,
});
const nodeArchives = (version) => [`synthseg-${version}-linux-x64.tar.gz`, `synthseg-${version}-windows-x64.zip`];
const rustReceipt = async () => `sha256: ${'a'.repeat(64)}\npackaged CPU inference: ok\n`;

function synthsegCatalog() {
  return { apps: { synthseg: { downloads: [structuredClone(rustMacos)] } } };
}

async function synthsegUpdate(catalog, version, names, fetchText = async (url) => passingReceipt(url)) {
  return update(catalog, verifiedRelease(names, `synthseg-v${version}`), split, `synthseg@${version}`, fetchText);
}

test('each release source owns its platforms, and two owners for one platform cannot be declared', () => {
  const [rust, portableSource] = split.get('synthseg');
  assert.deepEqual([rust.workflow, rust.targets, rust.startsWithAppRelease], ['synthseg-native.yml', ['macos-arm64'], false]);
  assert.deepEqual([portableSource.workflow, portableSource.targets, portableSource.publishInput], ['synthseg-portable.yml', ['linux-x64', 'windows-x64'], 'publish_release']);
  const overlapping = { ...nodeSpec, targets: { ...nodeSpec.targets, 'macos-arm64': { archive: 'pkg', executable: 'synthseg' } } };
  assert.throws(() => nativeReleases(new Map([['synthseg', { packageDir: 'packages/synthseg', spec: overlapping }]])), /synthseg: macos-arm64 claimed by both synthseg-native\.yml and synthseg-portable\.yml/);
  const sameWorkflow = { ...nodeSpec, workflow: undefined };
  assert.throws(() => nativeReleases(new Map([['synthseg', { packageDir: 'packages/synthseg', spec: sameWorkflow }]])), /two release sources share synthseg-native\.yml/);
});

test('a portable release adds its platforms and keeps the Rust macOS installer', async () => {
  const catalog = synthsegCatalog();
  const changes = await synthsegUpdate(catalog, '0.5.20261007', nodeArchives('0.5.20261007'));
  assert.deepEqual(changes.map(({ id, version, downloads }) => [id, version, downloads.map((download) => download.platform)]), [['synthseg', '0.5.20261007', ['linux-x64', 'windows-x64']]]);
  applyCatalogUpdate(catalog, changes);
  const downloads = catalog.apps.synthseg.downloads;
  assert.deepEqual(downloads.map((download) => [download.platform, download.version]), [['linux-x64', '0.5.20261007'], ['macos-arm64', '0.2.20260910'], ['windows-x64', '0.5.20261007']]);
  assert.deepEqual(downloads[1], rustMacos, 'the Rust entry survives byte for byte');
  assert.match(downloads[0].command, /^tar -xzf synthseg-0\.5\.20261007-linux-x64\.tar\.gz\n/);
  assert.deepEqual(catalogReleases(catalog, split), [{ id: 'synthseg', version: '0.2.20260910' }, { id: 'synthseg', version: '0.5.20261007' }]);
  const rustRelease = await synthsegUpdate(catalog, '0.2.20261001', ['synthseg-0.2.20261001-macos-arm64.pkg'], rustReceipt);
  assert.deepEqual(rustRelease[0].downloads.map((download) => download.platform), ['macos-arm64']);
  applyCatalogUpdate(catalog, rustRelease);
  assert.deepEqual(catalog.apps.synthseg.downloads.map((download) => [download.platform, download.version]), [['linux-x64', '0.5.20261007'], ['macos-arm64', '0.2.20261001'], ['windows-x64', '0.5.20261007']]);
  assert.ok(catalog.apps.synthseg.downloads[1].modelsIncluded, 'the Rust installer keeps its embedded-model note');

  const dom = new JSDOM('<html><body></body></html>');
  const dialog = openStandalone({ title: 'SynthSeg', app: { downloads: catalog.apps.synthseg.downloads, containers: [] } }, dom.window.document);
  const section = dialog.root.querySelector('section[aria-labelledby="standalone-downloads"]');
  assert.deepEqual([...section.querySelectorAll('h4')].map((node) => node.textContent.replace(/ · \d+ MB$/, '')), [
    'SynthSeg command line · Linux · x64',
    'SynthSeg command line · macOS · Apple silicon',
    'SynthSeg command line · Windows · x64',
  ]);
  assert.deepEqual([...section.querySelectorAll('a')].map((node) => node.href.split('/').at(-1)), ['synthseg-0.5.20261007-linux-x64.tar.gz', 'synthseg-0.2.20261001-macos-arm64.pkg', 'synthseg-0.5.20261007-windows-x64.zip']);
  assert.match(section.textContent, /Models are included\./);
  dom.window.close();
});

test('the downgrade guard compares a release only with its own source', async () => {
  const catalog = synthsegCatalog();
  applyCatalogUpdate(catalog, await synthsegUpdate(catalog, '0.5.20261007', nodeArchives('0.5.20261007')));
  applyCatalogUpdate(catalog, await synthsegUpdate(catalog, '0.5.20261001', nodeArchives('0.5.20261001')));
  assert.deepEqual(catalog.apps.synthseg.downloads.map((download) => download.version), ['0.5.20261007', '0.2.20260910', '0.5.20261007'], 'an older portable release keeps the newer one');
  applyCatalogUpdate(catalog, await synthsegUpdate(catalog, '0.2.20260901', ['synthseg-0.2.20260901-macos-arm64.pkg'], rustReceipt));
  assert.equal(catalog.apps.synthseg.downloads[1].version, '0.2.20260910', 'an older Rust release keeps the newer installer');
  applyCatalogUpdate(catalog, await synthsegUpdate(catalog, '0.2.20261001', ['synthseg-0.2.20261001-macos-arm64.pkg'], rustReceipt));
  assert.equal(catalog.apps.synthseg.downloads[1].version, '0.2.20261001', 'a newer Rust release replaces its installer though the app version is higher');
  catalog.apps.synthseg.downloads[2].version = '0.5.20261002';
  assert.throws(() => applyCatalogUpdate(catalog, [{ id: 'synthseg', version: '0.5.20261008', downloads: [{ kind: 'cli', platform: 'linux-x64', version: '0.5.20261008' }, { kind: 'cli', platform: 'windows-x64', version: '0.5.20261008' }] }]), /mix versions/);
});

test('one tag can carry both sources, and each source it carries must be complete', async () => {
  const catalog = synthsegCatalog();
  const both = [...nodeArchives('0.5.20261007'), 'synthseg-0.5.20261007-macos-arm64.pkg'];
  const receipt = async (url) => (url.includes('.pkg') ? rustReceipt() : passingReceipt(url));
  const changes = await synthsegUpdate(catalog, '0.5.20261007', both, receipt);
  assert.deepEqual(changes.map(({ downloads }) => downloads.map((download) => download.platform)), [['macos-arm64'], ['linux-x64', 'windows-x64']]);
  assert.equal(changes[0].downloads[0].command, undefined, 'the Rust installer gets no portable install command');
  applyCatalogUpdate(catalog, changes);
  assert.deepEqual(catalog.apps.synthseg.downloads.map((download) => [download.platform, download.version]), [['linux-x64', '0.5.20261007'], ['macos-arm64', '0.5.20261007'], ['windows-x64', '0.5.20261007']]);
  await assert.rejects(synthsegUpdate(catalog, '0.5.20261007', nodeArchives('0.5.20261007').slice(0, 1)), /lacks windows-x64/);
  await assert.rejects(synthsegUpdate(catalog, '0.5.20261007', []), /has no command-line archives/);
  assert.throws(() => catalogReleases({ apps: { synthseg: { downloads: [{ kind: 'cli', platform: 'linux-x64', version: '0.5.20261007' }] } } }, nativeReleases(new Map())), /no release source builds linux-x64/);
});

test('a release.json from before exes/node-cli lists its targets without install commands', async () => {
  const legacy = nativeReleases(new Map([['syncro', { packageDir: 'packages/syncro', spec: { targets: { 'linux-x64': { archive: 'tar.gz' } } }, legacy: true }]]));
  const names = ['syncro-0.3.20260915-linux-x64.tar.gz'];
  const catalog = { apps: { syncro: { downloads: [] } } };
  applyCatalogUpdate(catalog, await update(catalog, verifiedRelease(names, 'syncro-v0.3.20260915'), legacy, 'syncro@0.3.20260915'));
  assert.equal(catalog.apps.syncro.downloads[0].platform, 'linux-x64');
  assert.equal(catalog.apps.syncro.downloads[0].command, undefined);
});

test('release tags name the app and version; specs are read from the tag itself', async () => {
  assert.deepEqual(releaseFromTag('white-matter-lesions-v0.2.20261006'), { id: 'white-matter-lesions', version: '0.2.20261006' });
  assert.equal(releaseFromTag('webapps-v0.10.20260918-desktop'), null);
  const current = await portableSpecs();
  const committed = portableSpecsAt('HEAD');
  assert.deepEqual([...committed.keys()].sort(), [...current.keys()].sort());
  for (const [app, { packageDir, spec: found }] of committed) {
    assert.equal(found.app, app);
    assert.match(packageDir, /^packages\//);
  }
  assert.equal(committed.get('topofit').packageDir, 'packages/topofit');
});

test('an app release starts every portable command line build, which then publishes to the catalog', async () => {
  const release = await workflow('release.yml');
  assert.equal(release.permissions.actions, undefined, 'only the release job may dispatch workflows');
  assert.deepEqual(release.jobs.release.permissions, { contents: 'write', actions: 'write' });
  const steps = release.jobs.release.steps;
  const start = steps.find((step) => step.name === 'Start the signed native build');
  assert.match(start.run, /node scripts\/dispatch-native-release\.mjs "\$APP" "\$\{APP\}-v\$\{VERSION\}"/);
  const install = steps.findIndex((step) => step.run === 'pnpm install --frozen-lockfile');
  assert.ok(install >= 0 && install < steps.indexOf(start), 'the dispatch script needs installed dependencies (yaml)');
  for (const native of [...nativeReleases(await portableSpecs()).values()].flat()) {
    const app = native.spec?.app ?? native.workflow;
    const flow = await workflow(native.workflow);
    assert.equal(flow.on.workflow_dispatch.inputs[native.publishInput].type, 'boolean', `${app}: dispatched with ${native.publishInput}`);
    if (native.spec) {
      const job = flow.jobs.portable;
      assert.equal(job.uses, './.github/workflows/node-cli-portable.yml', `${app}: uses the shared packager`);
      assert.equal(job.with.package, native.packageDir);
      assert.equal(job.with.publish_release, `\${{ github.event_name == 'workflow_dispatch' && inputs.${native.publishInput} }}`);
      assert.equal(job.permissions.contents, 'write');
    } else {
      const publish = flow.jobs.release.steps.at(-1);
      assert.ok(publish.run.includes(CATALOG_DISPATCH), `${app}: its release job announces the archives`);
      assert.match(publish.run, /isDraft or \.isPrerelease/, `${app}: a draft or prerelease waits for the release event`);
    }
  }
  const shared = await workflow('node-cli-portable.yml');
  assert.equal(shared.jobs.release.steps.at(-1).run, CATALOG_DISPATCH);
  assert.ok(shared.jobs.release.steps.find((step) => step.id === 'target').run.includes('echo "release='));
  // CI runs this file through `pnpm test:contracts`, which takes every test/*.test.mjs it does not exclude.
  const ci = await workflow('ci.yml');
  const contracts = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).scripts['test:contracts'];
  assert.match(contracts, /test\/\*\.test\.mjs/);
  assert.doesNotMatch(contracts, /standalone-release-automation/);
  assert.ok(Object.values(ci.jobs).some((job) => job.steps?.some((step) => step.run === 'pnpm test:contracts')));
});

test('the catalog workflow computes without write access and publishes without running dependencies', async () => {
  const flow = await workflow('standalone-catalog.yml');
  assert.deepEqual(flow.on.repository_dispatch, { types: ['standalone-catalog'] });
  assert.deepEqual(flow.on.release, { types: ['released'] });
  assert.equal(flow.concurrency, undefined, 'a concurrency group would drop queued catalog updates');
  assert.deepEqual(flow.permissions, { contents: 'read' });
  const compute = flow.jobs.compute;
  assert.equal(compute.permissions, undefined);
  assert.equal(compute.steps.find((step) => step.uses?.startsWith('actions/checkout@')).with['persist-credentials'], false);
  assert.ok(compute.steps.some((step) => step.run?.includes('node --test test/standalone.test.mjs')));
  const publish = flow.jobs.publish;
  assert.deepEqual(publish.permissions, { contents: 'write', actions: 'write' });
  assert.equal(publish.steps.find((step) => step.uses?.startsWith('actions/checkout@')).with['persist-credentials'], false);
  assert.ok(!publish.steps.some((step) => step.uses?.startsWith('pnpm/') || /\b(pnpm|npm) (install|ci)\b/.test(step.run || '')), 'no dependency code runs with the write token');
  assert.ok(publish.steps.some((step) => step.run?.includes('git push --quiet "$remote" HEAD:main')));
  assert.equal(publish.steps.at(-1).run, 'gh workflow run deploy-pages.yml --ref main');
});

test('the scripts release jobs run without installing dependencies import only Node built-ins', async () => {
  const pending = ['../scripts/dispatch-native-release.mjs', '../scripts/apply-catalog-update.mjs'].map((path) => new URL(path, import.meta.url));
  const seen = new Set();
  while (pending.length) {
    const url = pending.pop();
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    const source = await readFile(url, 'utf8');
    for (const [, specifier] of source.matchAll(/^import [^'"]*['"]([^'"]+)['"]/gm)) {
      if (specifier.startsWith('.')) pending.push(new URL(specifier, url));
      else assert.match(specifier, /^node:/, `${url.pathname} imports ${specifier}, which the release job does not install`);
    }
  }
  assert.ok(seen.size >= 4);
});
