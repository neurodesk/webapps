import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { findCatalog, loadAppsRegistry } from '../../../scripts/lib/apps-registry.mjs';
import { desktopSuite } from '../../../scripts/lib/standalone.mjs';
import { builderConfig } from '../../../scripts/desktop/suites.mjs';
const directory = resolve(import.meta.dirname, '..');
const require = createRequire(resolve(directory, 'package.json'));
const builderRequire = createRequire(require.resolve('electron-builder'));
const { getConfig } = builderRequire('app-builder-lib/out/util/config/config.js');

test('electron-builder copies only the resource directory without models', async (t) => {
  t.mock.method(builderRequire('builder-util').log, 'info', console.error);
  const resources = resolve(directory, 'resources-light');
  const config = await getConfig(directory, null, { extraResources: [{ from: resources, to: 'offline' }] });
  assert.deepEqual(config.extraResources, [{ from: resources, to: 'offline' }]);
  assert.equal(config.artifactName, 'webapps-${version}-${os}-${arch}.${ext}');
});

test('the full suite keeps the package names and an edition is named after its catalogue', async (t) => {
  t.mock.method(builderRequire('builder-util').log, 'info', console.error);
  const registry = await loadAppsRegistry();
  const { build } = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'));
  const named = async catalog => {
    const config = await getConfig(directory, null, builderConfig(desktopSuite(registry, findCatalog(registry, catalog))));
    return { appId: config.appId, productName: config.productName, executableName: config.executableName, artifactName: config.artifactName, extraMetadata: config.extraMetadata };
  };
  assert.deepEqual(await named('neuro'), { appId: build.appId, productName: build.productName, executableName: 'neurodesk-webapps', artifactName: build.artifactName, extraMetadata: undefined });
  assert.deepEqual(await named('microscopy'), {
    appId: 'org.sciget.microscopyapps',
    productName: 'Microscopy Webapps',
    executableName: 'microscopy-webapps',
    artifactName: 'webapps-microscopy-${version}-${os}-${arch}.${ext}',
    extraMetadata: { productName: 'Microscopy Webapps' },
  });
});

test('each suite keeps its own Electron profile directory', async (t) => {
  t.mock.method(builderRequire('builder-util').log, 'info', console.error);
  const registry = await loadAppsRegistry();
  const pkg = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'));
  // Electron's app.getName(), which names userData: the packaged productName, else name.
  const profile = async catalog => {
    const config = await getConfig(directory, null, builderConfig(desktopSuite(registry, findCatalog(registry, catalog))));
    const packaged = { ...pkg, ...config.extraMetadata };
    return packaged.productName ?? packaged.name;
  };
  const profiles = await Promise.all(registry.site.catalogs.map(({ id }) => profile(id)));
  assert.equal(profiles[registry.site.catalogs.findIndex(({ host }) => host === registry.site.domain)], '@neurodesk/desktop');
  assert.equal(new Set(profiles).size, profiles.length, `suites share a profile: ${profiles}`);
});
