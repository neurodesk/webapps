// BISON downloads on the native T1 grid: uint8 labels, one float32 probability per tissue class and
// the uint8 classification mask. Each file is gzip level 9 with a zero timestamp, so the bytes are
// the same in every browser and on the command line.
import { createNiftiFromData, parseNiftiHeader } from '@neurodesk/webapp-components/file-io/nifti';
import { gzipSync } from 'fflate';
import { modeSpec } from './features.js';

export const CLASS_SLUGS = ['ventricles', 'csf', 'cerebellar-gm', 'cerebellar-wm', 'brainstem', 'deep-gm', 'cortical-gm', 'wm', 'wmh'];

const HEADER_SIZE = 352;

export function outputStem(t1Name) {
  return t1Name.replace(/^.*[\\/]/, '').replace(/\.nii(\.gz)?$/i, '');
}

export function outputNames(t1Name, mode) {
  const stem = outputStem(t1Name);
  const { classes } = modeSpec(mode);
  return {
    labels: `${stem}_bison-labels.nii.gz`,
    probabilities: CLASS_SLUGS.slice(0, classes).map((slug, k) => ({
      label: k + 1,
      slug,
      name: `${stem}_bison-prob-${slug}.nii.gz`,
    })),
    mask: `${stem}_bison-mask.nii.gz`,
  };
}

// The T1 header without its free-text fields and extensions, with the voxels right after it.
export function outputHeader(t1Header) {
  const source = ArrayBuffer.isView(t1Header)
    ? new Uint8Array(t1Header.buffer, t1Header.byteOffset, t1Header.byteLength)
    : new Uint8Array(t1Header);
  if (source.length < HEADER_SIZE) throw new Error('The T1 header is truncated.');
  const header = parseNiftiHeader(source);
  const bytes = source.slice(0, HEADER_SIZE);
  bytes.fill(0, 148, 252);
  bytes.fill(0, 328, 344);
  bytes.fill(0, 348, HEADER_SIZE);
  new DataView(bytes.buffer).setFloat32(108, HEADER_SIZE, header.littleEndian);
  return bytes.buffer;
}

export function gzipNifti(buffer) {
  return gzipSync(new Uint8Array(buffer), { level: 9, mtime: 0 });
}

// One file at a time, so only one full-grid volume is held at once.
export function* outputFiles({ t1Name, t1Header, mode, voxels, labels, probabilities }) {
  const names = outputNames(t1Name, mode);
  const header = outputHeader(t1Header);
  const { nx, ny, nz } = parseNiftiHeader(header);
  const length = nx * ny * nz;
  const classCount = modeSpec(mode).classes + 1;
  if (labels.length !== voxels.length || probabilities.length !== voxels.length * classCount) {
    throw new Error('BISON results do not match the mask.');
  }
  const labelVolume = new Uint8Array(length);
  for (let r = 0; r < voxels.length; r++) labelVolume[voxels[r]] = labels[r];
  yield { name: names.labels, bytes: gzipNifti(createNiftiFromData(labelVolume, header, { calMin: 0, calMax: classCount - 1 })) };
  for (const { label, name } of names.probabilities) {
    const volume = new Float32Array(length);
    for (let r = 0; r < voxels.length; r++) volume[voxels[r]] = probabilities[r * classCount + label];
    yield { name, bytes: gzipNifti(createNiftiFromData(volume, header, { calMin: 0, calMax: 1 })) };
  }
  const mask = new Uint8Array(length);
  for (let r = 0; r < voxels.length; r++) mask[voxels[r]] = 1;
  yield { name: names.mask, bytes: gzipNifti(createNiftiFromData(mask, header, { calMin: 0, calMax: 1 })) };
}
