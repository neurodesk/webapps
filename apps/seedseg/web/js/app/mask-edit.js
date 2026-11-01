export const EDITABLE_STAGES = Object.freeze(['consensus', 'markers']);

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

// The ranked marker mask holds marker r as value r. Offering labels 1..K (K implanted markers)
// lets a correction paint a missed marker as its own marker instead of growing marker 1.
export function markerLabelNames(stage, k) {
  if (stage !== 'markers' || !(k >= 1)) return undefined;
  return Object.fromEntries(Array.from({ length: k }, (_, index) => [index + 1, `Marker ${index + 1}`]));
}
