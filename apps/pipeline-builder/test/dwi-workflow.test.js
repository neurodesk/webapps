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
  // The template's gradient inputs declare no formats, so neuroflow-mcp inspects those files at run time.
  const runtimeCheck = role => ({
    severity: 'warning', outcome: 'requires-runtime-check', path: `steps.denoise.inputs.input_${role}`,
    message: `formats requires a runtime check: source null, target ["${role}"].`,
  });
  assert.deepEqual(validate(workflow), {
    ok: true,
    issues: [runtimeCheck('bval'), runtimeCheck('bvec'), {
      severity: 'warning', code: 'optional-output', path: 'outputs.icvf.ref',
      message: 'Output output_noddi-icvf of neurodesk.webapps/noddi/fit is optional, so workflow output icvf may have no value when the step finishes.',
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

function withBiasCorrection(maskRef) {
  const changed = structuredClone(workflow);
  changed.steps = { n4: { tool: 'neurodesk.webapps/n4/correct', inputs: { input_image: { ref: 'steps.correct.outputs.output_mean-b0' } } }, ...changed.steps };
  changed.steps.models.inputs.input_mask.ref = maskRef;
  return changed;
}

test('the NODDI brain mask refuses the N4 bias field and accepts a mask output', () => {
  const result = validate(withBiasCorrection('steps.n4.outputs.output_bias'));
  assert.equal(result.ok, false);
  assert.ok(result.issues.some(issue => issue.severity === 'error'
    && issue.path === 'steps.models.inputs.input_mask'
    && issue.message.includes('type is incompatible')), JSON.stringify(result.issues));
  for (const ref of ['steps.n4.outputs.output_mask', 'steps.brain.outputs.output_mask']) {
    assert.equal(validate(withBiasCorrection(ref)).ok, true, ref);
  }
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
