import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

// NiiVue 1.0 before rc.25 loads a drawing onto the wrong voxels of a permuted
// image with unequal axes (niivue/mono#251). The shared drawing adapter no
// longer compensates, so every app that edits on NiiVue 1.0 needs the fix.
const FIXED_RC = 25;
const root = new URL('../', import.meta.url);

async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, root), 'utf8'));
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

function niivueRc(version) {
  const match = /^1\.0\.0-rc\.(\d+)$/.exec(version ?? '');
  return match ? Number(match[1]) : null;
}

test('every app that edits masks on NiiVue 1.0 loads drawings with the native dims', async () => {
  const runtimeSupport = await readJson('packages/runtime-support/package.json');
  const apps = (await readdir(new URL('apps/', root), { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name);
  const editing = [];
  for (const app of apps) {
    if (!await editsMasks(app)) continue;
    const manifest = await readJson(`apps/${app}/package.json`);
    const pins = [manifest.dependencies?.['@niivue/niivue'], manifest.devDependencies?.['@niivue/niivue']];
    if (manifest.neurodeskWebapp?.static?.freebrowseViewer) pins.push(runtimeSupport.dependencies['@niivue/niivue']);
    for (const pin of pins.filter(Boolean)) {
      const rc = niivueRc(pin);
      if (rc !== null) assert.ok(rc >= FIXED_RC, `${app} edits masks on @niivue/niivue ${pin}; it needs 1.0.0-rc.${FIXED_RC} or later`);
    }
    editing.push(app);
  }
  assert.ok(editing.includes('spinalcordtoolbox') && editing.includes('synthseg'), `found editing apps: ${editing.join(', ')}`);
});
