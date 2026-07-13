export function definePipeline(definition) {
  const normalized = normalizePipelineDefinition(definition);
  validatePipelineDefinition(normalized);
  return Object.freeze(normalized);
}

export function normalizePipelineDefinition(definition = {}) {
  return {
    id: definition.id,
    label: definition.label || definition.displayName || definition.id,
    description: definition.description || '',
    inputModes: definition.inputModes || ['raw'],
    requiredInputs: definition.requiredInputs || [],
    settingsSchema: definition.settingsSchema || {},
    stages: (definition.stages || []).map(normalizeStage),
    commandPreview: definition.commandPreview || null,
    metadata: definition.metadata || {}
  };
}

export function normalizeStage(stage = {}) {
  return {
    id: stage.id,
    label: stage.label || stage.displayName || stage.id,
    description: stage.description || '',
    required: stage.required ?? true,
    requiredInputs: stage.requiredInputs || [],
    settingsSchema: stage.settingsSchema || {},
    workerCommand: stage.workerCommand || stage.command || stage.id,
    outputStages: stage.outputStages || [stage.id],
    assets: stage.assets || [],
    runnable: stage.runnable ?? true,
    pluginId: stage.pluginId || null,
    metadata: stage.metadata || {}
  };
}

export function validatePipelineDefinition(definition) {
  if (!definition.id) throw new Error('PipelineDefinition requires id');
  const seen = new Set();
  for (const stage of definition.stages) {
    if (!stage.id) throw new Error(`Pipeline ${definition.id} has a stage without id`);
    if (seen.has(stage.id)) throw new Error(`Pipeline ${definition.id} has duplicate stage id: ${stage.id}`);
    seen.add(stage.id);
    if (!stage.workerCommand) throw new Error(`Stage ${stage.id} requires workerCommand`);
  }
  return true;
}

export function getRunnableStages(definition, context = {}) {
  const availableInputs = new Set(context.availableInputs || []);
  const availableAssets = new Set(context.availableAssets || []);
  return definition.stages.filter(stage => {
    if (!stage.runnable) return false;
    if (stage.requiredInputs.some(input => !availableInputs.has(input))) return false;
    if (stage.assets.some(asset => !availableAssets.has(asset))) return false;
    return true;
  });
}

export function getRequiredInputIds(definition) {
  const ids = new Set(definition.requiredInputs || []);
  for (const stage of definition.stages || []) {
    for (const input of stage.requiredInputs || []) ids.add(input);
  }
  return Array.from(ids);
}

export function createCommandPreview(definition, settings, context = {}) {
  if (typeof definition.commandPreview !== 'function') return '';
  return definition.commandPreview(settings, context);
}
