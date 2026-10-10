import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const packages = new Map();
for (const name of await readdir(root)) {
  const manifest = await readFile(new URL(`${name}/package.json`, root), 'utf8').catch(() => null);
  if (manifest) {
    const pkg = JSON.parse(manifest);
    packages.set(pkg.name, pkg);
  }
}

function productionDependencies(name, seen = new Set()) {
  for (const dependency of Object.keys(packages.get(name)?.dependencies ?? {})) {
    if (seen.has(dependency)) continue;
    seen.add(dependency);
    productionDependencies(dependency, seen);
  }
  return seen;
}

test('the Node drivers have no production or peer dependencies', () => {
  const pkg = packages.get('@neurodesk/node-drivers');
  assert.deepEqual(pkg.dependencies ?? {}, {});
  assert.deepEqual(pkg.peerDependencies ?? {}, {});
  assert.deepEqual(pkg.optionalDependencies ?? {}, {});
});

for (const name of ['brain-extraction', 'brain2print', 'browserqc', 'dwi2trx', 'edgereg']) {
  test(`${name} uses the standalone Node drivers without runtime-support`, () => {
    const dependencies = productionDependencies(`@neurodesk/${name}`);
    assert.ok(dependencies.has('@neurodesk/node-drivers'));
    assert.ok(!dependencies.has('@neurodesk/runtime-support'));
    if (name === 'brain-extraction' || name === 'browserqc') {
      assert.ok(!dependencies.has('@neurodesk/webapp-components'));
    }
  });
}
