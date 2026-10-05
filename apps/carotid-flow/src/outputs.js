import { labelImages } from '@neurodesk/carotid-flow/outputs';

export function niftiFile(buffer, name) {
  return new File([buffer], name, { type: 'application/octet-stream' });
}

/** The label map and one binary mask per side as files. An edited label map is kept as
 *  given; the per-side masks are always derived from `labels`. */
export function labelFiles(labels, source, mask = null) {
  const images = labelImages(labels, source);
  return {
    mask: mask ?? niftiFile(images.mask.bytes, images.mask.name),
    left: niftiFile(images.left.bytes, images.left.name),
    right: niftiFile(images.right.bytes, images.right.name),
  };
}

export function resultRows(result) {
  return {
    mask: { description: 'Carotid labels', file: result.files.mask, editable: true, edited: Boolean(result.originalMask) },
    variability: { description: result.found.method === 'velocity' ? 'Velocity temporal SD' : 'Phase temporal SD', file: result.files.variability },
  };
}

/** The result with its label map replaced by an edit. Curves and metrics keep the detection's
 *  pixels; `originalMask` keeps the detected labels across repeated edits. */
export function withEditedLabels(result, file, labels, original) {
  return {
    ...result,
    originalMask: result.originalMask ?? original,
    files: { ...result.files, ...labelFiles(labels, result.source, file) },
  };
}
