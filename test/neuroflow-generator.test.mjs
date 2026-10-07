import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, mkdir, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { generateTools, validateTool } from '../packages/desktop/neuroflow/generator.mjs';
import { contractHash, makeRequest } from '../packages/desktop/neuroflow/runtime/contract.mjs';
import { loadAppsRegistry, repoRoot } from '../scripts/lib/apps-registry.mjs';
import { loadAppContract } from '../scripts/lib/app-automation.mjs';

const exec = promisify(execFile);
const generator = join(repoRoot, 'scripts/generate-neuroflow.mjs');
const fixture = {
  schemaVersion: 2, app: 'synthseg', appVersion: '0.1.20260930', title: 'Fixture', description: 'Transport test only',
  defaultOperation: 'run', operations: { run: {
    title: 'Run', description: 'Run fixture', mode: 'batch',
    inputs: { image: { source: 'files', type: 'neuro:volume', formats: ['nifti'], minimum: 1, maximum: 1, description: 'Input' } },
    parameters: { ct: { type: 'boolean', default: false, description: 'CT' } },
    artifacts: { items: { type: 'file:json', mediaType: 'application/json', minimum: 1, maximum: 3 } },
    engines: ['browser', 'native'],
  } },
};

test('the contract hash is the SHA-256 of key-sorted compact JSON, whatever the key order', async () => {
  // hashlib.sha256(json.dumps(fixture, sort_keys=True, separators=(',', ':'), ensure_ascii=False))
  const expected = '601215ceb425d7eff0ce81423de07b41dcab3d10abe95c480c192609eb53483b';
  assert.equal(contractHash(fixture), expected);
  const reordered = Object.fromEntries(Object.entries(fixture).reverse());
  assert.equal(contractHash(reordered), expected);
  const [tool] = generateTools(reordered);
  assert.equal(tool.extensions['neurodesk/automation'].contractSha256, expected);
  assert.notEqual(contractHash({ ...fixture, appVersion: '0.1.20261001' }), expected);
});

test('the entire catalog generates deterministic upstream-schema-valid tools with lossless bindings', async () => {
  const ids = new Set();
  for (const app of (await loadAppsRegistry()).apps) {
    const { version } = JSON.parse(await readFile(join(repoRoot, 'apps', app.id, 'package.json')));
    const contract = await loadAppContract(app, version);
    const generated = generateTools(contract);
    assert.equal(generated.length, Object.keys(contract.operations).length);
    assert.deepEqual(generated, generateTools(contract));
    for (const tool of generated) {
      validateTool(tool);
      assert.ok(!ids.has(tool.id));
      ids.add(tool.id);
      assert.match(tool.extensions['neuroflow/mcp'].name, /^[a-zA-Z0-9_-]{1,64}$/);
      const binding = tool.extensions['neurodesk/automation'];
      assert.deepEqual(binding.contract, contract);
      assert.equal(binding.contractSha256, contractHash(contract));
      assert.deepEqual(tool.inputs.engine.enum, contract.operations[binding.operation].engines);
      const request = makeRequest(tool, {}, 1000);
      assert.equal(request.operation, binding.operation);
      assert.equal(request.retainViewer, false);
    }
  }
});

test('constraints, collection outputs and names survive collisions without false core vocabulary', () => {
  const value = structuredClone(fixture);
  const operation = value.operations.run;
  operation.inputs.engine = { ...operation.inputs.image, type: 'neuro:metadata' };
  operation.parameters.engine = { type: 'array', description: 'Offsets', minimum: 2, maximum: 2,
    items: { type: 'number', description: 'Offset', multipleOf: 0.5 }, default: [0, 1] };
  operation.artifacts.items.type = ['neuro:mask', 'neuro:label-map'];
  const [tool] = generateTools(value);
  assert.equal(tool.inputs.input_engine.type, 'core:array<neurodesk:metadata>');
  assert.equal(tool.inputs.param_engine.type, 'core:array<core:number>');
  assert.deepEqual(tool.inputs.param_engine.extensions['neurodesk/parameter'], operation.parameters.engine);
  assert.equal(tool.outputs.output_items.type, 'core:array<core:file>');
  assert.deepEqual(tool.outputs.output_items.extensions['neurodesk/data'].type, operation.artifacts.items.type);
  assert.throws(() => makeRequest(tool, { unexpected: true }), /Unknown tool input/);
});

test('URL and directory values map to source objects; nested arrays retain their full constraint', () => {
  const value = structuredClone(fixture);
  value.operations.run.inputs = {
    url: { source: 'url', type: 'neuro:multiscale-volume', description: 'URL', maximum: 1 },
    folder: { source: 'directory', type: 'neuro:multiscale-volume', description: 'Folder', maximum: 1 },
  };
  value.operations.run.parameters.matrix = { type: 'array', description: 'Matrix', items: {
    type: 'array', description: 'Row', items: { type: 'number', description: 'Cell' },
  } };
  const [tool] = generateTools(value);
  assert.equal(tool.inputs.param_matrix.type, 'core:array<core:json>');
  assert.deepEqual(makeRequest(tool, { input_url: 'https://example.org/data', input_folder: '/data', engine: 'native' }, 1000), {
    app: 'synthseg', operation: 'run', inputs: { url: { url: 'https://example.org/data' }, folder: { directory: '/data' } },
    parameters: {}, engine: 'native', timeoutMs: 1000, retainViewer: false,
  });
});

test('invalid contracts and unversioned generation fail instead of guessing', () => {
  assert.throws(() => generateTools({ ...fixture, appVersion: undefined }), /appVersion/);
  assert.throws(() => generateTools({ ...fixture, schemaVersion: 3 }));
  const [tool] = generateTools(fixture);
  assert.throws(() => validateTool({ ...tool, formats: ['nifti'] }), /Invalid NeuroFlow/);
  tool.inputs.input_image.type = 'neuro:not-a-standard-type';
  assert.throws(() => validateTool(tool), /Invalid NeuroFlow/);
});

test('the pinned upstream schemas retain their published bytes', async () => {
  const root = join(repoRoot, 'packages/desktop/neuroflow/vendor');
  const snapshot = JSON.parse(await readFile(join(root, 'snapshot.json')));
  for (const [name, expected] of Object.entries(snapshot.files)) {
    assert.equal(createHash('sha256').update(await readFile(join(root, name))).digest('hex'), expected);
  }
});

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'neuroflow-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const contract = join(directory, 'automation.json');
  await writeFile(contract, JSON.stringify(fixture));
  const bundle = join(directory, 'bundle');
  await exec(process.execPath, [generator, '--contract', contract, '--out', bundle]);
  const session = join(directory, 'session');
  const output = join(session, 'outputs');
  const work = join(session, 'work');
  await mkdir(session);
  await writeFile(join(session, 'context.json'), JSON.stringify({ tool: 'neurodesk.webapps/synthseg/run', step: 'test', outputDir: output, workDir: work,
    inputs: { input_image: [join(repoRoot, 'exes/synthseg/test/fixtures/small.nii.gz')], param_ct: false } }));
  const env = { ...process.env, NEUROFLOW_SESSION: session, NEURODESK_WEBAPPS: process.execPath,
    NEURODESK_WEBAPPS_ARGS: JSON.stringify([join(repoRoot, 'test/fixtures/neuroflow-desktop.mjs')]),
    NEURODESK_FIXTURE_CONTRACT: contract, NEURODESK_FIXTURE_TRACE: join(directory, 'trace'), NEURODESK_TIMEOUT_MS: '10000' };
  return { directory, contract, bundle, session, output, env, launcher: join(bundle, 'scripts/neurodesk.mjs') };
}

test('generation is idempotent and never overwrites an unrelated or outdated bundle', async t => {
  const { bundle, contract } = await setup(t);
  await exec(process.execPath, [generator, '--contract', contract, '--out', bundle]);
  await writeFile(join(bundle, 'keep.txt'), 'unrelated');
  await assert.rejects(exec(process.execPath, [generator, '--contract', contract, '--out', bundle]), /not an identical/);
  assert.equal(await readFile(join(bundle, 'keep.txt'), 'utf8'), 'unrelated');
});

for (const engine of ['browser', 'native']) {
  test(`generated launcher completes ${engine} through real desktop MCP, harvesting every artifact`, { timeout: 20000 }, async t => {
    const data = await setup(t);
    const context = JSON.parse(await readFile(join(data.session, 'context.json')));
    context.inputs.engine = engine;
    await writeFile(join(data.session, 'context.json'), JSON.stringify(context));
    await exec(process.execPath, [data.launcher], { env: data.env, timeout: 15000 });
    const result = JSON.parse(await readFile(join(data.output, 'result.json')));
    assert.equal(result.output_items.length, 2);
    assert.deepEqual(JSON.parse(await readFile(result.output_items[1])), { item: 1, parameters: { ct: false } });
    const report = JSON.parse(await readFile(result.report));
    assert.equal(report.engine, engine);
    assert.equal(report.provenance.executor, 'test fixture');
    assert.equal(JSON.parse(await readFile(join(data.session, 'provenance.jsonl'))).engine, engine);
  });
}

for (const [mode, message] of [['failure', /Scientific execution failed/], ['contract-drift', /contract differs/], ['tamper', /checksum mismatch/]]) {
  test(`${mode} fails without publishing stale or partial results`, { timeout: 20000 }, async t => {
    const data = await setup(t);
    await mkdir(data.output);
    await writeFile(join(data.output, 'result.json'), '{}');
    await assert.rejects(exec(process.execPath, [data.launcher], { env: { ...data.env, NEURODESK_FIXTURE_MODE: mode }, timeout: 15000 }), message);
    assert.deepEqual(await readdir(data.output), []);
  });
}

test('SIGTERM cancels the desktop run and leaves no result', { timeout: 20000 }, async t => {
  const data = await setup(t);
  const child = spawn(process.execPath, [data.launcher], { env: { ...data.env, NEURODESK_FIXTURE_MODE: 'wait' }, stdio: 'ignore' });
  t.after(() => child.kill('SIGKILL'));
  const closed = new Promise(resolve => child.once('close', resolve));
  for (let tries = 0; ; tries++) {
    const text = await readFile(data.env.NEURODESK_FIXTURE_TRACE, 'utf8').catch(() => '');
    if (text.includes('start:')) break;
    assert.ok(tries < 100, 'The fixture should start');
    await delay(50);
  }
  child.kill('SIGTERM');
  assert.equal(await closed, 1);
  assert.match(await readFile(data.env.NEURODESK_FIXTURE_TRACE, 'utf8'), /cancelled/);
  assert.deepEqual(await readdir(data.output), []);
});

test('large local artifacts cross the MCP size limit through a streamed, checksummed copy', { timeout: 20000 }, async t => {
  const data = await setup(t);
  await exec(process.execPath, [data.launcher], { env: { ...data.env, NEURODESK_FIXTURE_MODE: 'large' }, timeout: 15000 });
  const result = JSON.parse(await readFile(join(data.output, 'result.json')));
  assert.equal((await stat(result.output_items[0])).size, 64 * 1024 * 1024 + 1);
});

test('a deadline cancels scientific execution and removes partial outputs', { timeout: 20000 }, async t => {
  const data = await setup(t);
  await assert.rejects(exec(process.execPath, [data.launcher], { env: { ...data.env,
    NEURODESK_FIXTURE_MODE: 'wait', NEURODESK_TIMEOUT_MS: '2500' }, timeout: 15000 }), /timeout|timed out/i);
  assert.match(await readFile(data.env.NEURODESK_FIXTURE_TRACE, 'utf8'), /cancelled/);
  assert.deepEqual(await readdir(data.output), []);
});
