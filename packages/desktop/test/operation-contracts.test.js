import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseContract, requestSchema, validateRequest, operationFor } from '../src/contracts.js';
import { createAutomationService } from '../src/automation.js';

const registration = {
  schemaVersion: 2, app: 'registration', title: 'Registration', description: 'Register images',
  defaultOperation: 'register',
  operations: {
    register: {
      title: 'Register', description: 'Register moving to fixed', mode: 'batch',
      inputs: Object.fromEntries(['fixed', 'moving'].map(role => [role, {
        source: 'files', type: 'neuro:volume', formats: ['nifti', 'dicom'], minimum: 1, maximum: 1, description: role,
      }])),
      parameters: {
        iterations: { type: 'array', items: { type: 'integer', description: 'Iterations', minimum: 0 }, default: [20, 10], description: 'Iterations per resolution' },
        method: { type: 'string', enum: ['affine', 'deformable'], default: 'affine', description: 'Method' },
      },
      artifacts: {
        registered: { type: 'neuro:volume', mediaType: 'application/x-nifti', minimum: 1, maximum: 1 },
        transforms: { type: ['neuro:volume', 'neuro:transform'], mediaType: 'application/octet-stream', minimum: 0, maximum: 3 },
      },
      engines: ['browser'],
    },
    inspect: {
      title: 'Inspect', description: 'Inspect a store', mode: 'viewer',
      inputs: { store: { source: 'directory', type: 'neuro:omezarr', minimum: 1, maximum: 1, description: 'Local store' } },
      parameters: {}, artifacts: {}, engines: ['browser'],
    },
  },
};

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'operation-contract-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixed = join(directory, 'fixed.nii');
  const moving = join(directory, 'moving.nii.gz');
  const image = await readFile(new URL('../../../exes/synthseg/test/fixtures/small.nii.gz', import.meta.url));
  await Promise.all([writeFile(fixed, gunzipSync(image)), writeFile(moving, image)]);
  return { directory, inputs: { fixed: [fixed], moving: [moving] } };
}

test('operation requests derive typed defaults and reject wrong operations and unknown fields', async t => {
  const contract = parseContract(registration);
  const { inputs } = await fixture(t);
  const request = await validateRequest(contract, { inputs });
  assert.equal(request.operation, 'register');
  assert.equal(request.retainViewer, false);
  assert.deepEqual(request.parameters, { iterations: [20, 10], method: 'affine' });
  assert.equal(operationFor(contract, request.operation).artifacts.transforms.maximum, 3);
  await assert.rejects(validateRequest(contract, { inputs, operation: 'guessed' }), /Unknown operation/);
  await assert.rejects(validateRequest(contract, { inputs, parameters: { iterations: [1.5] } }));
  await assert.rejects(validateRequest(contract, { inputs, parameters: { iterations: [-1] } }));
  await assert.rejects(validateRequest(contract, { inputs, parameters: { invented: true } }));
  await assert.rejects(validateRequest(contract, { inputs, selections: { fixed: 'not-a-hash' } }));
});

test('a disguised non-NIfTI file is rejected before the scientific executor starts', async t => {
  const { directory, inputs } = await fixture(t);
  await writeFile(inputs.fixed[0], 'not a NIfTI image despite the extension');
  let executions = 0;
  const service = createAutomationService({
    contracts: [{ contract: parseContract(registration), sha256: 'test' }],
    outputRoot: join(directory, 'runs'),
    execute: async () => { executions++; },
  });
  await assert.rejects(service.validate('registration', { inputs }), /encoding.*NIfTI/);
  await assert.rejects(service.start('registration', { inputs }), /encoding.*NIfTI/);
  assert.equal(executions, 0);
});

test('DICOM directories expand deterministically and duplicate files are rejected', async t => {
  const contract = parseContract(registration);
  const { directory, inputs } = await fixture(t);
  const series = join(directory, 'dicom');
  await mkdir(join(series, 'nested'), { recursive: true });
  await writeFile(join(series, 'slice2'), 'DICOM');
  await writeFile(join(series, 'nested/slice1'), 'DICOM');
  const request = await validateRequest(contract, { inputs: { ...inputs, moving: [series] } });
  assert.deepEqual(request.inputs.moving, [join(series, 'nested/slice1'), join(series, 'slice2')]);
  await assert.rejects(validateRequest(contract, { inputs: { ...inputs, fixed: [...inputs.fixed, ...inputs.fixed] } }), /duplicate/);
});

test('viewer operations validate directory sources and retain sessions by default', async t => {
  const contract = parseContract(registration);
  const { directory, inputs } = await fixture(t);
  const request = await validateRequest(contract, { operation: 'inspect', inputs: { store: { directory } } });
  assert.equal(request.retainViewer, true);
  await assert.rejects(validateRequest(contract, { operation: 'inspect', inputs: { store: { directory: inputs.fixed[0] } } }), /not a directory/);
  assert.throws(() => requestSchema(contract, 'inspect').parse({ inputs: { store: { url: 'https://example.org' } } }));
});

test('contracts reject undeclared defaults, invalid cardinality and array shapes', () => {
  assert.throws(() => parseContract({ ...registration, defaultOperation: 'missing' }), /Default operation/);
  const invalid = structuredClone(registration);
  invalid.operations.register.artifacts.registered.minimum = 3;
  assert.throws(() => parseContract(invalid), /cardinality/);
  invalid.operations.register.artifacts.registered.minimum = 1;
  delete invalid.operations.register.parameters.iterations.items;
  assert.throws(() => parseContract(invalid), /require items/);
});

test('declared input cardinality controls request arrays and optional roles', async t => {
  const source = structuredClone(registration);
  source.operations.register.inputs.fixed.formats = ['nifti'];
  source.operations.register.inputs.moving.formats = ['nifti'];
  source.operations.register.inputs.moving.minimum = 0;
  const contract = parseContract(source);
  const { inputs } = await fixture(t);
  await validateRequest(contract, { inputs: { fixed: inputs.fixed } });
  await validateRequest(contract, { inputs: { fixed: inputs.fixed, moving: [] } });
  await assert.rejects(validateRequest(contract, { inputs: { fixed: [] } }));
  await assert.rejects(validateRequest(contract, { inputs: { fixed: [...inputs.fixed, ...inputs.moving] } }));
  source.operations.register.inputs.fixed.minimum = 2;
  source.operations.register.inputs.fixed.maximum = 3;
  await validateRequest(parseContract(source), { inputs: { fixed: [...inputs.fixed, ...inputs.moving] } });
  await assert.rejects(validateRequest(parseContract(source), { inputs: { fixed: inputs.fixed } }));
  source.operations.register.inputs.fixed.maximum = 1;
  assert.throws(() => parseContract(source), /input cardinality/);
});
