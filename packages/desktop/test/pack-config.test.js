import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { findCatalog, loadAppsRegistry } from '../../../scripts/lib/apps-registry.mjs';
import { builderConfig } from '../../../scripts/desktop/suite.mjs';

const registry = await loadAppsRegistry();
const directory = resolve(import.meta.dirname, '..');
const require = createRequire(resolve(directory, 'package.json'));
const builderRequire = createRequire(require.resolve('electron-builder'));
const { getConfig } = builderRequire('app-builder-lib/out/util/config/config.js');

test('electron-builder copies only the resource directory without models', async (t) => {
  t.mock.method(builderRequire('builder-util').log, 'info', console.error);
  const resources = resolve(directory, 'resources-light');
  const neuro = findCatalog(registry, 'neuro');
  const config = await getConfig(directory, null, { ...builderConfig(registry, neuro), extraResources: [{ from: resources, to: 'offline' }] });
  assert.deepEqual(config.extraResources, [{ from: resources, to: 'offline' }]);
  assert.equal(config.appId, 'org.neurodesk.webapps', 'installed suites keep updating');
  assert.equal(config.productName, 'Neurodesk Webapps');
  assert.equal(config.executableName, 'neurodesk-webapps');
  assert.equal(config.artifactName, 'webapps-${version}-${os}-${arch}.${ext}');
  assert.equal(config.extraMetadata, undefined, 'installed suites keep their profile directory');
});

test('each catalogue suite builds under its own identity, so suites install side by side', async (t) => {
  t.mock.method(builderRequire('builder-util').log, 'info', console.error);
  const configs = await Promise.all(registry.site.catalogs.map(catalog => getConfig(directory, null, builderConfig(registry, catalog))));
  for (const key of ['appId', 'productName', 'executableName', 'artifactName']) {
    assert.equal(new Set(configs.map(config => config[key])).size, configs.length, key);
  }
  const msk = configs[registry.site.catalogs.findIndex(catalog => catalog.id === 'msk')];
  assert.equal(msk.appId, 'org.sciget.msk');
  assert.equal(msk.productName, 'MSK Webapps');
  assert.equal(msk.executableName, 'msk-webapps');
  assert.equal(msk.artifactName, 'msk-webapps-${version}-${os}-${arch}.${ext}');
  assert.equal(msk.extraMetadata.productName, 'MSK Webapps', 'Electron gives the suite its own profile directory');
});
