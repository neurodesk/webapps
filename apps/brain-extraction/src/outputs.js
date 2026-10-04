export function extractionOutputs(brain, mask) {
  return {
    brain: { description: 'Brain', file: brain },
    mask: { description: 'Brain mask', file: mask, editable: true },
  };
}

export function editedResult(result, file, original) {
  return { ...result, file, original: result.original ?? original, edited: true };
}
