import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PARAMETERS } from '@neurodesk/vesselcharter';
import { APP } from '../src/config.js';

test('app config matches automation contract and shared parameter schema', async () => {
  assert.equal(APP.id, 'vesselcharter');
  assert.equal(APP.title, 'VesselCharter');
  const automation = JSON.parse(await readFile(new URL('../automation.json', import.meta.url), 'utf8'));
  assert.equal(automation.app, APP.id);
  assert.equal(automation.defaultOperation, 'characterize');
  const opParams = automation.operations.characterize.parameters;
  assert.deepEqual(Object.keys(opParams).sort(), Object.keys(PARAMETERS).sort());
  for (const key of Object.keys(PARAMETERS)) {
    assert.equal(opParams[key].default, PARAMETERS[key].default, `Default mismatch for ${key}`);
  }
});
