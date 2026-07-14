// Reader dispatch: detect a file's kind by extension, with a DICOM magic sniff
// for extensionless files.

export { readDicomSeries, readDicomHeader, parseDicom, DicomError } from './dicom.js';
export { readNifti, NiftiError } from './nifti.js';
export { readMgz, MgzError } from './mgz.js';

export function detectKind(name) {
  const n = (name || '').toLowerCase();
  if (n.endsWith('.nii') || n.endsWith('.nii.gz')) return 'nifti';
  if (n.endsWith('.mgz') || n.endsWith('.mgh')) return 'mgz';
  if (n.endsWith('.dcm') || n.endsWith('.ima')) return 'dicom';
  return 'unknown';
}

// True if bytes look like a DICOM file (preamble + 'DICM' at offset 128).
export function sniffDicom(bytes) {
  return bytes.length >= 132
    && bytes[128] === 0x44 && bytes[129] === 0x49
    && bytes[130] === 0x43 && bytes[131] === 0x4d;
}
