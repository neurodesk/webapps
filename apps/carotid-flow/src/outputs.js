import { createUint8Nifti } from '@neurodesk/webapp-components/file-io';
import { stem } from './config.js';

export function niftiFile(buffer, name) {
  return new File([buffer], name, { type: 'application/octet-stream' });
}

/** The label map (1 = left carotid, 2 = right) and one binary mask per side, on the series grid.
 *  An edited label map is kept as given; the per-side masks are always derived from `labels`. */
export function labelFiles(labels, source, mask = null) {
  const base = stem(source.name);
  const side = (value, name) => niftiFile(createUint8Nifti(labels.map((label) => (label === value ? 1 : 0)), source.headerBytes), `${base}_carotid_${name}.nii`);
  return {
    mask: mask ?? niftiFile(createUint8Nifti(labels, source.headerBytes), `${base}_carotid_labels.nii`),
    left: side(1, 'left'),
    right: side(2, 'right'),
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
