import { DicomController as SharedDicomController, isNiftiFile } from '@neurodesk/webapp-components/file-io';

// MuscleMap-specific behavior kept on top of the shared controller: a 1 GiB WASM
// input-size guard (browser dcm2niix holds DICOM input and NIfTI output in WASM
// memory, so oversized studies must be converted natively) and multi-series output
// (every converted NIfTI is handed to onConversionComplete so the file list can
// offer all series, not just the first).

const DICOM_WASM_INPUT_LIMIT_BYTES = 1024 ** 3;

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown size';

  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

export class MuscleMapDicomInput extends SharedDicomController {
  constructor(options = {}) {
    super({ ...options, moduleUrl: new URL('../../dcm2niix/index.jpeg.js', import.meta.url).href, throwOnError: false });
  }

  async convertFiles(files) {
    const inputFiles = Array.from(files || []);
    if (inputFiles.length && this._warnIfTooLargeForBrowserConversion(inputFiles)) return null;
    return super.convertFiles(inputFiles);
  }

  _selectNifti(resultFiles) {
    const niftiFiles = Array.from(resultFiles || []).filter(isNiftiFile);
    if (!niftiFiles.length) throw new Error('No NIfTI files produced. Are these valid DICOM files?');
    this.updateOutput(`Converted ${niftiFiles.length} NIfTI file(s).`);
    return niftiFiles;
  }

  _warnIfTooLargeForBrowserConversion(files) {
    const fileArray = Array.from(files);
    const totalBytes = fileArray.reduce((sum, file) => sum + (file.size || 0), 0);

    if (totalBytes < DICOM_WASM_INPUT_LIMIT_BYTES) return false;

    const largestFile = fileArray.reduce(
      (largest, file) => ((file.size || 0) > (largest?.size || 0) ? file : largest),
      null
    );
    const noun = fileArray.length === 1 ? 'file' : 'files';
    const largestHint = largestFile
      ? ` Largest file: ${largestFile.name} (${formatBytes(largestFile.size)}).`
      : '';
    const singleFileHint = fileArray.length === 1
      ? ' Large single-file DICOMs, including Enhanced MR multi-frame objects, should be converted outside the browser.'
      : '';

    this.updateOutput([
      `Warning: DICOM conversion skipped because the selected ${noun} total ${formatBytes(totalBytes)}.`,
      `Browser conversion keeps DICOM input and NIfTI output in WASM memory and is unreliable above ${formatBytes(DICOM_WASM_INPUT_LIMIT_BYTES)}.`,
      largestHint.trim(),
      singleFileHint.trim(),
      'Convert with native dcm2niix first, then load the .nii or .nii.gz file.'
    ].filter(Boolean).join(' '));
    return true;
  }
}
