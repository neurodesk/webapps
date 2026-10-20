import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

// NiiVue 1.0 before rc.25 loads a drawing onto the wrong voxels of a permuted
// image with unequal axes (niivue/mono#251). The shared drawing adapter no
// longer compensates, so every app that edits masks must run a NiiVue without
// that bug: 0.x (which loads correctly) or 1.0.0-rc.25 and later.
const FIXED_RC = 25;
const root = new URL('../', import.meta.url);

async function readText(path) {
  return readFile(new URL(path, root), 'utf8').catch(() => '');
}

async function readJson(path) {
  return JSON.parse(await readText(path));
}

async function sources(dir) {
  const entries = await readdir(new URL(dir, root), { recursive: true, withFileTypes: true }).catch(() => []);
  return entries
    .filter(entry => entry.isFile() && /\.(js|mjs|ts)$/.test(entry.name) && !entry.parentPath.includes('vendor'))
    .map(entry => `${entry.parentPath}/${entry.name}`);
}

async function editsMasks(app) {
  for (const file of [...await sources(`apps/${app}/src/`), ...await sources(`apps/${app}/web/js/`)]) {
    if ((await readFile(file, 'utf8')).includes('createMaskEditor(')) return true;
  }
  return false;
}

// Every NiiVue an app can load: its npm pin, the FreeBrowse viewer's, a pinned
// script URL, or a runtime-assets download it stages.
async function niivueVersions(app, runtimeSupport, runtimeDownloads) {
  const manifest = await readJson(`apps/${app}/package.json`);
  const versions = [manifest.dependencies?.['@niivue/niivue'], manifest.devDependencies?.['@niivue/niivue']];
  if (manifest.neurodeskWebapp?.static?.freebrowseViewer) versions.push(runtimeSupport.dependencies['@niivue/niivue']);
  for (const page of [`apps/${app}/index.html`, `apps/${app}/web/index.html`]) {
    for (const match of (await readText(page)).matchAll(/@niivue\/niivue@([^/"']+)\//g)) versions.push(match[1]);
  }
  const setup = await readText(`apps/${app}/web/setup.sh`);
  for (const download of runtimeDownloads) {
    if (download.id.startsWith('niivue') && setup.includes(` ${download.id}:`)) versions.push(download.version);
  }
  return versions.filter(Boolean);
}

function loadsDrawingsCorrectly(version) {
  if (/^0\.\d+\.\d+$/.test(version)) return true;
  const rc = /^1\.0\.0-rc\.(\d+)$/.exec(version);
  if (rc) return Number(rc[1]) >= FIXED_RC;
  return /^[1-9]\d*\.\d+\.\d+$/.test(version);
}

test('every app that edits masks runs a NiiVue that loads drawings with the native dims', async () => {
  const runtimeSupport = await readJson('packages/runtime-support/package.json');
  const { downloads } = await readJson('runtime-assets/manifest.json');
  const apps = (await readdir(new URL('apps/', root), { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name);
  const editing = [];
  for (const app of apps) {
    if (!await editsMasks(app)) continue;
    const versions = await niivueVersions(app, runtimeSupport, downloads);
    assert.ok(versions.length > 0, `${app} edits masks but this test cannot find which NiiVue it loads`);
    for (const version of versions) {
      assert.ok(loadsDrawingsCorrectly(version), `${app} edits masks on @niivue/niivue ${version}; it needs 0.x or 1.0.0-rc.${FIXED_RC} or later`);
    }
    editing.push(app);
  }
  for (const app of ['spinalcordtoolbox', 'synthseg', 'musclemap', 'vesselboost']) {
    assert.ok(editing.includes(app), `expected ${app} among the editing apps: ${editing.join(', ')}`);
  }
});
