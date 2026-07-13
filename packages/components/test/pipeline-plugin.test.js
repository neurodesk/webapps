import test from 'node:test';
import assert from 'node:assert/strict';
import { PipelineRegistry } from '../src/pipeline/index.js';
import { generateQsmxtCommand, qsmPlugin } from '../src/plugins/qsm/index.js';
import { sctPlugin } from '../src/plugins/sct/index.js';

test('registry imports plugin pipelines', () => {
  const registry = new PipelineRegistry();
  registry.registerPlugin(qsmPlugin);
  assert.equal(registry.list().length, 3);
  assert.equal(registry.require('qsm-romeo').requiredInputs.includes('magnitude'), true);
});

test('qsm command generator emits changed settings only', () => {
  const command = generateQsmxtCommand({
    dipoleInversion: 'tv',
    tv: { lambda: 0.01 },
    referenceMean: false
  }, ['threshold:otsu'], { doSwi: true });
  assert.match(command, /--qsm-algorithm tv/);
  assert.match(command, /--tv-lambda 0.01/);
  assert.match(command, /--qsm-reference none/);
  assert.match(command, /--do-swi/);
  assert.match(command, /--mask phase-quality,threshold:otsu/);
});

test('sct plugin exposes spinal cord and vertebrae tasks', () => {
  assert.ok(sctPlugin.tasks.find(task => task.id === 'spinalcord'));
  assert.ok(sctPlugin.tasks.find(task => task.id === 'vertebrae'));
  assert.ok(sctPlugin.colormaps.vertebrae);
});
