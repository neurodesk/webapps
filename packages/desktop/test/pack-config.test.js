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
    return { appId: config.appId, productName: config.productName, executableName: config.executableName, artifactName: config.artifactName };
  };
  assert.deepEqual(await named('neuro'), { appId: build.appId, productName: build.productName, executableName: 'neurodesk-webapps', artifactName: build.artifactName });
  assert.deepEqual(await named('microscopy'), {
    appId: 'org.sciget.microscopyapps',
    productName: 'Microscopy Webapps',
    executableName: 'microscopy-webapps',
    artifactName: 'webapps-microscopy-${version}-${os}-${arch}.${ext}',
  });
});
