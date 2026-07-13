/**
 * FileIOController
 *
 * Handles MRI file input for segmentation and metrics.
 * Auto-detects NIfTI vs DICOM files and keeps multiple contrast roles.
 */
import { isNiftiFile as sharedIsNiftiFile } from '@neurodesk/webapp-components/file-io';

const FILE_ROLE_OPTIONS = [
  'anatomical',
  'dixon_fat',
  'dixon_water',
  'dixon_opposed_phase',
  'dixon_in_phase',
  'segmentation'
];

export class FileIOController {
  constructor(options) {
    this.updateOutput = options.updateOutput || (() => {});
    this.onFileLoaded = options.onFileLoaded || (() => {});
    this.onViewFile = options.onViewFile || this.onFileLoaded;
    this.onFilesChanged = options.onFilesChanged || (() => {});
    this.onDicomFiles = options.onDicomFiles || (() => {});

    this.entries = [];
    this.nextEntryId = 1;
  }

  getActiveFile() {
    return this.getPrimaryImageEntry()?.file || null;
  }

  getEntries() {
    return this.entries;
  }

  getPrimaryImageEntry() {
    return this.entries.find(entry => entry.role !== 'segmentation' && entry.runSegmentation) ||
      this.entries.find(entry => entry.role !== 'segmentation') ||
      null;
  }

  getEntriesByRole(role) {
    return this.entries.filter(entry => entry.role === role);
  }

  getSegmentEntries() {
    return this.entries.filter(entry => entry.role !== 'segmentation' && entry.runSegmentation);
  }

  getSegmentationEntries() {
    return this.getEntriesByRole('segmentation');
  }

  hasValidData() {
    return this.entries.length > 0;
  }

  static isNiftiFile(file) {
    return sharedIsNiftiFile(file); // shared detector: .nii / .nii.gz (accepts File or name)
  }

  static fileKey(file) {
    return `${file.name || ''}:${file.size || 0}:${file.lastModified || 0}`;
  }

  static inferRole(file) {
    const name = (file.name || '').toLowerCase();
    const compactName = name.replace(/[^a-z0-9]+/g, '');
    if (/(^|[_\-.])(seg|label|labels|mask|segmentation)([_\-.]|$)/.test(name)) return 'segmentation';
    if (/(^|[_\-.])(fat|fatimg|fat-image)([_\-.]|$)/.test(name) || name.includes('dixon-fat')) return 'dixon_fat';
    if (/(^|[_\-.])(water|wat|waterimg|water-image)([_\-.]|$)/.test(name) || name.includes('dixon-water')) return 'dixon_water';
    if (/(^|[_\-.])(opp|opposed|out)([_\-.]|$)/.test(name) || compactName.includes('opposedphase') || compactName.includes('oppphase') || compactName.includes('outphase') || compactName.includes('outofphase')) return 'dixon_opposed_phase';
    if (compactName.includes('inphase')) return 'dixon_in_phase';
    return 'anatomical';
  }

  static roleLabel(role) {
    switch (role) {
      case 'anatomical':
        return 'T1/T2 SE or segmentation contrast';
      case 'dixon_fat':
        return 'Dixon fat image';
      case 'dixon_water':
        return 'Dixon water image';
      case 'dixon_opposed_phase':
        return 'Dixon opposed-phase image';
      case 'dixon_in_phase':
        return 'Dixon in-phase image';
      case 'segmentation':
        return 'Segmentation label map';
      default:
        return role;
    }
  }

  handleFileInput(event) {
    const files = Array.from(event.target.files);
    if (files.length === 0) {
      if (event.target) event.target.value = '';
      return;
    }

    const niftiFiles = files.filter(f => FileIOController.isNiftiFile(f));
    if (niftiFiles.length > 0) {
      this.addFiles(niftiFiles);
    } else {
      // Treat as DICOM
      this.onDicomFiles(files);
    }
    if (event.target) event.target.value = '';
  }

  handleDroppedFiles(files) {
    if (!files || files.length === 0) return;

    const niftiFiles = files.filter(f => FileIOController.isNiftiFile(f));
    if (niftiFiles.length > 0) {
      this.addFiles(niftiFiles);
    } else {
      this.onDicomFiles(files);
    }
  }

  setFile(file) {
    this.setFiles([file]);
  }

  createEntry(file) {
    const role = FileIOController.inferRole(file);
    return {
      id: String(this.nextEntryId++),
      file,
      role,
      runSegmentation: role !== 'segmentation'
    };
  }

  addFiles(files) {
    const niftiFiles = Array.from(files || []).filter(file => FileIOController.isNiftiFile(file));
    if (niftiFiles.length === 0) {
      this.updateOutput('No supported NIfTI files selected');
      this.onFilesChanged(this.entries);
      return;
    }

    const hadPrimary = !!this.getPrimaryImageEntry();
    const existingKeys = new Set(this.entries.map(entry => FileIOController.fileKey(entry.file)));
    const newEntries = [];
    for (const file of niftiFiles) {
      const key = FileIOController.fileKey(file);
      if (existingKeys.has(key)) continue;
      existingKeys.add(key);
      newEntries.push(this.createEntry(file));
    }

    if (newEntries.length === 0) {
      this.updateOutput('Selected NIfTI file(s) are already loaded');
      this.onFilesChanged(this.entries);
      return;
    }

    this.entries.push(...newEntries);
    this.updateFileListUI();

    const primary = this.getPrimaryImageEntry();
    const names = newEntries.map(entry => entry.file.name).join(', ');
    this.updateOutput(`Added ${newEntries.length} NIfTI file(s): ${names}`);
    if (!hadPrimary && primary) this.onFileLoaded(primary.file);
    this.onFilesChanged(this.entries);
  }

  setFiles(files) {
    const niftiFiles = Array.from(files || []).filter(file => FileIOController.isNiftiFile(file));
    this.entries = niftiFiles.map(file => this.createEntry(file));
    this.updateFileListUI();

    if (this.entries.length === 0) {
      this.updateOutput('No supported NIfTI files loaded');
      this.onFilesChanged(this.entries);
      return;
    }

    const primary = this.getPrimaryImageEntry();
    const names = this.entries.map(entry => entry.file.name).join(', ');
    this.updateOutput(`Loaded ${this.entries.length} NIfTI file(s): ${names}`);
    if (primary) this.onFileLoaded(primary.file);
    this.onFilesChanged(this.entries);
  }

  updateEntry(id, patch) {
    const entry = this.entries.find(item => item.id === id);
    if (!entry) return;

    Object.assign(entry, patch);
    if (entry.role === 'segmentation') entry.runSegmentation = false;
    this.updateFileListUI();
    this.onFilesChanged(this.entries);
  }

  removeEntry(id) {
    this.entries = this.entries.filter(entry => entry.id !== id);
    this.updateFileListUI();
    this.onFilesChanged(this.entries);
  }

  updateFileListUI() {
    const listElement = document.getElementById('fileList');
    const fileDrop = listElement?.closest('.upload-group')?.querySelector('.file-drop');

    if (!listElement) return;

    listElement.innerHTML = '';

    if (this.entries.length > 0) {
      fileDrop?.classList.add('has-files');
      this.entries.forEach((entry) => {
        const fileItem = document.createElement('div');
        fileItem.className = 'file-item';

        const topRow = document.createElement('div');
        topRow.className = 'file-item-row';

        const name = document.createElement('span');
        name.className = 'file-name';
        name.textContent = entry.file.name;

        const remove = document.createElement('button');
        remove.className = 'file-remove';
        remove.type = 'button';
        remove.title = 'Remove file';
        remove.textContent = '×';
        remove.addEventListener('click', () => this.removeEntry(entry.id));

        topRow.appendChild(name);
        topRow.appendChild(remove);

        const controls = document.createElement('div');
        controls.className = 'file-entry-controls';

        const role = document.createElement('select');
        role.className = 'file-role-select';
        role.value = entry.role;
        for (const value of FILE_ROLE_OPTIONS) {
          const option = document.createElement('option');
          option.value = value;
          option.textContent = FileIOController.roleLabel(value);
          role.appendChild(option);
        }
        role.value = entry.role;
        role.addEventListener('change', (event) => {
          this.updateEntry(entry.id, { role: event.target.value });
        });

        const viewButton = document.createElement('button');
        viewButton.className = 'btn btn-secondary btn-sm file-view-button';
        viewButton.type = 'button';
        viewButton.title = 'Show in viewer';
        viewButton.textContent = 'View';
        viewButton.disabled = entry.role === 'segmentation';
        viewButton.addEventListener('click', () => this.onViewFile(entry.file));

        const runLabel = document.createElement('label');
        runLabel.className = 'viewer-checkbox file-segment-toggle';
        const run = document.createElement('input');
        run.type = 'checkbox';
        run.checked = entry.runSegmentation;
        run.disabled = entry.role === 'segmentation';
        run.addEventListener('change', (event) => {
          this.updateEntry(entry.id, { runSegmentation: event.target.checked });
        });
        runLabel.appendChild(run);
        runLabel.appendChild(document.createTextNode('Run segmentation'));

        controls.appendChild(role);
        controls.appendChild(viewButton);
        controls.appendChild(runLabel);
        fileItem.appendChild(topRow);
        fileItem.appendChild(controls);
        listElement.appendChild(fileItem);
      });

      const label = fileDrop?.querySelector('.file-drop-label span');
      if (label) label.textContent = `${this.entries.length} file${this.entries.length === 1 ? '' : 's'} selected`;
    } else {
      fileDrop?.classList.remove('has-files');
      const label = fileDrop?.querySelector('.file-drop-label span');
      if (label) label.textContent = 'Drop NIfTI, NIfTI labels, or DICOM files';
    }
  }

  clearFiles() {
    this.entries = [];
    this.updateFileListUI();
    this.onFilesChanged(this.entries);
  }
}
