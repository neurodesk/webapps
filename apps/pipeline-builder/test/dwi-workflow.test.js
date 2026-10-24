import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadCatalogContracts } from '../../../scripts/lib/neuroflow-bundle.mjs';
import { generateTools } from '../../../packages/desktop/neuroflow/generator.mjs';
import { createValidator } from '../src/validator.js';

const workflow = JSON.parse(await readFile(new URL('../src/workflows/dwi-preprocessing.workflow.json', import.meta.url)));
const tools = (await loadCatalogContracts()).flatMap(generateTools);
const validate = await createValidator(tools, await readFile(new URL('../vendor/neuroflow/neuroflow_wasm_bg.wasm', import.meta.url)));

test('DWI preprocessing has valid bindings and warns about its conditional ICVF output', () => {
  assert.deepEqual(validate(workflow), {
    ok: true,
    issues: [{
      severity: 'warning', code: 'optional-output', path: 'outputs.icvf',
      message: 'steps.models.outputs.output_noddi-icvf is optional and may not produce this workflow output.',
    }],
  });
  assert.deepEqual(Object.keys(workflow.steps), ['denoise', 'degibbs', 'correct', 'brain', 'models', 'tractography']);
  assert.equal(workflow.steps.brain.inputs.input_image.ref, 'steps.correct.outputs.output_mean-b0');
  for (const id of ['models', 'tractography']) {
    assert.equal(workflow.steps[id].inputs.input_mask.ref, 'steps.brain.outputs.output_mask');
    for (const role of ['bval', 'bvec']) assert.equal(workflow.steps[id].inputs[`input_${role}`].ref, `steps.correct.outputs.output_${role}`);
  }
});

test('the template rejects a scalar model image substituted for the tractography brain mask', () => {
  const changed = structuredClone(workflow);
  changed.steps.tractography.inputs.input_mask.ref = 'steps.models.outputs.output_tensor-fa';
  const result = validate(changed);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some(issue => issue.severity === 'error' && issue.path.includes('input_mask') && issue.message.includes('type is incompatible')));
});

for (const [input, output] of [['bval', 'bvec'], ['bvec', 'bval']]) {
  test(`an imported ${output}-to-${input} binding fails validation`, () => {
    const changed = JSON.parse(JSON.stringify(workflow));
    changed.steps.models.inputs[`input_${input}`].ref = `steps.correct.outputs.output_${output}`;
    const result = validate(changed);
    assert.equal(result.ok, false);
    assert.ok(result.issues.some(issue => issue.severity === 'error'
      && issue.path === `steps.models.inputs.input_${input}`
      && /formats.*incompatible/i.test(issue.message)), JSON.stringify(result.issues));
  });
}
