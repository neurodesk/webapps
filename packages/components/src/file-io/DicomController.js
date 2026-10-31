import { isNiftiFile, filesFromDataTransferItems } from './detectFiles.js';

// dcm2niix's default name starts with the input folder (%f), which can hold a patient name.
const DICOM_NAMING = ['-f', '%p_%t_%s'];

export function createDicomConverter({ moduleUrl, timeoutMs = 120000 }) {
  if (typeof moduleUrl !== 'string' || !moduleUrl) throw new Error('A DICOM converter module URL is required');
  return async (files, { signal } = {}) => {
    const { runDcm2niix } = await import(/* @vite-ignore */ moduleUrl);
    return runDcm2niix(files, { niftiOnly: false, signal, timeoutMs, args: DICOM_NAMING });
  };
}

export async function readSingleImage(files, options = {}) {
  const list = Array.from(files || []).filter(file => !/\.(json|bval|bvec)$/i.test(file.name));
  if (!list.length) return null;
  if (list.length === 1 && isNiftiFile(list[0])) return list[0];
  if (list.some(isNiftiFile)) throw new Error('Choose one NIfTI image or one DICOM series for this field.');
  return new DicomController({ ...options, requireSingle: true }).convertFiles(list);
}

export class DicomController {
  constructor(options = {}) {
    this.convert = createDicomConverter({ moduleUrl: options.moduleUrl || new URL('../../dcm2niix/index.jpeg.js', import.meta.url).href });
    this.updateOutput = options.updateOutput || (() => {});
    this.onConversionComplete = options.onConversionComplete || (() => {});
    this.onDicomFiles = options.onDicomFiles || null;
    this.throwOnError = options.throwOnError ?? true;
    this.requireSingle = options.requireSingle ?? false;
    this.converting = false;
  }

  async convertFiles(files) {
    const inputFiles = Array.from(files || []);
    if (!inputFiles.length) return null;
    this.converting = true;
    this.updateOutput(`Converting ${inputFiles.length} DICOM files...`);
    try {
      if (this.onDicomFiles) await this.onDicomFiles(inputFiles);
      const result = await this.convert(inputFiles);
      const output = this._selectNifti(result);
      await this.onConversionComplete(output, result);
      return output;
    } catch (error) {
      this.updateOutput(`DICOM conversion failed: ${error.message}`);
      if (this.throwOnError) throw error;
      return null;
    } finally {
      this.converting = false;
    }
  }

  async convertDropItems(items) {
    const files = await filesFromDataTransferItems(items);
    if (!files.length) {
      if (items?.length) this.updateOutput('No DICOM files found in dropped items.');
      return null;
    }
    return this.convertFiles(files);
  }

  _selectNifti(resultFiles) {
    const niftiFiles = Array.from(resultFiles || []).filter(isNiftiFile);
    if (!niftiFiles.length) throw new Error('No NIfTI files produced. Are these valid DICOM files?');
    if (this.requireSingle && niftiFiles.length > 1) throw new Error('Several DICOM series found. Select the files for one series at a time.');
    this.updateOutput(`Converted ${niftiFiles.length} NIfTI file(s). Using: ${niftiFiles[0].name}`);
    return niftiFiles[0];
  }
}
