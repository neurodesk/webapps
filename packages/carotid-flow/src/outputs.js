// The files a detection produces, named after the input series. The web app offers them as
// downloads and the command line writes them, so both produce the same names and bytes.
import { createFloat32Nifti, createUint8Nifti } from '@neurodesk/webapp-components/file-io';
import { curvesCsv } from './carotid.js';

/** A file name without the NIfTI extension, for naming the outputs after their input. */
export function stem(name) {
  return name.replace(/\.nii(\.gz)?$/i, '').replace(/\.[^.]+$/, '');
}

/** The label map (1 = left carotid, 2 = right) and one binary mask per side, on the series grid. */
export function labelImages(labels, source) {
  const base = stem(source.name);
  const side = (value, name) => ({
    name: `${base}_carotid_${name}.nii`,
    bytes: createUint8Nifti(labels.map((label) => (label === value ? 1 : 0)), source.headerBytes),
  });
  return {
    mask: { name: `${base}_carotid_labels.nii`, bytes: createUint8Nifti(labels, source.headerBytes) },
    left: side(1, 'left'),
    right: side(2, 'right'),
  };
}

/** The temporal SD the vessels were found in. */
export function variabilityImage(found, source) {
  return { name: `${stem(source.name)}_phase_sd.nii`, bytes: createFloat32Nifti(found.variability, source.headerBytes) };
}

export function curvesTable(found, source) {
  return { name: `${stem(source.name)}_carotid_curves.csv`, text: curvesCsv(found) };
}
