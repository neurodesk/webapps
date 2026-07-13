/**
 * DicomController - Handles DICOM to NIfTI conversion.
 * Uses vendored @niivue/dcm2niix (WASM) for in-browser conversion.
 */

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

export class DicomController {
  constructor(options = {}) {
    this.onConversionComplete = options.onConversionComplete || (() => {});
    this.updateOutput = options.updateOutput || console.log;
    this.dcm2niixModule = null;
    this.converting = false;
  }

  async _createInstance() {
    if (!this.dcm2niixModule) {
      this.dcm2niixModule = await import('../../dcm2niix/index.js');
    }
    const dcm2niix = new this.dcm2niixModule.Dcm2niix();
    await dcm2niix.init();
    return dcm2niix;
  }

  async convertFiles(files) {
    if (!files || files.length === 0) return;

    if (this._warnIfTooLargeForBrowserConversion(files)) return;

    this.converting = true;
    this.updateOutput(`Converting ${files.length} DICOM files...`);

    try {
      const dcm2niix = await this._createInstance();
      const result = await dcm2niix.input(files).run();
      this._processResults(result);
    } catch (error) {
      console.error('DICOM conversion error:', error);
      this.updateOutput(`DICOM conversion failed: ${error.message}`);
    } finally {
      this.converting = false;
    }
  }

  async convertDropItems(dataTransferItems) {
    if (!dataTransferItems || dataTransferItems.length === 0) return;

    this.converting = true;
    this.updateOutput('Reading dropped files...');

    try {
      const entries = [];
      for (let i = 0; i < dataTransferItems.length; i++) {
        const entry = dataTransferItems[i].webkitGetAsEntry?.();
        if (entry) entries.push(entry);
      }

      const files = [];
      for (const entry of entries) {
        await this._traverseFileTree(entry, '', files);
      }

      if (files.length === 0) {
        this.updateOutput('No DICOM files found in dropped items.');
        this.converting = false;
        return;
      }

      if (this._warnIfTooLargeForBrowserConversion(files)) {
        this.converting = false;
        return;
      }

      this.updateOutput(`Converting ${files.length} DICOM files...`);
      const dcm2niix = await this._createInstance();
      const result = await dcm2niix.input(files).run();
      this._processResults(result);
    } catch (error) {
      console.error('DICOM conversion error:', error);
      this.updateOutput(`DICOM conversion failed: ${error.message}`);
    } finally {
      this.converting = false;
    }
  }

  _traverseFileTree(item, path, fileArray) {
    return new Promise((resolve) => {
      if (item.isFile) {
        item.file(file => {
          file._webkitRelativePath = path + file.name;
          fileArray.push(file);
          resolve();
        });
      } else if (item.isDirectory) {
        const dirReader = item.createReader();
        const readAllEntries = () => {
          dirReader.readEntries(entries => {
            if (entries.length > 0) {
              const promises = entries.map(entry =>
                this._traverseFileTree(entry, path + item.name + '/', fileArray)
              );
              Promise.all(promises).then(readAllEntries);
            } else {
              resolve();
            }
          });
        };
        readAllEntries();
      } else {
        resolve();
      }
    });
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

  _processResults(resultFiles) {
    const niftiFiles = resultFiles.filter(f =>
      f.name.endsWith('.nii') || f.name.endsWith('.nii.gz')
    );

    if (niftiFiles.length === 0) {
      this.updateOutput('No NIfTI files produced. Are these valid DICOM files?');
      return;
    }

    this.updateOutput(`Converted ${niftiFiles.length} NIfTI file(s).`);
    this.onConversionComplete(niftiFiles);
  }
}
