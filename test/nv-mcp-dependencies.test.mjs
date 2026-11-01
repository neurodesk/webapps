import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { repoRoot } from '../scripts/lib/apps-registry.mjs';

const readJson = async path => JSON.parse(await readFile(join(repoRoot, path), 'utf8'));
const isMcp = name => name === '@niivue/nv-mcp' || name.startsWith('@modelcontextprotocol/');

// The package names `pnpm deploy --prod` installs for a workspace importer, read from the lockfile.
function productionClosure(lock, importer) {
  const names = new Set();
  const seen = new Set();
  const visit = (dependencies, owner, from) => {
    for (const [name, entry] of Object.entries(dependencies ?? {})) {
      const version = String(typeof entry === 'string' ? entry : entry.version);
      names.add(name);
      if (version.startsWith('link:')) {
        const path = posix.normalize(posix.join(from, version.slice('link:'.length)));
        if (seen.has(path)) continue;
        seen.add(path);
        const linked = lock.importers[path];
        assert.ok(linked, `${owner} links ${name} to ${path}, which pnpm-lock.yaml has no importer for`);
        visit({ ...linked.dependencies, ...linked.optionalDependencies }, path, path);
        continue;
      }
      // An npm: alias resolves to `name@version` itself rather than to a version of the alias.
      const key = [`${name}@${version}`, version].find(candidate => Object.hasOwn(lock.snapshots, candidate));
      assert.ok(key, `pnpm-lock.yaml resolves ${name} for ${owner} to ${version}, which has no snapshot`);
      names.add(key.replace(/\(.*$/, '').replace(/(.)@[^@]*$/, '$1'));
      if (seen.has(key)) continue;
      seen.add(key);
      const snapshot = lock.snapshots[key];
      visit({ ...snapshot?.dependencies, ...snapshot?.optionalDependencies }, key, from);
    }
  };
  assert.ok(lock.importers[importer], `pnpm-lock.yaml has no importer ${importer}`);
  visit({ ...lock.importers[importer].dependencies, ...lock.importers[importer].optionalDependencies }, importer, importer);
  return names;
}

test('command-line releases install no MCP code, while the desktop and neurodesk-mcp keep it', async () => {
  const lock = parse(await readFile(join(repoRoot, 'pnpm-lock.yaml'), 'utf8'));
  // An external release (release.json with a tag) is built elsewhere and installs nothing from here.
  const releases = (await readdir(join(repoRoot, 'packages'))).filter(id => existsSync(join(repoRoot, 'packages', id, 'release.json'))
    && !JSON.parse(readFileSync(join(repoRoot, 'packages', id, 'release.json'), 'utf8')).tag);
  assert.ok(releases.length > 0, 'command-line release targets were found');
  let withComponents = 0;
  for (const id of releases) {
    const closure = productionClosure(lock, `packages/${id}`);
    if (closure.has('@neurodesk/webapp-components')) withComponents++;
    assert.deepEqual([...closure].filter(isMcp), [], `${id}'s production install`);
  }
  assert.ok(withComponents > 0, 'some command-line release installs the components');
  for (const server of ['packages/desktop', 'packages/agent-server']) {
    const mcp = [...productionClosure(lock, server)].filter(isMcp);
    assert.ok(mcp.includes('@niivue/nv-mcp') && mcp.some(name => name.startsWith('@modelcontextprotocol/')), `${server}'s production install serves nv-mcp's tools`);
  }
});

test('the desktop, neurodesk-mcp and the composite runtime pin the nv-mcp that app builds bundle', async () => {
  const pin = (await readJson('packages/components/package.json')).devDependencies['@niivue/nv-mcp'];
  const family = (await readJson('runtime-assets/manifest.json')).families.find(candidate => candidate.id === 'nv-mcp');
  assert.deepEqual({
    desktop: (await readJson('packages/desktop/package.json')).dependencies['@niivue/nv-mcp'],
    'agent-server': (await readJson('packages/agent-server/package.json')).dependencies['@niivue/nv-mcp'],
    'runtime family': [family?.version, family?.target],
  }, {
    desktop: pin,
    'agent-server': pin,
    'runtime family': [pin, `nv-mcp/${pin}`],
  }, `every nv-mcp pin must equal the components' devDependency ${pin}`);
});
