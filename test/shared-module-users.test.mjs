import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { createAppPlan } from '../scripts/lib/app-plan.mjs';
import { loadAppsRegistry, repoRoot } from '../scripts/lib/apps-registry.mjs';
import { LISTED_READS, SHARED_MODULE_PACKAGE, sharedModuleUsers } from '../scripts/lib/shared-module-users.mjs';
import { SHELL_COMPONENTS } from '../scripts/lib/standalone.mjs';
import { loadConservativeWorkspaceGraph } from '../scripts/lib/workspace-graph.mjs';

const SHARED = 'packages/shared';

// A repository with one shared package and the users `files` describes; every
// user gets a graph edge to the package, as a workspace dependency gives it.
async function fixture(files, users, listed = []) {
  const root = await mkdtemp(join(tmpdir(), 'shared-module-users-'));
  const all = {
    [`${SHARED}/package.json`]: JSON.stringify({
      name: '@scope/shared',
      exports: { '.': './src/index.js', './tiff': { types: './src/tiff-api.d.ts', default: './src/tiff.js' }, './fft': './src/fft.js', './lut': './src/lut.json', './base.css': './src/base.css' },
    }),
    [`${SHARED}/src/index.js`]: "export * from './fft.js';\n",
    [`${SHARED}/src/tiff.js`]: "import { strips } from './strips.js';\nexport const read = strips;\n",
    [`${SHARED}/src/strips.js`]: 'export const strips = 1;\n',
    [`${SHARED}/src/tiff-api.d.ts`]: 'export const read: number;\n',
    [`${SHARED}/src/fft.js`]: "export const fft = new URL('./lut.json', import.meta.url);\n",
    [`${SHARED}/src/lut.json`]: '{}\n',
    [`${SHARED}/src/base.css`]: 'body {}\n',
    [`${SHARED}/src/extra/one.js`]: 'export const one = 1;\n',
    [`${SHARED}/test/fixtures/a.tif`]: '',
    // moduleClosure lists the workspace packages of both trees.
    'exes/.keep': '',
    ...files,
  };
  for (const [path, text] of Object.entries(all)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  const graph = { edges: new Map([[SHARED, new Set()], ...users.map((user) => [user, new Set([SHARED])])]) };
  const usersOf = sharedModuleUsers(root, graph, SHARED, listed);
  return { usersOf: (path) => usersOf(`${SHARED}/${path}`), [Symbol.asyncDispose]: () => rm(root, { recursive: true, force: true }) };
}

test('a module reaches the users whose imports load it, through the package and through each other', async () => {
  await using repo = await fixture({
    'apps/stack/package.json': JSON.stringify({ dependencies: { '@scope/shared': 'workspace:*' } }),
    'apps/stack/src/main.js': "import { read } from '@scope/shared/tiff';\n",
    'apps/spectrum/package.json': JSON.stringify({ dependencies: { '@scope/shared': 'workspace:*' } }),
    'apps/spectrum/src/main.js': "const { fft } = await import('@scope/shared');\n",
    'apps/idle/package.json': JSON.stringify({ dependencies: { '@scope/shared': 'workspace:*' } }),
    'apps/idle/src/main.js': 'export {};\n',
  }, ['apps/stack', 'apps/spectrum', 'apps/idle']);
  assert.deepEqual(repo.usersOf('src/tiff.js'), ['apps/stack']);
  // strips.js is loaded only through tiff.js.
  assert.deepEqual(repo.usersOf('src/strips.js'), ['apps/stack']);
  assert.deepEqual(repo.usersOf('src/fft.js'), ['apps/spectrum']);
  // A file read through new URL(..., import.meta.url) is loaded with its module.
  assert.deepEqual(repo.usersOf('src/lut.json'), ['apps/spectrum']);
  // A dependency declaration alone loads nothing.
  assert.deepEqual(repo.usersOf('src/extra/one.js'), []);
});

test('a declaration file follows the module it types, and other files stay with the whole package', async () => {
  await using repo = await fixture({ 'apps/stack/src/main.ts': "import { read } from '@scope/shared/tiff';\n" }, ['apps/stack']);
  assert.deepEqual(repo.usersOf('src/tiff-api.d.ts'), ['apps/stack']);
  assert.deepEqual(repo.usersOf('src/strips.d.ts'), ['apps/stack']);
  for (const path of ['src/base.css', 'package.json', 'test/fixtures/a.tif', 'scripts/build.mjs']) assert.equal(repo.usersOf(path), null, path);
});

test('a deleted module still reaches the users that import it', async () => {
  await using repo = await fixture({
    [`${SHARED}/src/tiff.js`]: "import { strips } from './gone.js';\n",
    'apps/stack/src/main.js': "import '@scope/shared/tiff';\n",
    'apps/other/src/main.js': "import '@scope/shared/fft';\n",
  }, ['apps/stack', 'apps/other']);
  assert.deepEqual(repo.usersOf('src/gone.js'), ['apps/stack']);
});

test('a reference that names no single file loads the directory it names, or the whole package', async () => {
  const cases = {
    // Computed specifiers and import-map prefixes.
    'apps/computed/src/main.js': 'await import(`@scope/shared/${name}`);\n',
    'apps/prefix/index.html': '<script type="importmap">{ "imports": { "@scope/shared/": "./vendor/shared/src/" } }</script>\n',
    'apps/missing/src/main.js': "import '@scope/shared/not-exported';\n",
    // Paths: the package root, its source directory, a join of its parts.
    'apps/root/build.mjs': "cp(join(repo, 'packages/shared'), out);\n",
    'apps/joined/build.mjs': "cp(join(repo, 'packages', 'shared', 'src'), out);\n",
    'packages/sibling/build.mjs': "cp(new URL('../shared/', import.meta.url), out);\n",
  };
  const users = Object.keys(cases).map((path) => path.split('/').slice(0, 2).join('/'));
  await using repo = await fixture({
    ...cases,
    'apps/directory/build.mjs': "cp(join(repo, 'packages/shared/src/extra'), out);\n",
    'apps/fixtures/e2e/spec.js': "const dir = '../../../packages/shared/test/fixtures/';\n",
    'apps/prose/src/main.js': "// The reader lives in packages/shared/src/fft.js.\n",
    // Another directory called `shared` is not the package.
    'apps/own/src/main.js': "import '../shared/helper.js';\n",
  }, [...users, 'apps/directory', 'apps/fixtures', 'apps/prose', 'apps/own']);
  assert.deepEqual(repo.usersOf('src/tiff.js'), users);
  assert.deepEqual(repo.usersOf('src/extra/one.js'), [...users, 'apps/directory']);
  assert.deepEqual(repo.usersOf('src/fft.js'), [...users, 'apps/prose']);
});

test('a script that reads a listed set of modules loads those, until its text stops matching the list', async () => {
  const script = "for (const name of LIST) cp(join(repo, 'packages/shared/src', name), out);\n";
  const listed = [{ file: 'scripts/copy.mjs', expression: "join(repo, 'packages/shared/src', name)", modules: ['strips.js'] }];
  {
    await using repo = await fixture({ 'scripts/copy.mjs': script }, ['scripts/copy.mjs'], listed);
    assert.deepEqual(repo.usersOf('src/strips.js'), ['scripts/copy.mjs']);
    assert.deepEqual(repo.usersOf('src/fft.js'), []);
  }
  {
    // A second reference the list does not cover.
    await using repo = await fixture({ 'scripts/copy.mjs': `${script}cp(join(repo, 'packages/shared/src'), other);\n` }, ['scripts/copy.mjs'], listed);
    assert.deepEqual(repo.usersOf('src/fft.js'), ['scripts/copy.mjs']);
  }
  {
    // The expression was rewritten: the list no longer describes the script.
    await using repo = await fixture({ 'scripts/copy.mjs': "cp(join(repo, 'packages/shared/src', file), out);\n" }, ['scripts/copy.mjs'], listed);
    assert.deepEqual(repo.usersOf('src/fft.js'), ['scripts/copy.mjs']);
  }
});

const registry = await loadAppsRegistry();
const graph = await loadConservativeWorkspaceGraph(repoRoot);
const selected = (path, manifests = new Map()) => createAppPlan(registry, [path], graph, manifests).selected.map((app) => app.id);

test('each listed read still describes its script', async () => {
  for (const { file, expression, modules } of LISTED_READS) {
    const text = await readFile(join(repoRoot, file), 'utf8');
    assert.equal(text.split(expression).length, 2, `${file} holds ${expression} exactly once`);
    for (const module of modules) await readFile(join(repoRoot, SHARED_MODULE_PACKAGE, 'src', module));
  }
  // The modules the import-map bundler names are the ones listed for it.
  const bundler = LISTED_READS.find(({ file }) => file === 'scripts/lib/operation-parameters-runtime.mjs');
  const bundled = [...(await readFile(join(repoRoot, bundler.file), 'utf8')).matchAll(/\bmodule: '([^']+)'/g)].map(([, module]) => module);
  assert.deepEqual(bundled.sort(), [...bundler.modules].sort());
  // The shell loads its components by name from the directory those scripts serve.
  const shell = await readFile(join(repoRoot, 'site/app-shell.js'), 'utf8');
  const loaded = [...shell.matchAll(/new URL\('([^']+)', metadata\.componentsHref\)/g)].map(([, module]) => module);
  assert.ok(loaded.length > 0);
  assert.deepEqual(loaded.filter((module) => !SHELL_COMPONENTS.includes(module)), []);
});

test('a change to one component module selects the apps that load it', () => {
  const tiff = selected(`${SHARED_MODULE_PACKAGE}/src/file-io/tiff.js`);
  for (const app of ['stitching', 'deconvolution', 'omezarr-convert', 'calmar']) assert.ok(tiff.includes(app), app);
  for (const app of ['dcm2niix', 'niimath', 'lcmodel', 'synthsr']) assert.ok(!tiff.includes(app), app);
  assert.ok(tiff.length < registry.apps.length / 2, `${tiff.length} apps`);
  assert.deepEqual(selected(`${SHARED_MODULE_PACKAGE}/src/file-io/tiff.d.ts`), tiff);
  // What the shell and every sidebar load still selects the catalogue.
  for (const path of ['src/ui/renderStandalone.js', 'src/ui/index.js', 'src/styles/base.css', 'scripts/build-showcase.mjs']) {
    assert.equal(selected(`${SHARED_MODULE_PACKAGE}/${path}`).length, registry.apps.length, path);
  }
});

test('every component import an app writes selects that app', async () => {
  const manifest = JSON.parse(await readFile(join(repoRoot, SHARED_MODULE_PACKAGE, 'package.json'), 'utf8'));
  const sources = async function* (dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!['node_modules', 'dist', 'vendor', 'public'].includes(entry.name)) yield* sources(join(dir, entry.name));
      } else if (/\.(?:[cm]?[jt]sx?|html)$/.test(entry.name)) {
        yield join(dir, entry.name);
      }
    }
  };
  const selections = new Map();
  let checked = 0;
  for (const app of registry.apps) {
    for await (const file of sources(join(repoRoot, 'apps', app.id))) {
      for (const [, subpath] of (await readFile(file, 'utf8')).matchAll(/['"]@neurodesk\/webapp-components(\/[\w./-]+)?['"]/g)) {
        const entry = manifest.exports[`.${subpath ?? ''}`];
        const target = typeof entry === 'string' ? entry : entry?.default;
        if (!target?.endsWith('.js')) continue;
        const path = join(SHARED_MODULE_PACKAGE, target);
        if (!selections.has(path)) selections.set(path, selected(path));
        assert.ok(selections.get(path).includes(app.id), `${file} imports ${path}`);
        checked += 1;
      }
    }
  }
  assert.ok(checked > 100, `${checked} imports checked`);
});

test('a package manifest that only gains exports selects nothing', () => {
  const path = `${SHARED_MODULE_PACKAGE}/package.json`;
  const before = { name: '@neurodesk/webapp-components', exports: { './ui': './src/ui/index.js' }, dependencies: { geotiff: '3.0.0' } };
  const pair = (after) => new Map([[path, { before: JSON.stringify(before), after: JSON.stringify(after) }]]);
  assert.deepEqual(selected(path, pair({ ...before, exports: { ...before.exports, './file-io/new': './src/file-io/new.js' } })), []);
  assert.equal(selected(path, pair({ ...before, dependencies: { geotiff: '3.1.0' } })).length, registry.apps.length);
  assert.equal(selected(path, pair({ ...before, exports: { './ui': './src/ui/other.js' } })).length, registry.apps.length);
  assert.equal(selected(path).length, registry.apps.length);
});
