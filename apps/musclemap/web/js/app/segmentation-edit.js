import { decodeNiftiBuffer, isGzipped, parseNiftiHeader, sameVoxelGrid } from '@neurodesk/webapp-components/file-io';

const NIFTI1_HEADER_BYTES = 352;

/**
 * The class-index label map on the segmentation's own grid that the mask editor paints,
 * or null when there is none: a display copy resampled for the viewer cannot carry edits back.
 */
export async function findEditTarget({ file, displayFile, labelEncoding }) {
  if (!displayFile) return labelEncoding === 'class-index' ? file : null;
  const [display, full] = await Promise.all([gridOf(displayFile), gridOf(file)]);
  return sameVoxelGrid(display, full) ? displayFile : null;
}

/**
 * The fields an applied edit replaces. The edited class-index map is what the viewer shows,
 * what metrics read and what Download returns, under the segmentation's original file name.
 */
export function editedSegmentation(source, edited, original) {
  return {
    file: new File([edited], source.file.name, { type: edited.type }),
    displayFile: edited,
    editFile: edited,
    labelEncoding: 'class-index',
    edited: true,
    original: source.original ?? original
  };
}

export function editableLabelNames(labels) {
  return Object.fromEntries((labels || []).slice(1).map(label => [label.index, label.name]));
}

async function gridOf(file) {
  const head = await file.slice(0, NIFTI1_HEADER_BYTES).arrayBuffer();
  const header = isGzipped(head) ? await decodeNiftiBuffer(await file.arrayBuffer()) : head;
  return parseNiftiHeader(header);
}
