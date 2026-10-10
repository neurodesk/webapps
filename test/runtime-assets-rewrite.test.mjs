import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { loadAppsRegistry } from '../scripts/lib/apps-registry.mjs';
import { assembleRuntimeAssetStore } from '../scripts/lib/runtime-assets.mjs';

async function prepareParameterRuntimeFixture(repoRoot) {
  await cp(new URL('../packages/components/src/automation/parameters.js', import.meta.url), join(repoRoot, 'packages/components/src/automation/parameters.js'), { recursive: true });
  await symlink(new URL('../packages/components/node_modules', import.meta.url).pathname, join(repoRoot, 'packages/components/node_modules'), 'dir');
}

test('composite rewrite gives ONNX Runtime an absolute WASM base URL', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-assets-rewrite-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const sourceRoot = new URL('../apps/', import.meta.url);
  const repoRoot = join(root, 'repo');
  const siteDist = join(root, 'site');
  const apps = (await loadAppsRegistry()).apps.filter(app =>
    ['musclemap', 'vesselboost', 'spinalcordtoolbox', 'calmar', 'seedseg'].includes(app.id));
  const loaders = [
    { name: 'ort.webgpu.min.js', sourceApp: 'musclemap' },
    { name: 'ort.webgpu.bundle.min.mjs', sourceApp: 'calmar' },
    { name: 'ort.min.js', sourceApp: 'calmar' },
  ];

  await prepareParameterRuntimeFixture(repoRoot);
  await mkdir(join(repoRoot, 'runtime-assets'), { recursive: true });
  await mkdir(join(repoRoot, 'packages', 'components', 'src'), { recursive: true });
  await writeFile(join(repoRoot, 'packages', 'components', 'src', 'index.js'), '');

  for (const app of apps) {
    const appDist = join(siteDist, app.path);
    await mkdir(join(appDist, 'js'), { recursive: true });
    const worker = await readFile(new URL(`${app.id}/web/js/inference-worker.js`, sourceRoot), 'utf8');
    await writeFile(join(appDist, 'js', 'inference-worker.js'), worker);
  }

  for (const loader of loaders) {
    const loaderDir = join(siteDist, apps.find((app) => app.id === loader.sourceApp).path, 'wasm');
    await mkdir(loaderDir, { recursive: true });
    await writeFile(join(loaderDir, loader.name), `placeholder ${loader.name}`);
  }

  for (const app of apps) {
    await mkdir(join(siteDist, app.path, 'wasm'), { recursive: true });
    await writeFile(join(siteDist, app.path, 'wasm', 'ort.webgpu.bundle.min.mjs'), 'placeholder ort.webgpu.bundle.min.mjs');
  }

  await writeFile(join(repoRoot, 'runtime-assets', 'manifest.json'), JSON.stringify({
    schema_version: 1,
    families: [{
      id: 'ort-web',
      version: '1.21.0',
      target: 'ort-web/1.21.0',
      files: loaders.map((loader) => ({
        name: loader.name,
        source_app: loader.sourceApp,
        source: `wasm/${loader.name}`,
        sha256: createHash('sha256').update(`placeholder ${loader.name}`).digest('hex'),
      })),
    }],
  }));

  await assembleRuntimeAssetStore({
    repoRoot,
    siteDist,
    registry: { apps },
  });

  for (const app of apps) {
    const worker = await readFile(join(siteDist, app.path, 'js', 'inference-worker.js'), 'utf8');
    assert.match(worker, /\.\.\/wasm\/ort/);
    assert.doesNotMatch(worker, /_runtime\/ort-web/);
    await readFile(join(siteDist, app.path, 'wasm', 'ort.webgpu.bundle.min.mjs'));

    const assignment = worker.match(/ort\.env\.wasm\.wasmPaths\s*=\s*[^;]+;/)?.[0];
    assert.ok(assignment, `${app.id} worker is missing its wasmPaths assignment`);

    for (const [workerUrl, expectedRuntimeUrl] of [
      [
        `https://example.test/${app.path}/js/inference-worker.js`,
        `https://example.test/${app.path}/wasm/`,
      ],
      [
        `https://example.test/webapps/${app.path}/js/inference-worker.js`,
        `https://example.test/webapps/${app.path}/wasm/`,
      ],
    ]) {
      const context = {
        ort: { env: { wasm: {} } },
        self: { location: { href: workerUrl } },
        URL,
      };
      vm.runInNewContext(assignment, context);
      assert.equal(context.ort.env.wasm.wasmPaths, expectedRuntimeUrl, app.id);
      assert.doesNotMatch(context.ort.env.wasm.wasmPaths, /_runtime\/_runtime/, app.id);
    }
  }

  const missingScope = { ...apps[0], app_scoped_runtime_families: [] };
  await assert.rejects(assembleRuntimeAssetStore({
    repoRoot,
    siteDist,
    registry: { apps: apps.map(app => app.id === missingScope.id ? missingScope : app) },
  }), /threaded ONNX Runtime requires app_scoped_runtime_families/);
});

test('composite rewrite preserves vendored component file suffixes before removing app copies', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'component-runtime-rewrite-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const repoRoot = join(root, 'repo');
  const siteDist = join(root, 'site');
  const appDist = join(siteDist, 'calmar');
  await prepareParameterRuntimeFixture(repoRoot);
  await mkdir(join(repoRoot, 'runtime-assets'), { recursive: true });
  await mkdir(join(repoRoot, 'packages', 'components', 'src', 'styles'), { recursive: true });
  await mkdir(join(appDist, 'js'), { recursive: true });
  await mkdir(join(appDist, 'vendor', 'webapp-components', 'src'), { recursive: true });
  await writeFile(join(repoRoot, 'runtime-assets', 'manifest.json'), JSON.stringify({
    schema_version: 1,
    families: [],
  }));
  await writeFile(join(repoRoot, 'packages', 'components', 'src', 'index.js'), 'export {};');
  await writeFile(join(repoRoot, 'packages', 'components', 'src', 'styles', 'base.css'), ':root {}');
  await writeFile(join(appDist, 'index.html'), `
    <script type="importmap">{"imports":{"@neurodesk/webapp-components":"./vendor/webapp-components/src/index.js"}}</script>
    <link rel="stylesheet" href="vendor/webapp-components/src/styles/base.css">
  `);
  await writeFile(
    join(appDist, 'js', 'worker.js'),
    "import '../vendor/webapp-components/src/index.js';",
  );

  await assembleRuntimeAssetStore({
    repoRoot,
    siteDist,
    registry: { apps: [{ id: 'calmar', path: 'calmar' }] },
  });

  const parametersPath = join(siteDist, '_runtime/webapp-components/0.1.2/src/automation/parameters.js');
  const { operationParametersSchema } = await import(pathToFileURL(parametersPath));
  const schema = operationParametersSchema({ threshold: { type: 'number', multipleOf: 0.01, default: 0.15 } });
  assert.deepEqual(schema.parse(undefined), { threshold: 0.15 });
  assert.deepEqual(schema.parse({ threshold: undefined }), { threshold: 0.15 });
  assert.equal(schema.safeParse({ threshold: 0.150000000001 }).success, false);
  assert.equal(schema.safeParse({ invented: undefined }).success, false);

  const html = await readFile(join(appDist, 'index.html'), 'utf8');
  const worker = await readFile(join(appDist, 'js', 'worker.js'), 'utf8');
  assert.match(html, /\.\.\/_runtime\/webapp-components\/0\.1\.2\/src\/index\.js/);
  assert.match(html, /\.\.\/_runtime\/webapp-components\/0\.1\.2\/src\/styles\/base\.css/);
  assert.match(worker, /\.\.\/\.\.\/_runtime\/webapp-components\/0\.1\.2\/src\/index\.js/);
  assert.doesNotMatch(`${html}\n${worker}`, /vendor\/webapp-components/);
  await assert.rejects(access(join(appDist, 'vendor', 'webapp-components')));
});

test('declared single-file runtime deduplication rewrites references and removes the real app copy', async t => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-single-file-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const siteDist = join(root, 'dist');
  await prepareParameterRuntimeFixture(root);
  const body = Buffer.from('globalThis.viewerRuntime = true;');
  await mkdir(join(root, 'runtime-assets'), { recursive: true });
  await mkdir(join(root, 'packages/components/src'), { recursive: true });
  await mkdir(join(siteDist, 'vesselboost/runtime'), { recursive: true });
  await writeFile(join(siteDist, 'vesselboost/runtime/viewer.js'), body);
  await writeFile(join(siteDist, 'vesselboost/index.html'), '<script src="./runtime/viewer.js"></script>');
  await writeFile(join(root, 'runtime-assets/manifest.json'), JSON.stringify({ schema_version: 1, families: [{ id: 'viewer', version: '1', target: 'viewer/1', deduplicate: true, files: [{ name: 'viewer.js', source_app: 'vesselboost', source: 'runtime/viewer.js', sha256: createHash('sha256').update(body).digest('hex') }] }] }));
  const registry = { apps: [{ id: 'vesselboost', path: 'vesselboost', app_scoped_runtime_families: [] }] };
  await assembleRuntimeAssetStore({ repoRoot: root, siteDist, registry });
  assert.equal(await readFile(join(siteDist, 'vesselboost/index.html'), 'utf8'), '<script src="../_runtime/viewer/1/viewer.js"></script>');
  assert.deepEqual(await readFile(join(siteDist, '_runtime/viewer/1/viewer.js')), body);
  await assert.rejects(readFile(join(siteDist, 'vesselboost/runtime/viewer.js')), { code: 'ENOENT' });
});
