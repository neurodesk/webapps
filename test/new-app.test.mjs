import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { findApp, loadAppsRegistry, repoRoot } from '../scripts/lib/apps-registry.mjs';

const script = join(repoRoot, 'scripts', 'new-app.mjs');
const sourceRegistry = join(repoRoot, 'registry', 'apps.yml');
const run = promisify(execFile);

// A hermetic copy of the parts of the repo the scaffolder touches: the
// template and the registry. Everything else (apps/**) starts empty.
async function makeRepo(t) {
  const root = await mkdtemp(join(tmpdir(), 'new-app-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(join(repoRoot, 'templates', 'app-template'), join(root, 'templates', 'app-template'), {
    recursive: true,
  });
  await cp(sourceRegistry, join(root, 'registry', 'apps.yml'));
  await cp(join(repoRoot, 'registry', 'app-information.yml'), join(root, 'registry', 'app-information.yml'));
  for (const filename of ['standalone.json', 'offline-assets.sources.json', 'offline-assets.lock.json']) {
    await cp(join(repoRoot, 'registry', filename), join(root, 'registry', filename));
  }
  return root;
}

async function newApp(root, args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [script, ...args], { cwd: root });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test('default invocation (pnpm new-app <name>) scaffolds and validates', async (t) => {
  const root = await makeRepo(t);
  const result = await newApp(root, ['demo-app']);
  assert.equal(result.code, 0, result.stderr);
  for (const filename of ['standalone.json', 'offline-assets.sources.json', 'offline-assets.lock.json']) {
    const catalog = JSON.parse(await readFile(join(root, 'registry', filename)));
    assert.ok(Object.hasOwn(catalog.apps, 'demo-app'));
  }

  const registry = await loadAppsRegistry(join(root, 'registry', 'apps.yml'));
  const app = findApp(registry, 'demo-app');
  assert.equal(app.path, 'demo-app');
  assert.equal(app.title, 'demo-app');
  assert.equal(app.runtime, 'react-vite');
  assert.equal(app.shell, 'imaging-workspace');
  assert.deepEqual(app.categories, ['data-preparation']);
  assert.equal(app.support_status, 'experimental');
  assert.equal(app.source, 'neurodesk/webapps@local');
  assert.deepEqual([...app.keywords], ['TODO']);
  assert.deepEqual([...app.ci.toolchains], ['node']);
  assert.equal(app.ci.release, false);
  assert.equal(app.ci.browser_test, true);
  const examples = JSON.parse(await readFile(join(root, 'apps/demo-app/examples.json')));
  assert.equal(examples[0].id, 't1');
  const offline = JSON.parse(await readFile(join(root, 'registry/offline-assets.lock.json')));
  assert.deepEqual(offline.apps['demo-app'], examples.map(example => example.url));
  assert.ok(offline.assets[examples[0].url]);

  const packageJson = JSON.parse(await readFile(join(root, 'apps', 'demo-app', 'package.json'), 'utf8'));
  assert.equal(packageJson.name, 'demo-app');
  assert.match(packageJson.version, /^0\.0\.\d{8}$/);
  const { loadAppInformation } = await import('../scripts/lib/app-information.mjs');
  const information = await loadAppInformation(registry, join(root, 'registry', 'app-information.yml'));
  assert.ok(information.apps['demo-app'], 'scaffold seeds an app-information entry');
  assert.equal(information.apps['demo-app'].packages[0].name, 'NiiVue');
  assert.equal(
    packageJson.scripts.build,
    'vite build && node ../../scripts/theme-app-dist.mjs --app demo-app',
  );

  const viteConfig = await readFile(join(root, 'apps', 'demo-app', 'vite.config.js'), 'utf8');
  const main = await readFile(join(root, 'apps', 'demo-app', 'src', 'main.js'), 'utf8');
  const html = await readFile(join(root, 'apps', 'demo-app', 'index.html'), 'utf8');
  assert.match(viteConfig, /neurodeskViteConfig/);
  assert.match(viteConfig, /appId:\s*["']demo-app["']/);
  assert.match(main, /controlsContract/);
  for (const id of ['aboutBtn', 'privacyBtn']) {
    assert.match(html, new RegExp(`id=["']${id}["']`), id);
  }
});

test('flags select runtime, shell, category, and catalog text', async (t) => {
  const root = await makeRepo(t);
  const result = await newApp(root, [
    'demo-app',
    '--runtime', 'vite-webgpu',
    '--shell', 'react',
    '--category', 'quality-control',
    '--title', 'Demo App',
    '--description', 'Demonstrates the scaffolder: flags, validation, and more.',
    '--keywords', 'demo, scaffold ,test',
  ]);
  assert.equal(result.code, 0, result.stderr);

  const registry = await loadAppsRegistry(join(root, 'registry', 'apps.yml'));
  const app = findApp(registry, 'demo-app');
  assert.equal(app.runtime, 'vite-webgpu');
  assert.equal(app.shell, 'react');
  assert.deepEqual(app.categories, ['quality-control']);
  assert.equal(app.title, 'Demo App');
  assert.equal(app.description, 'Demonstrates the scaffolder: flags, validation, and more.');
  assert.deepEqual([...app.keywords], ['demo', 'scaffold', 'test']);
});

test('Rust runtimes declare the rust-wasm toolchain the loader requires', async (t) => {
  const root = await makeRepo(t);
  const result = await newApp(root, ['demo-app', '--runtime', 'static-esm-rust']);
  assert.equal(result.code, 0, result.stderr);
  const registry = await loadAppsRegistry(join(root, 'registry', 'apps.yml'));
  assert.deepEqual([...findApp(registry, 'demo-app').ci.toolchains], ['node', 'rust-wasm']);
});

test('registry comments and existing formatting survive the append', async (t) => {
  const root = await makeRepo(t);
  const before = await readFile(sourceRegistry, 'utf8');
  const result = await newApp(root, ['demo-app']);
  assert.equal(result.code, 0, result.stderr);

  const after = await readFile(join(root, 'registry', 'apps.yml'), 'utf8');
  assert.ok(before.startsWith('# Canonical catalog'), 'fixture must start with the comment block');
  assert.ok(after.startsWith(before), 'existing content, including the header comments, is byte-identical');
  assert.ok(after.includes('\n  - id: demo-app\n    path: demo-app\n'));
  assert.ok(after.includes('    keywords: [TODO]\n'), 'new inline sequences use the [a, b] style');
  assert.ok(after.includes('      toolchains: [node]\n'));
  assert.ok(after.endsWith('\n'));
});

test('an invalid --runtime is rejected and nothing is written', async (t) => {
  const root = await makeRepo(t);
  const before = await readFile(join(root, 'registry', 'apps.yml'), 'utf8');
  const result = await newApp(root, ['demo-app', '--runtime', 'bogus']);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Invalid --runtime 'bogus'/);
  assert.match(result.stderr, /react-vite/);
  assert.equal(await readFile(join(root, 'registry', 'apps.yml'), 'utf8'), before);
  assert.equal(await exists(join(root, 'apps', 'demo-app')), false);
});

test('invalid --shell and --category are rejected against the loader enums', async (t) => {
  const root = await makeRepo(t);
  const shell = await newApp(root, ['demo-app', '--shell', 'bogus']);
  assert.notEqual(shell.code, 0);
  assert.match(shell.stderr, /Invalid --shell 'bogus'/);
  const category = await newApp(root, ['demo-app', '--category', 'bogus']);
  assert.notEqual(category.code, 0);
  assert.match(category.stderr, /Invalid --category 'bogus'/);
  assert.match(category.stderr, /data-preparation/);
  assert.equal(await exists(join(root, 'apps', 'demo-app')), false);
});

test('a registry the loader rejects leaves registry and apps/ untouched', async (t) => {
  const root = await makeRepo(t);
  const registryPath = join(root, 'registry', 'apps.yml');
  const before = await readFile(registryPath, 'utf8');
  const existing = (await loadAppsRegistry(registryPath)).apps[0].id;

  // The id is not scaffolded in the temp repo, so only the loader's duplicate
  // check can catch it.
  const result = await newApp(root, [existing]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /does not validate/);
  assert.match(result.stderr, new RegExp(`duplicate app id: ${existing}`));
  assert.equal(await readFile(registryPath, 'utf8'), before);
  assert.equal(await exists(join(root, 'apps', existing)), false);
});

test('bad names and unknown flags print usage', async (t) => {
  const root = await makeRepo(t);
  for (const args of [[], ['Bad_Name'], ['demo-app', '--nope']]) {
    const result = await newApp(root, args);
    assert.notEqual(result.code, 0, JSON.stringify(args));
    assert.match(result.stderr, /Usage: pnpm new-app <name>/);
  }
  assert.equal(await exists(join(root, 'apps', 'demo-app')), false);
});
