// Sending the selected series to another app of the site. Most apps take the converted NIfTI
// image; an app the registry marks `handoff: dicom` takes the series' DICOM files.
import { describeNiftiFile } from '@neurodesk/webapp-components/file-io/nifti';
import { downloadFiles } from './series-text.js';

export const LESIONS = Object.freeze({ path: 'white-matter-lesions', title: 'White matter lesions' });

// Why an image cannot be sent to White matter lesions, which segments one 3D FLAIR, or null
// when it can: a time series or a single slice cannot.
export async function lesionHandoffBlocker(image) {
  const { dimensionality, dims, frames } = await describeNiftiFile(image);
  if (frames > 1) return `${LESIONS.title} takes one 3D image; this one has ${frames} volumes.`;
  // dimensionality is 2 for a depth of exactly 1; a depth of 0 or less is no 3D image either.
  if (dimensionality < 3 || dims[2] < 2) return `${LESIONS.title} takes a 3D image; this one is a single slice.`;
  return null;
}

// Why the image cannot go to target, or null when it can. Only White matter lesions refuses
// some images before they are sent; every other app says itself what it cannot use.
export function handoffBlocker(target, image) {
  if (target.receives === 'dicom' || target.path !== LESIONS.path) return Promise.resolve(null);
  return lesionHandoffBlocker(image);
}

// The image alone, named as its download is: series number and description, without the
// patient's name or the study date dcm2niix puts in its own names. No sidecar is sent: a
// receiving app takes it for a second input.
export function handoffImage(series, outputs, output, allSeries) {
  return downloadFiles(series, outputs, allSeries)[output].image;
}

// What target receives: the DICOM files of the series as they were opened, or the image.
export function handoffFiles(target, series, outputs, output, allSeries) {
  if (target.receives === 'dicom') return series.files.map((record) => record.file);
  return [handoffImage(series, outputs, output, allSeries)];
}
