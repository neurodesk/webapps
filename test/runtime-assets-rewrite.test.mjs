import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
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
    }, {
      id: 'ort-web-seedseg', version: '1.30.0', target: 'ort-web/1.30.0',
      files: [{ name: 'ort.webgpu.bundle.min.mjs', source_app: 'seedseg', source: 'wasm/ort.webgpu.bundle.min.mjs',
        sha256: createHash('sha256').update('placeholder ort.webgpu.bundle.min.mjs').digest('hex') }],
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
  await mkdir(join(repoRoot, 'packages', 'components', 'src', 'worker'), { recursive: true });
  await mkdir(join(appDist, 'js'), { recursive: true });
  await mkdir(join(appDist, 'vendor', 'webapp-components', 'src'), { recursive: true });
  const nestedModule = join(appDist, 'vendor', 'pipeline', 'src', 'segment.js');
  await mkdir(join(appDist, 'vendor', 'pipeline', 'src'), { recursive: true });
  await writeFile(join(repoRoot, 'runtime-assets', 'manifest.json'), JSON.stringify({
    schema_version: 1,
    families: [],
  }));
  await writeFile(join(repoRoot, 'packages', 'components', 'src', 'index.js'), 'export {};');
  await writeFile(join(repoRoot, 'packages', 'components', 'src', 'worker', 'index.js'), "export const sharedWorker = 'shared worker';");
  await writeFile(join(repoRoot, 'packages', 'components', 'src', 'styles', 'base.css'), ':root {}');
  await writeFile(nestedModule, "export { sharedWorker } from '../../../vendor/webapp-components/src/worker/index.js';");
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
  // A nested package must still import after deduplication removes its sibling component copy.
  assert.equal((await import(pathToFileURL(nestedModule))).sharedWorker, 'shared worker');
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

test('a shared lazy chunk is deduplicated beside vendored component sources of the same name', async t => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-lazy-chunk-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const siteDist = join(root, 'dist');
  await prepareParameterRuntimeFixture(root);
  await mkdir(join(root, 'runtime-assets'), { recursive: true });
  const chunk = Buffer.from('export const AgentClient = class {};');
  const facade = "export { AgentClient } from '@niivue/nv-mcp/browser';";
  await writeFile(join(root, 'packages/components/src/automation/nv-mcp.js'), facade);
  await writeFile(join(root, 'runtime-assets/manifest.json'), JSON.stringify({ schema_version: 1, families: [{
    id: 'nv-mcp', version: '1', target: 'nv-mcp/1', deduplicate: true,
    files: [{ name: 'nv-mcp.js', source_app: 'brain-extraction', source: 'assets/nv-mcp-DssI0BZx.js', sha256: createHash('sha256').update(chunk).digest('hex') }],
  }] }));
  await mkdir(join(siteDist, 'brain-extraction/assets'), { recursive: true });
  await writeFile(join(siteDist, 'brain-extraction/index.html'), '<html><head></head></html>');
  await writeFile(join(siteDist, 'brain-extraction/assets/nv-mcp-DssI0BZx.js'), chunk);
  await writeFile(join(siteDist, 'brain-extraction/assets/index-B-xnO4h2.js'), 'const client = () => import("./nv-mcp-DssI0BZx.js");');
  const vendored = join(siteDist, 'musclemap/vendor/webapp-components/src/automation');
  await mkdir(vendored, { recursive: true });
  await writeFile(join(siteDist, 'musclemap/index.html'), '<html><head></head></html>');
  await writeFile(join(vendored, 'nv-mcp.js'), facade);
  const registry = { apps: ['brain-extraction', 'musclemap'].map(id => ({ id, path: id, app_scoped_runtime_families: [] })) };

  await assembleRuntimeAssetStore({ repoRoot: root, siteDist, registry });

  assert.deepEqual(await readFile(join(siteDist, '_runtime/nv-mcp/1/nv-mcp.js')), chunk);
  await assert.rejects(access(join(siteDist, 'brain-extraction/assets/nv-mcp-DssI0BZx.js')), { code: 'ENOENT' });
  assert.equal(await readFile(join(siteDist, 'brain-extraction/assets/index-B-xnO4h2.js'), 'utf8'),
    'const client = () => import("../../_runtime/nv-mcp/1/nv-mcp.js");');
  await assert.rejects(access(join(siteDist, 'musclemap/vendor/webapp-components')), { code: 'ENOENT' });
  assert.equal(await readFile(join(siteDist, '_runtime/webapp-components/0.1.2/src/automation/nv-mcp.js'), 'utf8'),
    "export { AgentClient } from '../../../../nv-mcp/1/nv-mcp.js';", 'import-map apps load the client the bundled apps share');
});

test('a declared WASM runtime is shared across app-relative and root-relative worker references', async t => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-wasm-copies-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const siteDist = join(root, 'dist');
  await prepareParameterRuntimeFixture(root);
  await mkdir(join(root, 'runtime-assets'), { recursive: true });
  const body = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
  const name = 'dcm2niix.jpeg-CR3ddVLp.wasm';
  const apps = [
    { id: 'ants', path: 'ants', app_scoped_runtime_families: ['ort-web-asyncify'] },
    { id: 'synthseg', path: 'synthseg', app_scoped_runtime_families: [] },
  ];
  const workerPrefix = 'const empty = ""; const defaultName = "dcm2niix.jpeg.wasm"; ';
  const resetCopies = async () => {
    for (const app of apps) {
      const assets = join(siteDist, app.path, 'assets');
      await mkdir(assets, { recursive: true });
      await writeFile(join(siteDist, app.path, 'index.html'), '<html><head></head></html>');
      await writeFile(join(assets, name), body);
      const reference = app.id === 'ants' ? name : `/synthseg/assets/${name}`;
      await writeFile(join(assets, 'worker.jpeg.js'), `${workerPrefix}export const wasm = new URL("${reference}", import.meta.url);`);
      await writeFile(join(assets, 'ort-thread-worker.mjs'), 'export const localThreadWorker = true;');
      await writeFile(join(assets, 'unrelated.wasm'), body);
    }
  };
  await resetCopies();
  await writeFile(join(root, 'runtime-assets/manifest.json'), JSON.stringify({
    schema_version: 1,
    families: [{
      id: 'dcm2niix-jpeg', version: '1.2.0', target: 'dcm2niix-jpeg/1.2.0', deduplicate: true,
      files: [{ name: 'dcm2niix.jpeg.wasm', source_app: 'ants', source: `assets/${name}`, sha256: createHash('sha256').update(body).digest('hex') }],
    }],
  }));

  await assembleRuntimeAssetStore({ repoRoot: root, siteDist, registry: { apps } });

  assert.deepEqual(await readFile(join(siteDist, '_runtime/dcm2niix-jpeg/1.2.0/dcm2niix.jpeg.wasm')), body);
  for (const app of apps) {
    await assert.rejects(readFile(join(siteDist, app.path, 'assets', name)), { code: 'ENOENT' });
    const worker = await readFile(join(siteDist, app.path, 'assets/worker.jpeg.js'), 'utf8');
    assert.equal(worker, `${workerPrefix}export const wasm = new URL("../../_runtime/dcm2niix-jpeg/1.2.0/dcm2niix.jpeg.wasm", import.meta.url);`);
    const reference = worker.match(/new URL\("([^"]+)"/)?.[1];
    for (const base of ['https://example.test/', 'https://example.test/webapps/']) {
      const workerUrl = new URL(`${app.path}/assets/worker.jpeg.js`, base);
      assert.equal(new URL(reference, workerUrl).href,
        new URL('_runtime/dcm2niix-jpeg/1.2.0/dcm2niix.jpeg.wasm', base).href);
    }
    assert.equal(await readFile(join(siteDist, app.path, 'assets/ort-thread-worker.mjs'), 'utf8'), 'export const localThreadWorker = true;');
    assert.deepEqual(await readFile(join(siteDist, app.path, 'assets/unrelated.wasm')), body);
    const html = await readFile(join(siteDist, app.path, 'index.html'), 'utf8');
    const manifestName = html.match(/content="\.\/(runtime-cache-manifest\.[a-f0-9]{64}\.json)"/)[1];
    const cacheManifest = JSON.parse(await readFile(join(siteDist, app.path, manifestName), 'utf8'));
    assert.deepEqual(cacheManifest.assets.map(asset => asset.url).sort(), [
      '../_runtime/dcm2niix-jpeg/1.2.0/dcm2niix.jpeg.wasm',
      './assets/unrelated.wasm',
    ]);
    assert.ok(cacheManifest.assets.every(asset => asset.sha256 === createHash('sha256').update(body).digest('hex')));
  }

  await resetCopies();
  await writeFile(join(siteDist, 'synthseg/assets', name), 'different runtime bytes');
  await assert.rejects(assembleRuntimeAssetStore({ repoRoot: root, siteDist, registry: { apps } }), /Runtime asset checksum mismatch/);

  await resetCopies();
  apps[1].app_scoped_runtime_families.push('dcm2niix-jpeg');
  await assert.rejects(assembleRuntimeAssetStore({ repoRoot: root, siteDist, registry: { apps } }), /Cannot deduplicate scoped runtime dcm2niix-jpeg/);

  // A second pinned version of the same runtime claims only the copies with its bytes.
  apps[1].app_scoped_runtime_families.pop();
  await resetCopies();
  const newer = Buffer.from('newer runtime bytes');
  await writeFile(join(siteDist, 'synthseg/assets', name), newer);
  const manifest = JSON.parse(await readFile(join(root, 'runtime-assets/manifest.json'), 'utf8'));
  manifest.families.push({
    id: 'dcm2niix-jpeg-1.4', version: '1.4.0', target: 'dcm2niix-jpeg/1.4.0', deduplicate: true,
    files: [{ name: 'dcm2niix.jpeg.wasm', source_app: 'synthseg', source: `assets/${name}`, sha256: createHash('sha256').update(newer).digest('hex') }],
  });
  await writeFile(join(root, 'runtime-assets/manifest.json'), JSON.stringify(manifest));
  await assembleRuntimeAssetStore({ repoRoot: root, siteDist, registry: { apps } });
  assert.deepEqual(await readFile(join(siteDist, '_runtime/dcm2niix-jpeg/1.4.0/dcm2niix.jpeg.wasm')), newer);
  assert.match(await readFile(join(siteDist, 'ants/assets/worker.jpeg.js'), 'utf8'), /_runtime\/dcm2niix-jpeg\/1\.2\.0\//);
  assert.match(await readFile(join(siteDist, 'synthseg/assets/worker.jpeg.js'), 'utf8'), /_runtime\/dcm2niix-jpeg\/1\.4\.0\//);
});

test('asyncify shares its binary while keeping each pthread module in its app scope', async t => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-asyncify-copies-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const siteDist = join(root, 'dist');
  await prepareParameterRuntimeFixture(root);
  await mkdir(join(root, 'runtime-assets'), { recursive: true });
  const manifest = JSON.parse(await readFile(new URL('../runtime-assets/manifest.json', import.meta.url), 'utf8'));
  const families = manifest.families.filter(family => family.id.startsWith('ort-web-asyncify'));
  const wasm = families.flatMap(family => family.files).find(file => file.name.endsWith('.wasm'));
  const module = families.flatMap(family => family.files).find(file => file.name.endsWith('.mjs'));
  const binary = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
  const moduleSource = 'export const pthreadEntry = import.meta.url;';
  for (const family of families) {
    for (const file of family.files) {
      file.sha256 = createHash('sha256').update(file.name.endsWith('.wasm') ? binary : moduleSource).digest('hex');
    }
  }
  await writeFile(join(root, 'runtime-assets/manifest.json'), JSON.stringify({ schema_version: 1, families }));
  const apps = ['synthsr', 'fastprep'].map(id => ({ id, path: id, app_scoped_runtime_families: ['ort-web-asyncify'] }));
  for (const app of apps) {
    const assets = join(siteDist, app.path, 'assets');
    await mkdir(assets, { recursive: true });
    await writeFile(join(siteDist, app.path, 'index.html'), '<html><head></head></html>');
    await writeFile(join(assets, wasm.name), binary);
    await writeFile(join(assets, module.name), moduleSource);
    await writeFile(join(assets, 'inference-worker.js'), `export const paths = { wasm: new URL("./${wasm.name}", import.meta.url).href, mjs: new URL("./${module.name}", import.meta.url).href }; export const bare = "/${app.path}/assets/${wasm.name}";`);
  }
  await assembleRuntimeAssetStore({ repoRoot: root, siteDist, registry: { apps } });
  for (const app of apps) {
    await assert.rejects(access(join(siteDist, app.path, 'assets', wasm.name)), { code: 'ENOENT' });
    assert.equal(await readFile(join(siteDist, app.path, 'assets', module.name), 'utf8'), moduleSource);
    const source = await readFile(join(siteDist, app.path, 'assets/inference-worker.js'), 'utf8');
    const paths = [...source.matchAll(/new URL\("([^"]+)"/g)].map(match => match[1]);
    const bare = source.match(/export const bare = "([^"]+)"/)[1];
    for (const base of ['https://example.test/', 'https://example.test/webapps/']) {
      const workerUrl = new URL(`${app.path}/assets/inference-worker.js`, base);
      assert.equal(new URL(paths[0], workerUrl).href, new URL(`_runtime/ort-web/1.29.0-asyncify/${wasm.name}`, base).href);
      assert.equal(new URL(paths[1], workerUrl).href, new URL(`${app.path}/assets/${module.name}`, base).href);
      assert.equal(new URL(bare, workerUrl).href, new URL(`_runtime/ort-web/1.29.0-asyncify/${wasm.name}`, base).href);
    }
  }
  assert.deepEqual(await readFile(join(siteDist, '_runtime/ort-web/1.29.0-asyncify', wasm.name)), binary);
});

test('identical workspace styles share one file while different app CSS stays local', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'workspace-css-rewrite-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const siteDist = join(root, 'dist');
  await prepareParameterRuntimeFixture(root);
  await mkdir(join(root, 'runtime-assets'), { recursive: true });
  const module = 'export const shared = true;';
  const moduleHash = createHash('sha256').update(module).digest('hex');
  const css = '.nd-field { display: block; }';
  const hash = createHash('sha256').update(css).digest('hex');
  const apps = ['brainchop', 'other'].map(id => ({ id, path: id, app_scoped_runtime_families: [] }));
  for (const app of apps) {
    await mkdir(join(siteDist, app.path, 'assets'), { recursive: true });
    await writeFile(join(siteDist, app.path, 'assets', 'shared-12345678.js'), module);
    const name = app.id === 'brainchop' ? 'index-abcdefgh.css' : 'workspace-12345678.css';
    await writeFile(join(siteDist, app.path, 'assets', name), css);
    await writeFile(join(siteDist, app.path, 'assets', 'index-different.css'), `.custom-${app.id} { display: grid; }`);
    await writeFile(join(siteDist, app.path, 'index.html'), `<html><head><link rel="stylesheet" href="/${app.path}/assets/${name}"><script type="module" src="./assets/shared-12345678.js"></script></head></html>`);
  }
  await writeFile(join(root, 'runtime-assets/manifest.json'), JSON.stringify({ schema_version: 1, families: [{
    id: 'shared-module', target: 'module/test', deduplicate: true,
    files: [{ name: 'shared.js', source_app: 'brainchop', source: 'assets/shared-12345678.js', sha256: moduleHash }],

  }] }));
  await assembleRuntimeAssetStore({ repoRoot: root, siteDist, registry: { apps } });
  assert.equal(await readFile(join(siteDist, '_runtime/module/test/shared.js'), 'utf8'), module);
  assert.equal(await readFile(join(siteDist, `_runtime/styles/${hash}/shared.css`), 'utf8'), css);
  for (const app of apps) {
    assert.deepEqual(await readdir(join(siteDist, app.path, 'assets')), ['index-different.css']);
    const html = await readFile(join(siteDist, app.path, 'index.html'), 'utf8');
    const href = html.match(/rel="stylesheet" href="([^"]+)"/)[1];
    for (const base of ['https://example.test/', 'https://example.test/webapps/']) {
      const src = html.match(/type="module" src="([^"]+)"/)[1];
      assert.equal(new URL(src, `${base}${app.path}/`).href, `${base}_runtime/module/test/shared.js`);
      assert.equal(new URL(href, `${base}${app.path}/`).href, `${base}_runtime/styles/${hash}/shared.css`);
    }
  }
});

test('lazy chunks preload a deduplicated stylesheet from the shared store', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'workspace-css-preload-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const siteDist = join(root, 'dist');
  await prepareParameterRuntimeFixture(root);
  await mkdir(join(root, 'runtime-assets'), { recursive: true });
  await writeFile(join(root, 'runtime-assets/manifest.json'), JSON.stringify({ schema_version: 1, families: [] }));
  const css = '.nd-field { display: block; }';
  const hash = createHash('sha256').update(css).digest('hex');
  const apps = ['brainchop', 'other'].map(id => ({ id, path: id, app_scoped_runtime_families: [] }));
  for (const app of apps) {
    const assets = join(siteDist, app.path, 'assets');
    await mkdir(assets, { recursive: true });
    await writeFile(join(assets, 'index-DO8KcUF6.css'), css);
    await writeFile(join(siteDist, app.path, 'index.html'), `<html><head><link rel="stylesheet" crossorigin href="/${app.path}/assets/index-DO8KcUF6.css"><script type="module" src="/${app.path}/assets/index-Abcd1234.js"></script></head></html>`);
    // Vite with base `/<app>/`: deps are base-relative and the helper prefixes the base.
    await writeFile(join(assets, 'index-Abcd1234.js'), [
      'const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/decoder-Efgh5678.js","assets/index-DO8KcUF6.css"])))=>i.map(i=>d[i]);',
      `const preloadUrl=function(e){return"/${app.path}/"+e};`,
      'export const deps = __vite__mapDeps([0,1]).map(preloadUrl);',
    ].join('\n'));
    await writeFile(join(assets, 'decoder-Efgh5678.js'), 'export {};');
  }
  await assembleRuntimeAssetStore({ repoRoot: root, siteDist, registry: { apps } });
  for (const app of apps) {
    assert.deepEqual((await readdir(join(siteDist, app.path, 'assets'))).sort(), ['decoder-Efgh5678.js', 'index-Abcd1234.js']);
    const chunk = await readFile(join(siteDist, app.path, 'assets', 'index-Abcd1234.js'), 'utf8');
    assert.ok(chunk.includes(`"../_runtime/styles/${hash}/shared.css"`), chunk);
    const context = {};
    vm.runInNewContext(chunk.replace('export const deps', 'globalThis.deps'), context);
    const origin = 'https://example.test';
    assert.deepEqual(Array.from(context.deps, dep => new URL(dep, origin).href), [
      `${origin}/${app.path}/assets/decoder-Efgh5678.js`,
      `${origin}/_runtime/styles/${hash}/shared.css`,
    ]);
  }
});

const sharedCss = '.nd-field { display: block; }';
const sharedCssHash = createHash('sha256').update(sharedCss).digest('hex');

// Two apps ship the same hashed stylesheet; `other` also ships `lazy-Abcd1234.js` with the given source.
async function sharedStylesheetSite(t, label, lazySource) {
  const root = await mkdtemp(join(tmpdir(), `workspace-css-${label}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  const siteDist = join(root, 'dist');
  await prepareParameterRuntimeFixture(root);
  await mkdir(join(root, 'runtime-assets'), { recursive: true });
  await writeFile(join(root, 'runtime-assets/manifest.json'), JSON.stringify({ schema_version: 1, families: [] }));
  const apps = ['brainchop', 'other'].map(id => ({ id, path: id, app_scoped_runtime_families: [] }));
  for (const app of apps) {
    await mkdir(join(siteDist, app.path, 'assets'), { recursive: true });
    await writeFile(join(siteDist, app.path, 'assets', 'index-DO8KcUF6.css'), sharedCss);
    await writeFile(join(siteDist, app.path, 'index.html'), `<link rel="stylesheet" href="./assets/index-DO8KcUF6.css">`);
  }
  const lazy = join(siteDist, 'other', 'assets', 'lazy-Abcd1234.js');
  await writeFile(lazy, lazySource);
  const assemble = () => assembleRuntimeAssetStore({ repoRoot: root, siteDist, registry: { apps } });
  return { siteDist, lazy, assemble };
}

for (const [label, source] of [
  ['url', 'export const css = new URL("styles/index-DO8KcUF6.css", import.meta.url).href;'],
  ['mapdeps', 'const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["styles/index-DO8KcUF6.css"])))=>i.map(i=>d[i]);'],
]) {
  test(`a deduplicated stylesheet ${label} reference that resolves nowhere fails the site build`, async (t) => {
    const { assemble } = await sharedStylesheetSite(t, `unresolved-${label}`, source);
    await assert.rejects(assemble(), /Unresolved reference styles\/index-DO8KcUF6\.css/);
  });
}

test('strings that only mention a deduplicated stylesheet name are left alone', async (t) => {
  const source = [
    'export const diagnosticKey = "assets/index-DO8KcUF6.css";',
    'export const message = "missing assets/index-DO8KcUF6.css";',
    'export const plain = "styles/index-DO8KcUF6.css";',
    'const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/highlight-index-DO8KcUF6.css"])))=>i.map(i=>d[i]);',
    'export const other = new URL("./vendor-index-DO8KcUF6.css", import.meta.url).href;',
    'export const external = new URL("styles/index-DO8KcUF6.css", "https://cdn.example/").href;',
  ].join('\n');
  const { siteDist, lazy, assemble } = await sharedStylesheetSite(t, 'unrelated', source);
  await writeFile(join(siteDist, 'other', 'assets', 'highlight-index-DO8KcUF6.css'), '.highlight { color: red; }');
  await assemble();
  assert.equal(await readFile(lazy, 'utf8'), source);
});

test('a deduplicated stylesheet URL keeps its query and fragment', async (t) => {
  const { lazy, assemble } = await sharedStylesheetSite(t, 'suffix', [
    'export const themed = new URL("/other/assets/index-DO8KcUF6.css?theme", import.meta.url).href;',
    'export const anchored = new URL("./index-DO8KcUF6.css#root", import.meta.url).href;',
  ].join('\n'));
  await assemble();
  assert.equal(await readFile(lazy, 'utf8'), [
    `export const themed = new URL("../../_runtime/styles/${sharedCssHash}/shared.css?theme", import.meta.url).href;`,
    `export const anchored = new URL("../../_runtime/styles/${sharedCssHash}/shared.css#root", import.meta.url).href;`,
  ].join('\n'));
});
