/** Diagnostic runs retain the original model inputs/settings but cannot establish full workflow acceptance. */
export function validationPlan(workflow, { diagnosticModels = false } = {}) {
  if (!diagnosticModels) return { workflow, comparisons: workflow, fullWorkflowAcceptance: true };
  if (!workflow.steps.models) throw new Error('Models diagnostics require the DWI models step.');
  const needed = new Set();
  function include(id) {
    if (needed.has(id)) return;
    const step = workflow.steps[id];
    if (!step) throw new Error(`Missing diagnostic dependency: ${id}`);
    needed.add(id);
    for (const binding of Object.values(step.inputs)) {
      if (binding.ref?.startsWith('steps.')) include(binding.ref.split('.')[1]);
    }
  }
  include('models');
  const selected = structuredClone(workflow);
  selected.id += '-models-diagnostic';
  selected.description = 'Diagnostic models replay; does not establish full workflow acceptance.';
  selected.steps = Object.fromEntries(Object.entries(selected.steps).filter(([id]) => needed.has(id)));
  selected.outputs = Object.fromEntries(Object.entries(selected.outputs).filter(([, output]) => needed.has(output.ref.split('.')[1])));
  return { workflow: selected, comparisons: { ...selected, steps: { models: selected.steps.models } }, fullWorkflowAcceptance: false };
}
