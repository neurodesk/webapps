export const EDITABLE_STAGES = Object.freeze(['consensus']);

export function isEditableStage(stage) {
  return EDITABLE_STAGES.includes(stage);
}

export function stageLabel(name, result) {
  return result?.edited === true ? `${name} (edited)` : name;
}

export function replaceWithEdit(executor, stage, file, original) {
  const result = executor.getResult(stage);
  executor.results[stage] = { ...result, file, original: result.original ?? original, edited: true };
  return executor.results[stage];
}

export async function clearResultsAfterEditing(editor, executor) {
  await editor.cancel();
  executor.clearResults();
}
