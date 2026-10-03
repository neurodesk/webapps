import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { registerAppAutomation } from '../src/automation/index.js';
import { parseContract, requestSchema } from '../../desktop/src/contracts.js';

function contract(parameters) {
  return {
    schemaVersion: 2, app: 'test', appVersion: '0.1.20261003',
    title: 'Test', description: 'Test method settings', defaultOperation: 'run',
    operations: { run: {
      title: 'Run', description: 'Process without files', mode: 'batch',
      inputs: {}, parameters, artifacts: {}, engines: ['browser'],
    } },
  };
}

function browser(t, spec, callback = () => {}) {
  const dom = new JSDOM('<body></body>', { url: 'https://example.test/test/' });
  t.after(() => dom.window.close());
  const calls = [];
  const { dispatch } = registerAppAutomation({
    app: 'test', contract: spec, document: dom.window.document, target: dom.window,
    operations: { run: async ({ parameters }) => {
      calls.push(structuredClone(parameters));
      callback(parameters);
      return { artifacts: [] };
    } },
  });
  return { dispatch, calls };
}

async function completed(dispatch) {
  for (let index = 0; index < 100; index++) {
    const snapshot = await dispatch('snapshot');
    if (['succeeded', 'failed', 'cancelled'].includes(snapshot.state)) {
      assert.equal(snapshot.state, 'succeeded', JSON.stringify(snapshot.error));
      return snapshot.report;
    }
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error('Operation did not settle');
}

const field = (type, extra = {}) => ({ type, description: 'Method setting', ...extra });
const cases = [
  { name: 'decimal multiple', field: field('number', { multipleOf: 0.01 }), value: 0.15 },
  { name: 'near decimal multiple', field: field('number', { multipleOf: 0.01 }), value: 0.150000000001, reject: true },
  { name: 'unsafe integer', field: field('integer'), value: Number.MAX_SAFE_INTEGER + 1, reject: true },
  { name: 'explicit undefined default', field: field('number', { default: 0.5 }), value: undefined, expected: { setting: 0.5 } },
  { name: 'positive safe integer', field: field('integer'), value: Number.MAX_SAFE_INTEGER },
  { name: 'negative safe integer', field: field('integer'), value: Number.MIN_SAFE_INTEGER },
  { name: 'negative unsafe integer', field: field('integer'), value: Number.MIN_SAFE_INTEGER - 1, reject: true },
  { name: 'fractional integer', field: field('integer'), value: 1.5, reject: true },
  { name: 'numeric string', field: field('number'), value: '0.15', reject: true },
  { name: 'finite number', field: field('number'), value: 0 },
  ...[NaN, Infinity, -Infinity].map(value => ({ name: `nonfinite ${value}`, field: field('number'), value, reject: true })),
  { name: 'boolean', field: field('boolean'), value: false },
  { name: 'boolean string', field: field('boolean'), value: 'false', reject: true },
  { name: 'string', field: field('string'), value: '' },
  { name: 'string enum', field: field('string', { enum: ['fast', 'normal'] }), value: 'fast' },
  { name: 'invalid string enum', field: field('string', { enum: ['fast'] }), value: 'slow', reject: true },
  { name: 'numeric enum', field: field('number', { enum: [1, 2] }), value: 2 },
  { name: 'invalid numeric enum', field: field('number', { enum: [1, 2] }), value: 3, reject: true },
  { name: 'boolean enum', field: field('boolean', { enum: [false] }), value: false },
  { name: 'invalid boolean enum', field: field('boolean', { enum: [false] }), value: true, reject: true },
  ...[-1, 0, 1, 2].map(value => ({ name: `inclusive bounds ${value}`, field: field('number', { minimum: 0, maximum: 1 }), value, reject: value < 0 || value > 1 })),
  { name: 'nested decimal', field: field('array', { minimum: 1, maximum: 2, items: field('array', { minimum: 1, maximum: 1, items: field('number', { multipleOf: 0.01 }) }) }), value: [[0.15]] },
  { name: 'nested near decimal', field: field('array', { items: field('array', { items: field('number', { multipleOf: 0.01 }) }) }), value: [[0.150000000001]], reject: true, path: ['setting', 0, 0] },
  { name: 'nested array size', field: field('array', { items: field('array', { maximum: 1, items: field('integer') }) }), value: [[1, 2]], reject: true, path: ['setting', 0] },
  { name: 'empty array below minimum', field: field('array', { minimum: 1, items: field('integer') }), value: [], reject: true },
  { name: 'array above maximum', field: field('array', { maximum: 1, items: field('integer') }), value: [1, 2], reject: true },
  { name: 'array scalar', field: field('array', { items: field('integer') }), value: 1, reject: true },
  { name: 'inactive item default', field: field('array', { items: field('integer', { default: 2 }) }), value: [undefined], reject: true, path: ['setting', 0] },
  { name: 'omitted parameters', field: field('number', { default: 0.5 }), supplied: undefined, expected: { setting: 0.5 } },
  { name: 'omitted optional', field: field('boolean'), supplied: {}, expected: {} },
  { name: 'explicit undefined optional', field: field('boolean'), value: undefined },
  ...[null, [], 1, 'settings'].map(supplied => ({ name: `nonobject ${JSON.stringify(supplied)}`, field: field('number'), supplied, reject: true, path: [] })),
  { name: 'unknown own key', field: field('number'), supplied: { surprise: undefined }, reject: true, path: [], keys: ['surprise'] },
];

for (const example of cases) {
  test(`browser and desktop parameter parity: ${example.name}`, async t => {
    const spec = contract({ setting: example.field });
    const schema = requestSchema(parseContract(spec));
    const supplied = Object.hasOwn(example, 'supplied') ? example.supplied : { setting: example.value };
    const request = { parameters: supplied };
    const f = browser(t, spec);
    if (example.reject) {
      const check = error => {
        assert.ok(error.issues.some(issue => {
          const path = issue.path[0] === 'parameters' ? issue.path.slice(1) : issue.path;
          return JSON.stringify(path) === JSON.stringify(example.path ?? ['setting']) &&
            (!example.keys || JSON.stringify(issue.keys) === JSON.stringify(example.keys));
        }), JSON.stringify(error.issues));
        return true;
      };
      assert.throws(() => schema.parse(request), check);
      await assert.rejects(f.dispatch('start', request), check);
      assert.deepEqual(f.calls, []);
      assert.equal((await f.dispatch('snapshot')).state, 'idle');
    } else {
      const expected = Object.hasOwn(example, 'expected') ? example.expected : { setting: example.value };
      assert.deepEqual(schema.parse(request).parameters, expected);
      await f.dispatch('start', request);
      assert.deepEqual((await completed(f.dispatch)).parameters, expected);
      assert.deepEqual(f.calls, [expected]);
    }
  });
}

test('default and supplied nested arrays stay isolated across parses, callbacks and reports', async t => {
  const declaredDefault = [[0.15]];
  const spec = contract({ setting: field('array', { default: declaredDefault, items: field('array', { items: field('number', { multipleOf: 0.01 }) }) }) });
  const schema = requestSchema(parseContract(spec));
  const parsed = schema.parse({});
  parsed.parameters.setting[0][0] = 9;
  assert.deepEqual(schema.parse({}).parameters, { setting: [[0.15]] });
  const f = browser(t, spec, parameters => { parameters.setting[0][0] = 7; });
  declaredDefault[0][0] = 8;
  const supplied = { setting: [[0.15]] };
  await f.dispatch('start', { parameters: supplied });
  supplied.setting[0][0] = 6;
  const report = await completed(f.dispatch);
  assert.deepEqual(report.parameters, { setting: [[0.15]] });
  report.parameters.setting[0][0] = 5;
  assert.deepEqual((await f.dispatch('snapshot')).report.parameters, { setting: [[0.15]] });
  await f.dispatch('start');
  assert.deepEqual((await completed(f.dispatch)).parameters, { setting: [[0.15]] });
  assert.deepEqual(f.calls, [{ setting: [[0.15]] }, { setting: [[0.15]] }]);
});
