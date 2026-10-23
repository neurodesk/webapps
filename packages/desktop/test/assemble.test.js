import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { loadAppsRegistry, repoRoot } from '../../../scripts/lib/apps-registry.mjs';
import { fileHash, verifyBundle } from '../src/bundle.js';
import { startOfflineServer } from '../src/server.js';

const run = promisify(execFile);

// Run the real assembler in a tiny repository without downloading scientific assets.
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'desktop-assemble-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of [
    'scripts/desktop/assemble.mjs', 'scripts/desktop/stage-python.mjs',
    'scripts/lib/apps-registry.mjs', 'scripts/lib/standalone.mjs', 'scripts/lib/landing-page.mjs',
    'packages/desktop/src/bundle.js', 'packages/desktop/package.json',
    'packages/desktop/STANDALONE.md', 'packages/desktop/AUTOMATION.md', 'packages/desktop/jobs',
  ]) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await cp(join(repoRoot, path), join(root, path), { recursive: true });
  }
  await symlink(join(repoRoot, 'node_modules'), join(root, 'node_modules'), 'junction');
  const registry = await loadAppsRegistry();
  const apps = registry.apps.filter(app => ['mri2vid', 'zarro'].includes(app.id))
    .map(app => ({ ...app, remote_compute: app.remote_compute || undefined }));
  const emptyAssets = Object.fromEntries(apps.map(app => [app.id, []]));
  const catalog = JSON.parse(await readFile(join(repoRoot, 'registry/standalone.json')));
  await mkdir(join(root, 'registry'));
  await writeFile(join(root, 'registry/apps.yml'), JSON.stringify({ ...registry, apps }));
  await writeFile(join(root, 'registry/standalone.json'), JSON.stringify({ ...catalog, apps: Object.fromEntries(apps.map(app => [app.id, catalog.apps[app.id]])) }));
  for (const name of ['sources', 'lock']) {
    await writeFile(join(root, `registry/offline-assets.${name}.json`), JSON.stringify({ apps: emptyAssets, assets: {} }));
  }
  for (const app of apps) {
    await mkdir(join(root, 'dist', app.path), { recursive: true });
    await writeFile(join(root, 'dist', app.path, 'index.html'), '<html><head><link rel="stylesheet" href="../app-theme.css"></head><body>Offline app</body></html>');
  }
  for (const path of ['app-theme.css', 'fonts']) {
    await cp(join(repoRoot, 'site', path), join(root, 'dist', path), { recursive: true });
  }
  for (const path of ['_runtime/worker.js', 'shell-adapters/components/core/dom.js', 'unselected/index.html']) {
    await mkdir(dirname(join(root, 'dist', path)), { recursive: true });
    await writeFile(join(root, 'dist', path), 'fixture');
  }
  return root;
}

for (const app of [null, 'mri2vid', 'zarro,mri2vid']) {
  test(`offline ${app || 'suite'} assembly includes shared fonts and their licence`, async t => {
    const root = await fixture(t);
    const destination = join(root, 'offline');
    await run(process.execPath, [join(root, 'scripts/desktop/assemble.mjs'), '--out', destination, ...(app ? ['--app', app] : [])]);
    const manifest = JSON.parse(await readFile(join(destination, 'manifest.json')));
    const ids = app ? app.split(',') : ['mri2vid', 'zarro'];
    assert.deepEqual(manifest.apps.map(entry => entry.id).sort(), ids.sort());
    assert.equal(manifest.defaultApp, app && ids.length === 1 ? app : null);
    for (const path of ['fonts/inter.woff2', 'fonts/OFL.txt', '_runtime/worker.js', 'shell-adapters/components/core/dom.js']) {
      const source = join(root, 'dist', path);
      assert.deepEqual(await readFile(join(destination, 'site', path)), await readFile(source));
      assert.equal(manifest.files[`site/${path}`].sha256, await fileHash(source));
    }
    for (const excluded of ['unselected', ...(ids.includes('zarro') ? [] : ['zarro'])]) {
      await assert.rejects(readFile(join(destination, 'site', excluded, 'index.html')), { code: 'ENOENT' });
    }
    await verifyBundle(destination);
    const { server, origin } = await startOfflineServer(destination);
    t.after(() => new Promise(resolve => server.close(resolve)));
    const stylesheetUrl = new URL('../app-theme.css', `${origin}/mri2vid/`);
    const stylesheet = await (await fetch(stylesheetUrl)).text();
    const fontPath = /url\(["']?(fonts\/[^)"']+)/.exec(stylesheet)?.[1];
    assert.equal(fontPath, 'fonts/inter.woff2');
    const response = await fetch(new URL(fontPath, stylesheetUrl));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'font/woff2');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(join(repoRoot, 'site/fonts/inter.woff2')));
    await writeFile(join(destination, 'site/fonts/inter.woff2'), 'corrupt font');
    await assert.rejects(verifyBundle(destination), /missing or corrupt: site\/fonts\/inter\.woff2/);
  });
}
