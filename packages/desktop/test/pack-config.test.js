import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const directory = resolve(import.meta.dirname, '..');
const require = createRequire(resolve(directory, 'package.json'));
const builderRequire = createRequire(require.resolve('electron-builder'));
const { getConfig } = builderRequire('app-builder-lib/out/util/config/config.js');

test('electron-builder copies exactly one selected resource directory', async () => {
  for (const name of ['resources', 'resources-light']) {
    const resources = resolve(directory, name);
    const config = await getConfig(directory, null, { extraResources: [{ from: resources, to: 'offline' }] });
    assert.deepEqual(config.extraResources, [{ from: resources, to: 'offline' }]);
  }
});
