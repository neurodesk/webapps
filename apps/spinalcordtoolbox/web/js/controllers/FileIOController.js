/**
 * FileIOController
 *
 * Handles unified file input for SCT segmentation.
 * Auto-detects NIfTI vs DICOM and converts as needed.
 */

import { DicomController } from './DicomController.js';

export class FileIOController {
  constructor(options) {
    this.updateOutput = options.updateOutput || (() => {});
    this.onFileLoaded = options.onFileLoaded || (() => {});
    this.onFilesCleared = options.onFilesCleared || (() => {});
    this.onSessionsChanged = options.onSessionsChanged || (() => {});

    this.file = null;
    this.sessions = [];
    this.activeSessionId = null;
    this.nextSessionId = 1;

    this.dicomController = new DicomController({
      updateOutput: (msg) => this.updateOutput(msg),
      onConversionComplete: (niftiFile) => {
        this._addSessions([niftiFile], { activate: true, source: 'DICOM' });
        this._resetNativeInput();
      }
    });
  }

  getActiveFile() {
    return this.file;
  }

  getSessions() {
    return this.sessions.map(session => ({ ...session }));
  }

  getActiveSession() {
    return this.sessions.find(session => session.id === this.activeSessionId) || null;
  }

  hasValidData() {
    return this.file !== null;
  }

  handleFiles(files) {
    if (!files || files.length === 0) return;

    if (this._isNifti(files)) {
      const niftiFiles = this._findNiftiFiles(files);
      this._addSessions(niftiFiles, { activate: true, source: 'NIfTI' });
      this._resetNativeInput();
    } else {
      this.updateOutput(`Detected DICOM input (${files.length} files)`);
      this.dicomController.convertFiles(Array.from(files));
    }
  }

  handleDropItems(dataTransferItems) {
    if (!dataTransferItems || dataTransferItems.length === 0) return;

    // Check if any dropped item is a NIfTI file
    const files = [];
    for (let i = 0; i < dataTransferItems.length; i++) {
      const file = dataTransferItems[i].getAsFile?.();
      if (file) files.push(file);
    }

    if (files.length > 0 && this._isNifti(files)) {
      this.handleFiles(files);
      return;
    }

    // Otherwise treat as DICOM (may be folder drop)
    this.dicomController.convertDropItems(dataTransferItems);
  }

  _isNifti(files) {
    return Array.from(files).some(f => {
      const name = f.name.toLowerCase();
      return name.endsWith('.nii') || name.endsWith('.nii.gz');
    });
  }

  _findNiftiFile(files) {
    return Array.from(files).find(f => {
      const name = f.name.toLowerCase();
      return name.endsWith('.nii') || name.endsWith('.nii.gz');
    });
  }

  _findNiftiFiles(files) {
    return Array.from(files).filter(f => {
      const name = f.name.toLowerCase();
      return name.endsWith('.nii') || name.endsWith('.nii.gz');
    });
  }

  _addSessions(files, { activate = true, source = 'NIfTI' } = {}) {
    const niftiFiles = files.filter(Boolean);
    if (!niftiFiles.length) return;

    const newSessions = niftiFiles.map(file => ({
      id: `session-${this.nextSessionId++}`,
      file,
      name: file.name
    }));
    this.sessions.push(...newSessions);

    if (niftiFiles.length === 1) {
      this.updateOutput(`Loaded: ${niftiFiles[0].name}`);
    } else {
      this.updateOutput(`Loaded ${niftiFiles.length} ${source} images for comparison`);
    }

    if (activate) {
      this.activateSession(newSessions[0].id);
    } else {
      this._updateUI();
      this.onSessionsChanged(this.getSessions());
    }
  }

  activateSession(sessionId) {
    const session = this.sessions.find(item => item.id === sessionId);
    if (!session) return false;

    this.activeSessionId = session.id;
    this.file = session.file;
    this._updateUI();
    this.onSessionsChanged(this.getSessions());
    this.onFileLoaded(session.file, {
      session: { ...session },
      sessions: this.getSessions()
    });
    return true;
  }

  removeSession(sessionId) {
    const removedIndex = this.sessions.findIndex(session => session.id === sessionId);
    if (removedIndex < 0) return false;

    const wasActive = this.sessions[removedIndex].id === this.activeSessionId;
    this.sessions.splice(removedIndex, 1);

    if (!this.sessions.length) {
      this.clearFiles();
      return true;
    }

    if (wasActive) {
      const nextIndex = Math.min(removedIndex, this.sessions.length - 1);
      this.activateSession(this.sessions[nextIndex].id);
    } else {
      this._updateUI();
      this.onSessionsChanged(this.getSessions());
    }
    return true;
  }

  _updateUI() {
    const dropZone = document.getElementById('inputDropZone');
    const fileList = document.getElementById('fileList');
    const activeSession = this.getActiveSession();
    const activeName = activeSession?.name || '';

    if (dropZone) {
      dropZone.classList.toggle('has-files', this.sessions.length > 0);
      const label = dropZone.querySelector('.file-drop-label span');
      if (label) {
        if (!this.sessions.length) {
          label.textContent = 'Drop NIfTI or DICOM files';
        } else if (this.sessions.length === 1) {
          label.textContent = activeName;
        } else {
          label.textContent = `${this.sessions.length} images loaded`;
        }
      }
    }

    if (fileList) {
      fileList.innerHTML = '';
      for (const session of this.sessions) {
        const fileItem = document.createElement('div');
        fileItem.className = 'file-item';
        if (session.id === this.activeSessionId) fileItem.classList.add('active');

        const selectButton = document.createElement('button');
        selectButton.type = 'button';
        selectButton.className = 'file-session-select';
        selectButton.title = `Use ${session.name} for processing`;
        selectButton.textContent = session.name;
        selectButton.addEventListener('click', () => this.activateSession(session.id));
        fileItem.appendChild(selectButton);

        const removeButton = document.createElement('button');
        removeButton.type = 'button';
        removeButton.className = 'file-remove';
        removeButton.title = `Remove ${session.name}`;
        removeButton.setAttribute('aria-label', `Remove ${session.name}`);
        removeButton.textContent = '×';
        removeButton.addEventListener('click', () => this.removeSession(session.id));
        fileItem.appendChild(removeButton);

        fileList.appendChild(fileItem);
      }
    }
  }

  clearFiles() {
    this.file = null;
    this.sessions = [];
    this.activeSessionId = null;
    const dropZone = document.getElementById('inputDropZone');
    const fileList = document.getElementById('fileList');

    if (dropZone) {
      dropZone.classList.remove('has-files');
      const label = dropZone.querySelector('.file-drop-label span');
      if (label) label.textContent = 'Drop NIfTI or DICOM files';
    }
    if (fileList) fileList.innerHTML = '';
    this._resetNativeInput();
    this.onSessionsChanged(this.getSessions());
    this.onFilesCleared();
  }

  _resetNativeInput() {
    const fileInput = document.getElementById('fileInput');
    if (fileInput) fileInput.value = '';
  }
}
