import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { assembleRuntimeAssetStore } from '../scripts/lib/runtime-assets.mjs';

const execute = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../', import.meta.url));

async function checkRuntime(t, componentsSrc) {
  const module = await import(pathToFileURL(join(componentsSrc, 'automation/parameters.js')));
  assert.deepEqual(Object.keys(module).sort(), ['operationParameterSchema', 'operationParametersSchema']);
  const fields = {
    threshold: { type: 'number', multipleOf: 0.01, default: 0.15 },
    iterations: { type: 'integer' },
  };
  const schema = module.operationParametersSchema(fields);
  assert.deepEqual(schema.parse(undefined), { threshold: 0.15 });
  assert.deepEqual(schema.parse({ threshold: undefined }), { threshold: 0.15 });
  assert.equal(schema.safeParse({ threshold: 0.150000000001 }).success, false);
  assert.equal(schema.safeParse({ iterations: Number.MAX_SAFE_INTEGER + 1 }).success, false);
  assert.equal(schema.safeParse({ invented: undefined }).success, false);
  assert.equal(module.operationParameterSchema(fields.threshold).safeParse(undefined).success, false);

  const { registerAppAutomation } = await import(pathToFileURL(join(componentsSrc, 'automation/index.js')));
  const dom = new JSDOM('<body></body>', { url: 'https://example.test/qsmbly/' });
  t.after(() => dom.window.close());
  const calls = [];
  const { dispatch } = registerAppAutomation({
    app: 'test', document: dom.window.document, target: dom.window,
    contract: { schemaVersion: 2, app: 'test', appVersion: '0.1.20261003', defaultOperation: 'run', operations: {
      run: { mode: 'batch', inputs: {}, parameters: fields, artifacts: {}, engines: ['browser'] },
    } },
    operations: { run: async ({ parameters }) => { calls.push(parameters); return { artifacts: [] }; } },
  });
  await assert.rejects(dispatch('start', { parameters: { threshold: 0.150000000001 } }));
  assert.deepEqual(calls, []);
  await dispatch('start', { parameters: { threshold: undefined } });
  for (let index = 0; index < 100; index++) {
    const snapshot = await dispatch('snapshot');
    if (snapshot.state === 'succeeded') {
      assert.deepEqual(snapshot.report.parameters, { threshold: 0.15 });
      assert.deepEqual(calls, [{ threshold: 0.15 }]);
      return;
    }
    assert.notEqual(snapshot.state, 'failed', JSON.stringify(snapshot.error));
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error('Staged operation did not settle');
}

test('native vendor, standalone and composite staging execute the shared parameter module', async t => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'operation-parameters-runtime-'));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const appDir = join(fixtureRoot, 'apps/qsmbly');
  await mkdir(join(appDir, 'web'), { recursive: true });
  await mkdir(join(fixtureRoot, 'runtime-assets'), { recursive: true });
  await cp(join(repoRoot, 'packages/components/src'), join(fixtureRoot, 'packages/components/src'), { recursive: true });
  await symlink(join(repoRoot, 'packages/components/node_modules'), join(fixtureRoot, 'packages/components/node_modules'), 'dir');
  await writeFile(join(fixtureRoot, 'package.json'), JSON.stringify({ type: 'module' }));
  await writeFile(join(fixtureRoot, 'runtime-assets/manifest.json'), JSON.stringify({ schema_version: 1, families: [] }));
  await writeFile(join(appDir, 'package.json'), JSON.stringify({ name: 'qsmbly', version: '0.29.20260930', type: 'module' }));
  await writeFile(join(appDir, 'examples.json'), JSON.stringify({ schemaVersion: 1, examples: [] }));
  await writeFile(join(appDir, 'web/index.html'), '<body></body>');

  await execute(process.execPath, [join(repoRoot, 'scripts/vendor-components.mjs')], { cwd: appDir });
  await checkRuntime(t, join(appDir, 'web/vendor/webapp-components/src'));

  await execute(process.execPath, [join(repoRoot, 'scripts/build-static.mjs')], { cwd: appDir });
  await checkRuntime(t, join(appDir, 'dist/vendor/webapp-components/src'));

  const siteDist = join(fixtureRoot, 'site');
  await cp(join(appDir, 'dist'), join(siteDist, 'qsmbly'), { recursive: true });
  await assembleRuntimeAssetStore({ repoRoot: fixtureRoot, siteDist, registry: { apps: [{ id: 'qsmbly', path: 'qsmbly' }] } });
  await checkRuntime(t, join(siteDist, '_runtime/webapp-components/0.1.2/src'));
});
