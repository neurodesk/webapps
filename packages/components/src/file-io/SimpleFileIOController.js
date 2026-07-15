import { DicomController } from './DicomController.js';
import { isNiftiFile } from './detectFiles.js';

/** Single-volume NIfTI/DICOM ingestion shared by the static imaging apps. */
export class SimpleFileIOController {
  constructor(options = {}) {
    this.updateOutput = options.updateOutput || (() => {});
    this.onFileLoaded = options.onFileLoaded || (() => {});
    this.file = null;
    this.dicomController = options.dicomController || new DicomController({
      moduleUrl: options.dcm2niixModuleUrl,
      throwOnError: false,
      updateOutput: message => this.updateOutput(message),
      onConversionComplete: niftiFile => this._acceptFile(niftiFile)
    });
  }

  getActiveFile() { return this.file; }
  hasValidData() { return this.file !== null; }

  handleFiles(files) {
    if (!files?.length) return;
    const inputFiles = Array.from(files);
    const niftiFile = inputFiles.find(isNiftiFile);
    if (niftiFile) return this._acceptFile(niftiFile, true);
    this.updateOutput(`Detected DICOM input (${inputFiles.length} files)`);
    this.dicomController.convertFiles(inputFiles);
  }

  handleDropItems(items) {
    if (!items?.length) return;
    const files = Array.from(items, item => item.getAsFile?.()).filter(Boolean);
    if (files.some(isNiftiFile)) return this.handleFiles(files);
    this.dicomController.convertDropItems(items);
  }

  clearFiles() {
    this.file = null;
    const dropZone = document.getElementById('inputDropZone');
    const fileList = document.getElementById('fileList');
    if (dropZone) {
      dropZone.classList.remove('has-files');
      const label = dropZone.querySelector('.file-drop-label span');
      if (label) label.textContent = 'Drop NIfTI or DICOM files';
    }
    if (fileList) fileList.innerHTML = '';
    this._resetNativeInput();
  }

  _acceptFile(file, announce = false) {
    this.file = file;
    this._updateUI(file.name);
    if (announce) this.updateOutput(`Loaded: ${file.name}`);
    this.onFileLoaded(file);
    this._resetNativeInput();
  }

  _updateUI(filename) {
    const dropZone = document.getElementById('inputDropZone');
    const fileList = document.getElementById('fileList');
    if (dropZone) {
      dropZone.classList.add('has-files');
      const label = dropZone.querySelector('.file-drop-label span');
      if (label) label.textContent = filename;
    }
    if (fileList) {
      fileList.innerHTML = '';
      const fileItem = document.createElement('div');
      fileItem.className = 'file-item';
      fileItem.innerHTML = `
        <span>${filename}</span>
        <button class="file-remove" onclick="app.clearFiles()">&times;</button>
      `;
      fileList.appendChild(fileItem);
    }
  }

  _resetNativeInput() {
    const fileInput = document.getElementById('fileInput');
    if (fileInput) fileInput.value = '';
  }
}
