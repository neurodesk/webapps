// Sending the selected image to White matter lesions, which segments one 3D FLAIR.
import { decodeNiftiBuffer, parseNiftiHeader } from '@neurodesk/webapp-components/file-io/nifti';
import { downloadFiles } from './series-text.js';

export const LESIONS = Object.freeze({ path: 'white-matter-lesions', title: 'White matter lesions' });

// Enough of a gzipped image to decode its header; dcm2niix writes .nii here.
const HEADER_PREFIX = 64 * 1024;

// Why an image cannot be sent, or null when it can: a time series or a single slice cannot.
export async function lesionHandoffBlocker(image) {
  const { dims } = parseNiftiHeader(await decodeNiftiBuffer(await image.slice(0, HEADER_PREFIX).arrayBuffer(), { maxBytes: 352 }));
  const volumes = dims.slice(4, dims[0] + 1).reduce((product, size) => product * Math.max(size, 1), 1);
  if (volumes > 1) return `${LESIONS.title} takes one 3D image; this one has ${volumes} volumes.`;
  if (dims[0] < 3 || dims[3] < 2) return `${LESIONS.title} takes a 3D image; this one is a single slice.`;
  return null;
}

// The image alone, named as its download is: series number and description, without the
// patient's name or the study date dcm2niix puts in its own names. White matter lesions reads
// no sidecar, so none is sent.
export function handoffImage(series, outputs, output, allSeries) {
  return downloadFiles(series, outputs, allSeries)[output].image;
}
