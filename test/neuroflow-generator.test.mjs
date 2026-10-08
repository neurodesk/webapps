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
  assert.equal(tool.inputs.input_engine.type, 'neurodesk:metadata');
  assert.deepEqual(tool.inputs.input_engine.formats, ['nifti']);
  assert.equal(tool.inputs.param_engine.type, 'core:array<core:number>');
  assert.deepEqual(tool.inputs.param_engine.extensions['neurodesk/parameter'], operation.parameters.engine);
  assert.equal(tool.outputs.output_items.type, 'core:array<core:file>');
  assert.deepEqual(tool.outputs.output_items.extensions['neurodesk/data'].type, operation.artifacts.items.type);
  assert.throws(() => makeRequest(tool, { unexpected: true }), /Unknown tool input/);
});

test('single-file roles are scalars that the launcher widens for the desktop; collections stay arrays', () => {
  const value = structuredClone(fixture);
  const operation = value.operations.run;
  operation.inputs.stack = { ...operation.inputs.image, minimum: 1, maximum: undefined };
  operation.artifacts.mask = { type: 'neuro:mask', mediaType: 'application/gzip', minimum: 0, maximum: 1 };
  const [tool] = generateTools(value);
  assert.equal(tool.inputs.input_image.type, 'neuro:volume');
  assert.equal(tool.inputs.input_stack.type, 'core:array<neuro:volume>');
  assert.equal(tool.outputs.output_mask.type, 'neuro:mask');
  assert.equal(tool.outputs.output_mask.optional, true);
  assert.equal(tool.outputs.output_items.type, 'core:array<file:json>');
  assert.equal(tool.outputs.report.type, 'neuro:report');
  const request = makeRequest(tool, { input_image: '/data/T1.nii.gz', input_stack: ['/data/a.nii.gz', '/data/b.nii.gz'] }, 1000);
  assert.deepEqual(request.inputs, { image: ['/data/T1.nii.gz'], stack: ['/data/a.nii.gz', '/data/b.nii.gz'] });
});

test('RFC 0010 qualifiers are promoted by the migration mapping and the document declares 0.1.1', () => {
  const value = structuredClone(fixture);
  const operation = value.operations.run;
  operation.inputs.image = { ...operation.inputs.image, formats: ['nifti', 'gii', 'surface', 'custom'], space: 'native' };
  operation.inputs.fixed = { ...operation.inputs.image, formats: ['nifti'], space: 'fixed' };
  operation.inputs.bval = { source: 'files', type: 'neuro:gradients', formats: ['bval', 'bvals'], minimum: 1, maximum: 1, description: 'b' };
  operation.inputs.store = { source: 'url', type: 'neuro:multiscale-volume', formats: ['ome-zarr'], maximum: 1, description: 'Store' };
  operation.artifacts = {
    labels: { type: 'neuro:label-map', mediaType: 'application/gzip', minimum: 1, maximum: 1, space: 'subject-1mm', labelSystem: 'FreeSurfer' },
    registered: { type: 'neuro:volume', mediaType: 'application/gzip', minimum: 1, maximum: 1, space: 'fixed' },
    warp: { type: 'neuro:displacement-field', mediaType: 'application/gzip', minimum: 1, maximum: 1, space: 'fixed' },
    affine: { type: 'neuro:transform', mediaType: 'text/plain', minimum: 1, maximum: 1, space: 'moving-to-fixed' },
    atlas: { type: 'neuro:mask', mediaType: 'application/gzip', minimum: 1, maximum: 1, space: 'MNI152-1mm', labelSystem: 'x' },
  };
  const [tool] = generateTools(value);
  assert.equal(tool.neuroflow, '0.1.1');
  assert.deepEqual(tool.inputs.input_image.formats, ['nifti', 'gifti', 'neurodesk:custom']);
  assert.equal(tool.inputs.input_image.space, undefined);
  assert.equal(tool.inputs.input_fixed.space, undefined);
  assert.deepEqual(tool.inputs.input_bval, { ...tool.inputs.input_bval, type: 'neuro:gradient-table', formats: ['bval'] });
  assert.equal(tool.inputs.input_store.type, 'core:string');
  assert.equal(tool.inputs.input_store.formats, undefined);
  // Two spatial inputs: `subject-1mm` cannot name which one it follows, so it stays in the extension.
  assert.equal(tool.outputs.output_labels.space, undefined);
  assert.equal(tool.outputs.output_labels.resolution, undefined);
  assert.equal(tool.outputs.output_labels.labelSystem, 'freesurfer');
  assert.equal(tool.outputs.output_registered.space, 'inputs.input_fixed');
  assert.equal(tool.outputs.output_warp.type, 'neuro:transform');
  assert.deepEqual(tool.outputs.output_warp.formats, ['displacement-field']);
  assert.equal(tool.outputs.output_warp.space, undefined);
  assert.equal(tool.outputs.output_affine.space, undefined);
  assert.equal(tool.outputs.output_atlas.space, undefined);
  assert.equal(tool.outputs.output_atlas.labelSystem, undefined);
  assert.deepEqual(tool.outputs.output_atlas.extensions['neurodesk/data'], operation.artifacts.atlas);
  delete value.operations.run.inputs.fixed;
  const [single] = generateTools(value);
  assert.equal(single.outputs.output_labels.space, 'inputs.input_image');
  assert.equal(single.outputs.output_labels.resolution, 1);
  const [plain] = generateTools({ ...fixture, operations: { run: { ...fixture.operations.run,
    inputs: { doc: { source: 'url', type: 'neuro:metadata', formats: ['json'], maximum: 1, description: 'Doc' } } } } });
  assert.equal(plain.neuroflow, '0.1.0');
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
  assert.throws(() => validateTool({ ...tool, neuroflow: '0.1.0' }), /declares 0.1.1/);
  assert.throws(() => validateTool({ ...tool, outputs: { ...tool.outputs, output_items: { ...tool.outputs.output_items, space: 'inputs.input_missing' } } }), /input_missing/);
  assert.throws(() => validateTool({ ...tool, inputs: { ...tool.inputs, param_ct: { ...tool.inputs.param_ct, space: 'individual' } } }), /Invalid NeuroFlow/);
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
    inputs: { input_image: join(repoRoot, 'exes/synthseg/test/fixtures/small.nii.gz'), param_ct: false } }));
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
    assert.equal(report.artifacts['part-0'].role, 'items');
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
