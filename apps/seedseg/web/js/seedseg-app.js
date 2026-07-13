/**
 * SeedSeg - Browser-based prostate gold seed segmentation
 *
 * Main application class. Orchestrates controllers, viewer, and inference.
 */

import { FileIOController } from './controllers/FileIOController.js';
import { DicomController } from './controllers/DicomController.js';
import { DicompareController } from 'https://dicompare.neurodesk.org/embed/DicompareController.js';
import { DicompareReportRenderer } from 'https://dicompare.neurodesk.org/embed/DicompareReportRenderer.js';
import { ViewerController } from './controllers/ViewerController.js';
import { InferenceExecutor } from './controllers/InferenceExecutor.js';
import { ConsoleOutput } from './modules/ui/ConsoleOutput.js';
import { ProgressManager } from './modules/ui/ProgressManager.js';
import { ModalManager } from './modules/ui/ModalManager.js';
import * as Config from './app/config.js';

class SeedSegApp {
  constructor() {
    // NiiVue
    this.nv = new niivue.Niivue({
      ...Config.VIEWER_CONFIG,
      onLocationChange: (data) => {
        const el = document.getElementById('intensity');
        if (el) el.innerHTML = data.string;
      }
    });

    // UI modules
    this.console = new ConsoleOutput('consoleOutput');
    this.progress = new ProgressManager(Config.PROGRESS_CONFIG);

    // State
    this.inputFile = null;
    this.currentResultTab = 'input';
    this._buckets = { t1w: [], other: [] };

    this.init();
  }

  async init() {
    // Version display
    const versionEl = document.getElementById('appVersion');
    if (versionEl) versionEl.textContent = `v${Config.VERSION}`;
    const footerVersionEl = document.getElementById('footerVersion');
    if (footerVersionEl) footerVersionEl.textContent = `v${Config.VERSION}`;
    const aboutVersionEl = document.getElementById('aboutAppVersion');
    if (aboutVersionEl) aboutVersionEl.textContent = `v${Config.VERSION}`;

    // Controllers
    this.fileIOController = new FileIOController({
      updateOutput: (msg) => this.updateOutput(msg),
      onFileLoaded: (file) => this.onFileLoaded(file)
    });

    this.dicomController = new DicomController({
      updateOutput: (msg) => this.updateOutput(msg),
      onConversionComplete: (niftiFiles) => this._onDicomConversionComplete(niftiFiles),
      onFilesRetained: (files) => this._onDicomFilesRetained(files)
    });

    // dicompare validation
    this.dicompareController = new DicompareController({
      schemaUrl: 'https://dicompare.neurodesk.org/schemas/SeedSeg_Prostate_T1w_v1.0.json',
      updateOutput: (msg) => this.updateOutput(msg)
    });
    this.dicompareRenderer = new DicompareReportRenderer();

    this.viewerController = new ViewerController({
      nv: this.nv,
      updateOutput: (msg) => this.updateOutput(msg)
    });

    this.inferenceExecutor = new InferenceExecutor({
      updateOutput: (msg) => this.updateOutput(msg),
      setProgress: (val, text) => this.setProgress(val, text),
      onStageData: (data) => this.handleStageData(data),
      onComplete: () => this.onInferenceComplete(),
      onError: (msg) => this.onInferenceError(msg),
      onInitialized: () => {}
    });

    // Modals
    this.aboutModal = new ModalManager('aboutModal');
    this.citationsModal = new ModalManager('citationsModal');
    this.privacyModal = new ModalManager('privacyModal');
    this.dicompareModal = new ModalManager('dicompareModal');

    // Setup
    await this.setupViewer();
    this.setupEventListeners();
    this.setupInfoTooltips();

    // Log threading support
    if (crossOriginIsolated) {
      this.updateOutput('Multi-threaded WASM enabled');
    } else {
      this.updateOutput('Running single-threaded (COOP/COEP headers not set)');
    }

    // Start ONNX initialization in background
    this.inferenceExecutor.initialize();
  }

  async setupViewer() {
    await this.nv.attachTo('gl1');
    this.nv.setMultiplanarPadPixels(5);
    this.nv.setSliceType(this.nv.sliceTypeMultiplanar);
    this.nv.setInterpolation(true);
    this.nv.drawScene();
  }

  // ==================== Event Listeners ====================

  setupEventListeners() {
    // Unified file input
    this._setupUnifiedDropZone();

    // Run button
    const runBtn = document.getElementById('runSegmentation');
    if (runBtn) runBtn.addEventListener('click', () => this.runSegmentation());

    // Cancel button
    const cancelBtn = document.getElementById('cancelButton');
    if (cancelBtn) cancelBtn.addEventListener('click', () => this.cancelSegmentation());

    // Console clear
    const clearConsole = document.getElementById('clearConsole');
    if (clearConsole) clearConsole.addEventListener('click', () => this.console.clear());

    // View type buttons
    document.querySelectorAll('.view-tab[data-view]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.view-tab[data-view]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.viewerController.setViewType(btn.dataset.view);
      });
    });

    // Overlay opacity
    const opacitySlider = document.getElementById('overlayOpacity');
    if (opacitySlider) {
      opacitySlider.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        this.viewerController.setOverlayOpacity(val);
        const display = document.getElementById('overlayOpacityValue');
        if (display) display.textContent = `${Math.round(val * 100)}%`;
      });
    }

    // Window controls
    this.setupWindowControls();

    // Interpolation toggle
    const interpToggle = document.getElementById('interpolation');
    if (interpToggle) {
      interpToggle.addEventListener('change', (e) => {
        this.nv.setInterpolation(!e.target.checked);
        this.nv.drawScene();
      });
    }

    // Colorbar toggle
    const colorbarToggle = document.getElementById('colorbarToggle');
    if (colorbarToggle) {
      colorbarToggle.addEventListener('change', (e) => {
        this.nv.opts.isColorbar = e.target.checked;
        this.nv.drawScene();
      });
    }

    // Crosshair toggle
    const crosshairToggle = document.getElementById('crosshairToggle');
    if (crosshairToggle) {
      crosshairToggle.addEventListener('change', (e) => {
        this.nv.setCrosshairWidth(e.target.checked ? 1 : 0);
      });
    }

    // Download current volume
    const downloadBtn = document.getElementById('downloadCurrentVolume');
    if (downloadBtn) {
      downloadBtn.addEventListener('click', () => this.downloadCurrentVolume());
    }

    // Screenshot
    const screenshotBtn = document.getElementById('screenshotViewer');
    if (screenshotBtn) {
      screenshotBtn.addEventListener('click', () => this.saveScreenshot());
    }

    // Base colormap
    const colormapSelect = document.getElementById('colormapSelect');
    if (colormapSelect) {
      colormapSelect.addEventListener('change', (e) => {
        if (this.nv.volumes?.length) {
          this.nv.volumes[0].colormap = e.target.value;
          this.nv.updateGLVolume();
        }
      });
    }

    // Overlay colormap
    const overlayColormapSelect = document.getElementById('overlayColormapSelect');
    if (overlayColormapSelect) {
      overlayColormapSelect.addEventListener('change', (e) => {
        if (this.nv.volumes?.length > 1) {
          this.nv.volumes[1].colormap = e.target.value;
          this.nv.updateGLVolume();
        }
      });
    }

    // Clear results
    const clearResults = document.getElementById('clearResults');
    if (clearResults) clearResults.addEventListener('click', () => this.clearResults());

    // Modal buttons
    const aboutBtn = document.getElementById('aboutButton');
    if (aboutBtn) aboutBtn.addEventListener('click', () => this.aboutModal.open());
    const closeAbout = document.getElementById('closeAbout');
    if (closeAbout) closeAbout.addEventListener('click', () => this.aboutModal.close());

    const citationsBtn = document.getElementById('citationsButton');
    if (citationsBtn) citationsBtn.addEventListener('click', () => this.citationsModal.open());
    const closeCitations = document.getElementById('closeCitations');
    if (closeCitations) closeCitations.addEventListener('click', () => this.citationsModal.close());

    const privacyBtn = document.getElementById('privacyButton');
    if (privacyBtn) privacyBtn.addEventListener('click', () => this.privacyModal.open());
    const closePrivacy = document.getElementById('closePrivacy');
    if (closePrivacy) closePrivacy.addEventListener('click', () => this.privacyModal.close());

    // dicompare report
    document.getElementById('dicompareReportBtn')?.addEventListener('click', () => this.runDicompareReport());
    document.getElementById('closeDicompare')?.addEventListener('click', () => this.dicompareModal?.close());
    document.getElementById('closeDicompare2')?.addEventListener('click', () => this.dicompareModal?.close());
    document.getElementById('dicomparePrint')?.addEventListener('click', () => this.printDicompareReport());
  }

  _setupUnifiedDropZone() {
    const dropZone = document.getElementById('unifiedDrop');
    const fileInput = document.getElementById('unifiedFiles');
    if (!dropZone || !fileInput) return;

    fileInput.addEventListener('change', (e) => {
      const files = Array.from(e.target.files);
      if (files.length > 0) this._handleUnifiedFiles(files);
      fileInput.value = '';
    });

    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('dragover');
    });

    dropZone.addEventListener('dragleave', () => {
      dropZone.classList.remove('dragover');
    });

    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('dragover');

      const items = e.dataTransfer.items;
      if (!items || items.length === 0) return;

      // Check for directory entries (DICOM folder drop)
      let hasDirectory = false;
      for (let i = 0; i < items.length; i++) {
        const entry = items[i].webkitGetAsEntry?.();
        if (entry?.isDirectory) { hasDirectory = true; break; }
      }

      if (hasDirectory) {
        this._showDicomStatus(true);
        this.dicomController.convertDropItems(items);
      } else {
        const files = Array.from(e.dataTransfer.files);
        if (files.length > 0) this._handleUnifiedFiles(files);
      }
    });
  }

  _handleUnifiedFiles(files) {
    const niftiFiles = [];
    const dicomFiles = [];

    for (const file of files) {
      const name = file.name.toLowerCase();
      if (name.endsWith('.nii') || name.endsWith('.nii.gz')) {
        niftiFiles.push(file);
      } else if (name.endsWith('.json')) {
        // Ignore JSON sidecars
      } else if (name.endsWith('.dcm') || name.endsWith('.ima')) {
        dicomFiles.push(file);
      } else {
        // No recognized extension — treat as DICOM
        dicomFiles.push(file);
      }
    }

    if (dicomFiles.length > 0) {
      this._showDicomStatus(true);
      this.dicomController.convertFiles(dicomFiles);
    }

    if (niftiFiles.length > 0) {
      this._addFilesToBuckets(niftiFiles);
    }
  }

  _onDicomConversionComplete(niftiFiles) {
    this._showDicomStatus(false);
    if (!niftiFiles || niftiFiles.length === 0) return;
    this._addFilesToBuckets(niftiFiles, { fromDicom: true });
  }

  _showDicomStatus(show) {
    const el = document.getElementById('dicomStatus');
    if (el) el.style.display = show ? 'flex' : 'none';
  }

  _addFilesToBuckets(files, { fromDicom = false } = {}) {
    let t1wAssigned = fromDicom ? this._buckets.t1w.length > 0 : true;
    for (const file of files) {
      if (/t1/i.test(file.name)) {
        this._buckets.t1w.push(file);
        t1wAssigned = true;
      } else if (fromDicom && !t1wAssigned) {
        // First file from DICOM conversion defaults to T1w
        this._buckets.t1w.push(file);
        t1wAssigned = true;
      } else {
        this._buckets.other.push(file);
      }
    }
    this._onBucketsChanged();
  }

  _moveToBucket(fromBucket, index, toBucket) {
    const arr = this._buckets[fromBucket];
    if (!arr || index < 0 || index >= arr.length) return;
    const [file] = arr.splice(index, 1);
    this._buckets[toBucket].push(file);
    this._onBucketsChanged();
  }

  _removeFromBucket(bucket, index) {
    const arr = this._buckets[bucket];
    if (!arr || index < 0 || index >= arr.length) return;
    arr.splice(index, 1);
    this._onBucketsChanged();
  }

  _clearBucket(bucket) {
    this._buckets[bucket] = [];
    this._onBucketsChanged();
  }

  _onBucketsChanged() {
    const t1w = this._buckets.t1w;
    const hasFiles = t1w.length > 0 || this._buckets.other.length > 0;

    // Update triage UI
    this._renderFileTriage();

    // Update active file and run button
    const runBtn = document.getElementById('runSegmentation');
    if (t1w.length === 1) {
      this.fileIOController.setFile(t1w[0]);
      if (runBtn) runBtn.disabled = false;
    } else {
      this.fileIOController.clearFile();
      if (runBtn) runBtn.disabled = true;
    }

    // Update drop zone label
    const label = document.getElementById('unifiedDrop')?.querySelector('.file-drop-label span');
    if (label) {
      label.textContent = hasFiles ? 'Drop more files' : 'Drop NIfTI or DICOM files';
    }
    const dropZone = document.getElementById('unifiedDrop');
    if (dropZone) {
      if (hasFiles) dropZone.classList.add('has-files');
      else dropZone.classList.remove('has-files');
    }
  }

  _renderFileTriage() {
    const container = document.getElementById('fileTriage');
    if (!container) return;

    const { t1w, other } = this._buckets;
    const hasFiles = t1w.length > 0 || other.length > 0;

    if (!hasFiles) {
      container.style.display = 'none';
      container.innerHTML = '';
      return;
    }

    const hasError = t1w.length > 1;

    let html = '<div class="file-triage-section">';

    // T1w bucket
    html += `<div class="file-triage-bucket${hasError ? ' error' : ''}" data-bucket="t1w">`;
    html += `<div class="file-triage-bucket-header">
      <span>T1w</span>
      <span class="file-triage-bucket-count">${t1w.length}</span>
    </div>`;
    if (hasError) {
      html += '<div class="file-triage-error">Only one T1w image allowed. Drag extras to Other.</div>';
    }
    html += '<div class="file-triage-drop' + (t1w.length === 0 ? ' empty' : '') + '" data-bucket="t1w">';
    for (let i = 0; i < t1w.length; i++) {
      html += `<div class="file-triage-card" draggable="true" data-bucket="t1w" data-index="${i}">
        <svg class="file-triage-card-grip" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="19" r="1"/></svg>
        <span class="file-triage-card-name" title="${t1w[i].name}">${t1w[i].name}</span>
        <button class="file-triage-card-preview" data-bucket="t1w" data-index="${i}" title="Preview"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button>
        <button class="file-triage-card-delete" data-bucket="t1w" data-index="${i}" title="Remove">&times;</button>
      </div>`;
    }
    html += '</div></div>';

    // Other bucket
    html += '<div class="file-triage-bucket" data-bucket="other">';
    html += `<div class="file-triage-bucket-header">
      <span>Other</span>
      <span class="file-triage-bucket-count">${other.length}</span>
      ${other.length > 0 ? '<button class="file-triage-clear" data-bucket="other">Clear</button>' : ''}
    </div>`;
    html += '<div class="file-triage-drop' + (other.length === 0 ? ' empty' : '') + '" data-bucket="other">';
    for (let i = 0; i < other.length; i++) {
      html += `<div class="file-triage-card" draggable="true" data-bucket="other" data-index="${i}">
        <svg class="file-triage-card-grip" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="19" r="1"/></svg>
        <span class="file-triage-card-name" title="${other[i].name}">${other[i].name}</span>
        <button class="file-triage-card-preview" data-bucket="other" data-index="${i}" title="Preview"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button>
        <button class="file-triage-card-delete" data-bucket="other" data-index="${i}" title="Remove">&times;</button>
      </div>`;
    }
    html += '</div></div>';

    html += '</div>';
    container.innerHTML = html;
    container.style.display = 'block';

    this._setupTriageDragDrop(container);
    this._setupTriageClickHandlers(container);
  }

  _setupTriageDragDrop(container) {
    let dragSrcBucket = null;
    let dragSrcIndex = null;

    container.querySelectorAll('.file-triage-card').forEach(card => {
      card.addEventListener('dragstart', (e) => {
        dragSrcBucket = card.dataset.bucket;
        dragSrcIndex = parseInt(card.dataset.index);
        card.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
      });

      card.addEventListener('dragend', () => {
        card.classList.remove('dragging');
        container.querySelectorAll('.file-triage-drop').forEach(d => d.classList.remove('dragover'));
      });
    });

    container.querySelectorAll('.file-triage-drop').forEach(dropZone => {
      dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        dropZone.classList.add('dragover');
      });

      dropZone.addEventListener('dragleave', () => {
        dropZone.classList.remove('dragover');
      });

      dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('dragover');
        const targetBucket = dropZone.dataset.bucket;
        if (dragSrcBucket && targetBucket && dragSrcBucket !== targetBucket && dragSrcIndex != null) {
          this._moveToBucket(dragSrcBucket, dragSrcIndex, targetBucket);
        }
        dragSrcBucket = null;
        dragSrcIndex = null;
      });
    });
  }

  _setupTriageClickHandlers(container) {
    container.querySelectorAll('.file-triage-card-delete').forEach(btn => {
      btn.addEventListener('click', () => {
        this._removeFromBucket(btn.dataset.bucket, parseInt(btn.dataset.index));
      });
    });

    container.querySelectorAll('.file-triage-card-preview').forEach(btn => {
      btn.addEventListener('click', async () => {
        const bucket = btn.dataset.bucket;
        const index = parseInt(btn.dataset.index);
        const file = this._buckets[bucket]?.[index];
        if (!file) return;
        await this.viewerController.loadBaseVolume(file);
        this.syncWindowControls();
      });
    });

    container.querySelectorAll('.file-triage-clear').forEach(btn => {
      btn.addEventListener('click', () => {
        this._clearBucket(btn.dataset.bucket);
      });
    });
  }

  setupInfoTooltips() {
    document.querySelectorAll('.info-icon').forEach(icon => {
      const tooltip = icon.querySelector('.info-tooltip');
      if (!tooltip) return;

      icon.addEventListener('mouseenter', () => {
        tooltip.style.display = 'block';
        const iconRect = icon.getBoundingClientRect();
        const tipRect = tooltip.getBoundingClientRect();

        // Position above the icon, centered horizontally
        let top = iconRect.top - tipRect.height - 6;
        let left = iconRect.left + iconRect.width / 2 - tipRect.width / 2;

        // If it would go above viewport, show below instead
        if (top < 4) {
          top = iconRect.bottom + 6;
        }

        // Clamp horizontal to stay within viewport
        left = Math.max(4, Math.min(left, window.innerWidth - tipRect.width - 4));

        tooltip.style.top = `${top}px`;
        tooltip.style.left = `${left}px`;
      });

      icon.addEventListener('mouseleave', () => {
        tooltip.style.display = 'none';
      });
    });
  }

  // ==================== Viewer Controls ====================

  setupWindowControls() {
    const rangeMin = document.getElementById('rangeMin');
    const rangeMax = document.getElementById('rangeMax');
    const windowMin = document.getElementById('windowMin');
    const windowMax = document.getElementById('windowMax');
    const resetBtn = document.getElementById('resetWindow');
    if (!rangeMin || !rangeMax || !windowMin || !windowMax) return;

    const updateSelected = () => {
      const selected = document.getElementById('rangeSelected');
      if (!selected) return;
      const min = parseFloat(rangeMin.value);
      const max = parseFloat(rangeMax.value);
      selected.style.left = `${min}%`;
      selected.style.width = `${max - min}%`;
    };

    const applyFromSliders = () => {
      if (!this.nv.volumes.length) return;
      const vol = this.nv.volumes[0];
      const dataMin = vol.global_min ?? 0;
      const dataMax = vol.global_max ?? 1;
      const range = dataMax - dataMin || 1;
      const newMin = dataMin + (parseFloat(rangeMin.value) / 100) * range;
      const newMax = dataMin + (parseFloat(rangeMax.value) / 100) * range;
      windowMin.value = newMin.toPrecision(4);
      windowMax.value = newMax.toPrecision(4);
      vol.cal_min = newMin;
      vol.cal_max = newMax;
      this.nv.updateGLVolume();
      updateSelected();
    };

    const applyFromInputs = () => {
      if (!this.nv.volumes.length) return;
      const vol = this.nv.volumes[0];
      const newMin = parseFloat(windowMin.value);
      const newMax = parseFloat(windowMax.value);
      if (isNaN(newMin) || isNaN(newMax)) return;
      vol.cal_min = newMin;
      vol.cal_max = newMax;
      this.nv.updateGLVolume();
      this.syncSlidersToVolume();
    };

    rangeMin.addEventListener('input', () => {
      if (parseFloat(rangeMin.value) > parseFloat(rangeMax.value) - 1) {
        rangeMin.value = parseFloat(rangeMax.value) - 1;
      }
      applyFromSliders();
    });

    rangeMax.addEventListener('input', () => {
      if (parseFloat(rangeMax.value) < parseFloat(rangeMin.value) + 1) {
        rangeMax.value = parseFloat(rangeMin.value) + 1;
      }
      applyFromSliders();
    });

    windowMin.addEventListener('change', applyFromInputs);
    windowMax.addEventListener('change', applyFromInputs);

    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        if (!this.nv.volumes.length) return;
        const vol = this.nv.volumes[0];
        vol.cal_min = vol.global_min ?? 0;
        vol.cal_max = vol.global_max ?? 1;
        this.nv.updateGLVolume();
        this.syncWindowControls();
      });
    }
  }

  syncWindowControls() {
    if (!this.nv.volumes.length) return;
    const vol = this.nv.volumes[0];
    const windowMin = document.getElementById('windowMin');
    const windowMax = document.getElementById('windowMax');
    if (windowMin) windowMin.value = (vol.cal_min ?? 0).toPrecision(4);
    if (windowMax) windowMax.value = (vol.cal_max ?? 1).toPrecision(4);
    this.syncSlidersToVolume();

    // Enable download button
    const dlBtn = document.getElementById('downloadCurrentVolume');
    if (dlBtn) dlBtn.disabled = false;
  }

  syncSlidersToVolume() {
    if (!this.nv.volumes.length) return;
    const vol = this.nv.volumes[0];
    const dataMin = vol.global_min ?? 0;
    const dataMax = vol.global_max ?? 1;
    const range = dataMax - dataMin || 1;
    const rangeMin = document.getElementById('rangeMin');
    const rangeMax = document.getElementById('rangeMax');
    const selected = document.getElementById('rangeSelected');
    if (!rangeMin || !rangeMax) return;

    const pctMin = Math.max(0, Math.min(100, ((vol.cal_min - dataMin) / range) * 100));
    const pctMax = Math.max(0, Math.min(100, ((vol.cal_max - dataMin) / range) * 100));
    rangeMin.value = pctMin;
    rangeMax.value = pctMax;
    if (selected) {
      selected.style.left = `${pctMin}%`;
      selected.style.width = `${pctMax - pctMin}%`;
    }
  }

  downloadCurrentVolume() {
    if (!this.nv.volumes?.length) {
      this.updateOutput('No volume loaded');
      return;
    }
    const vol = this.nv.volumes[0];
    const name = (vol.name || 'volume').replace(/\.(nii|nii\.gz)$/i, '');
    const niftiBuffer = this.createNiftiFromVolume(vol);
    const blob = new Blob([niftiBuffer], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name}.nii`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    this.updateOutput(`Downloaded: ${name}.nii`);
  }

  createNiftiFromVolume(vol) {
    const hdr = vol.hdr;
    const img = vol.img;
    let datatype = 16, bitpix = 32, bytesPerVoxel = 4;
    if (img instanceof Float64Array) { datatype = 64; bitpix = 64; bytesPerVoxel = 8; }
    else if (img instanceof Int16Array) { datatype = 4; bitpix = 16; bytesPerVoxel = 2; }
    else if (img instanceof Uint8Array) { datatype = 2; bitpix = 8; bytesPerVoxel = 1; }

    const headerSize = 352;
    const buffer = new ArrayBuffer(headerSize + img.length * bytesPerVoxel);
    const view = new DataView(buffer);

    view.setInt32(0, 348, true);
    const dims = hdr.dims || [3, vol.dims[1], vol.dims[2], vol.dims[3], 1, 1, 1, 1];
    for (let i = 0; i < 8; i++) view.setInt16(40 + i * 2, dims[i] || 0, true);
    view.setInt16(70, datatype, true);
    view.setInt16(72, bitpix, true);
    const pixdim = hdr.pixDims || [1, 1, 1, 1, 1, 1, 1, 1];
    for (let i = 0; i < 8; i++) view.setFloat32(76 + i * 4, pixdim[i] || 1, true);
    view.setFloat32(108, headerSize, true);
    view.setFloat32(112, hdr.scl_slope || 1, true);
    view.setFloat32(116, hdr.scl_inter || 0, true);
    view.setUint8(123, 10);
    view.setInt16(252, hdr.qform_code || 1, true);
    view.setInt16(254, hdr.sform_code || 1, true);
    if (hdr.affine) {
      for (let i = 0; i < 4; i++) {
        view.setFloat32(280 + i * 4, hdr.affine[0][i] || 0, true);
        view.setFloat32(296 + i * 4, hdr.affine[1][i] || 0, true);
        view.setFloat32(312 + i * 4, hdr.affine[2][i] || 0, true);
      }
    }
    view.setUint8(344, 0x6E); view.setUint8(345, 0x2B);
    view.setUint8(346, 0x31); view.setUint8(347, 0x00);

    new Uint8Array(buffer, headerSize).set(new Uint8Array(img.buffer, img.byteOffset, img.byteLength));
    return buffer;
  }

  saveScreenshot() {
    let filename = 'seedseg_screenshot.png';
    if (this.nv.volumes?.length) {
      const name = (this.nv.volumes[0].name || 'volume').replace(/\.(nii|nii\.gz)$/i, '');
      filename = `${name}_screenshot.png`;
    }
    this.nv.saveScene(filename);
    this.updateOutput(`Screenshot saved: ${filename}`);
  }

  // ==================== File Handling ====================

  async onFileLoaded(file) {
    this.inputFile = file;
    await this.viewerController.loadBaseVolume(file);

    // Sync viewer controls to loaded volume
    this.syncWindowControls();

    // Enable run button
    const runBtn = document.getElementById('runSegmentation');
    if (runBtn) runBtn.disabled = false;

    // Update result tab state without reloading the volume
    this.currentResultTab = 'input';
    document.querySelectorAll('.stage-btn').forEach(b => b.classList.remove('active'));
    const overlayControl = document.getElementById('overlayControl');
    if (overlayControl) overlayControl.classList.add('hidden');
    const overlayColormapSelect = document.getElementById('overlayColormapSelect');
    if (overlayColormapSelect) overlayColormapSelect.classList.add('hidden');
  }

  // ==================== Inference ====================

  async runSegmentation() {
    if (!this.fileIOController.hasValidData()) {
      this.updateOutput('No input volume loaded');
      return;
    }

    const file = this.fileIOController.getActiveFile();

    // Gather settings
    const selectedModels = [];
    Config.MODELS.forEach((model, i) => {
      const cb = document.getElementById(`model${i}`);
      if (!cb || cb.checked) selectedModels.push(model.name);
    });

    if (selectedModels.length === 0) {
      this.updateOutput('No models selected');
      return;
    }

    const threshold = parseFloat(document.getElementById('probThreshold')?.value || '0.1');
    const nMarkers = parseInt(document.getElementById('nMarkers')?.value || '3');
    const modelBaseUrl = new URL(Config.MODEL_BASE_URL, window.location.href).href;

    // Read file
    const inputData = await file.arrayBuffer();

    // Disable run, enable cancel
    const runBtn = document.getElementById('runSegmentation');
    const cancelBtn = document.getElementById('cancelButton');
    if (runBtn) runBtn.disabled = true;
    if (cancelBtn) cancelBtn.disabled = false;

    // Clear previous results
    this.inferenceExecutor.clearResults();
    this.disableAllResultTabs();

    // Run
    await this.inferenceExecutor.run({
      inputData,
      settings: {
        selectedModels,
        threshold,
        nMarkers,
        modelBaseUrl
      }
    });
  }

  cancelSegmentation() {
    this.inferenceExecutor.cancel();
    const runBtn = document.getElementById('runSegmentation');
    const cancelBtn = document.getElementById('cancelButton');
    if (runBtn) runBtn.disabled = false;
    if (cancelBtn) cancelBtn.disabled = true;
  }

  // ==================== Results ====================

  static STAGE_NAMES = {
    input: 'Input',
    model1: 'Model 1',
    model2: 'Model 2',
    model3: 'Model 3',
    model4: 'Model 4',
    avgProb: 'Average',
    consensus: 'Consensus'
  };

  handleStageData(data) {
    // Show and expand results section
    const resultsSection = document.getElementById('resultsSection');
    if (resultsSection) {
      resultsSection.classList.remove('hidden');
      resultsSection.classList.remove('collapsed');
    }

    // Add Input button on first result
    if (!document.getElementById('stage-item-input')) {
      this.addStageButton('input');
    }

    // Add stage button if not already present
    this.addStageButton(data.stage);

    // Auto-show consensus when it arrives
    if (data.stage === 'consensus') {
      this.showResult('consensus');
    }
  }

  addStageButton(stage) {
    const container = document.getElementById('stageButtons');
    if (!container || document.getElementById(`stage-item-${stage}`)) return;

    const displayName = SeedSegApp.STAGE_NAMES[stage] || stage;

    const item = document.createElement('div');
    item.className = 'stage-item';
    item.id = `stage-item-${stage}`;

    const showBtn = document.createElement('button');
    showBtn.className = 'btn stage-btn';
    showBtn.textContent = displayName;
    showBtn.addEventListener('click', () => this.showResult(stage));
    item.appendChild(showBtn);

    if (stage !== 'input') {
      const dlBtn = document.createElement('button');
      dlBtn.className = 'download-btn';
      dlBtn.title = `Download ${displayName}`;
      dlBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
      dlBtn.addEventListener('click', () => this.inferenceExecutor.downloadStage(stage));
      item.appendChild(dlBtn);
    }

    container.appendChild(item);
  }

  onInferenceComplete() {
    const runBtn = document.getElementById('runSegmentation');
    const cancelBtn = document.getElementById('cancelButton');
    const statusText = document.getElementById('statusText');
    if (runBtn) runBtn.disabled = false;
    if (cancelBtn) cancelBtn.disabled = true;
    if (statusText) statusText.textContent = 'Ready';
  }

  onInferenceError(msg) {
    const runBtn = document.getElementById('runSegmentation');
    const cancelBtn = document.getElementById('cancelButton');
    const statusText = document.getElementById('statusText');
    if (runBtn) runBtn.disabled = false;
    if (cancelBtn) cancelBtn.disabled = true;
    if (statusText) statusText.textContent = 'Error';
  }

  async showResult(stage) {
    this.currentResultTab = stage;

    // Update active state on stage buttons
    document.querySelectorAll('.stage-btn').forEach(b => b.classList.remove('active'));
    const item = document.getElementById(`stage-item-${stage}`);
    if (item) {
      const btn = item.querySelector('.stage-btn');
      if (btn) btn.classList.add('active');
    }

    const overlayControl = document.getElementById('overlayControl');
    const overlayColormapSelect = document.getElementById('overlayColormapSelect');

    if (stage === 'input') {
      // Hide overlay controls
      if (overlayControl) overlayControl.classList.add('hidden');
      if (overlayColormapSelect) overlayColormapSelect.classList.add('hidden');

      if (this.inputFile) {
        await this.viewerController.loadBaseVolume(this.inputFile);
        this.syncWindowControls();
      }
      return;
    }

    const result = this.inferenceExecutor.getResult(stage);
    if (!result?.file || !this.inputFile) return;

    // Show overlay controls
    if (overlayControl) overlayControl.classList.remove('hidden');
    if (overlayColormapSelect) overlayColormapSelect.classList.remove('hidden');

    // Determine colormap based on stage type
    const colormap = (stage === 'consensus') ? 'red' : 'warm';

    // Sync overlay colormap select
    if (overlayColormapSelect) overlayColormapSelect.value = colormap;

    await this.viewerController.showResultAsOverlay(this.inputFile, result.file, colormap);
    this.syncWindowControls();
  }

  disableAllResultTabs() {
    // Clear dynamically added stage buttons
    const container = document.getElementById('stageButtons');
    if (container) container.innerHTML = '';
  }

  clearResults() {
    this.inferenceExecutor.clearResults();
    this.disableAllResultTabs();

    const resultsSection = document.getElementById('resultsSection');
    if (resultsSection) {
      resultsSection.classList.add('hidden');
      resultsSection.classList.add('collapsed');
    }

    // Hide overlay controls
    const overlayControl = document.getElementById('overlayControl');
    if (overlayControl) overlayControl.classList.add('hidden');
    const overlayColormapSelect = document.getElementById('overlayColormapSelect');
    if (overlayColormapSelect) overlayColormapSelect.classList.add('hidden');

    if (this.inputFile) {
      this.viewerController.loadBaseVolume(this.inputFile);
    }
  }

  // ==================== dicompare Integration ====================

  /**
   * Callback when DICOM files are retained for validation.
   */
  async _onDicomFilesRetained(files) {
    await this.dicompareController.retainDicomFiles(files);
    const btn = document.getElementById('dicompareReportBtn');
    if (btn) {
      btn.disabled = files.length === 0;
    }
  }

  /**
   * Run dicompare validation and display results in modal.
   */
  async runDicompareReport() {
    if (!this.dicompareController.hasFiles()) {
      this.updateOutput('No DICOM files available for validation.');
      return;
    }

    const body = document.getElementById('dicompareModalBody');
    const footer = document.getElementById('dicompareModalFooter');

    // If results are already cached, just re-display them
    const cached = this.dicompareController.getCachedResults();
    if (cached) {
      this.dicompareModal.open();
      this.dicompareRenderer.render(body, cached);
      if (footer) footer.style.display = '';
      return;
    }

    // Open modal with loading state
    this.dicompareModal.open();
    if (body) {
      body.innerHTML = `
        <div class="dicompare-loading">
          <div class="dicompare-spinner"></div>
          <p class="dicompare-loading-text" id="dicompareLoadingText">Initializing Python runtime...</p>
          <div class="dicompare-progress-bar">
            <div class="dicompare-progress-fill" id="dicompareProgressFill"></div>
          </div>
        </div>
      `;
    }
    if (footer) footer.style.display = 'none';

    try {
      const result = await this.dicompareController.runValidation((progress) => {
        const textEl = document.getElementById('dicompareLoadingText');
        const fillEl = document.getElementById('dicompareProgressFill');
        if (textEl) textEl.textContent = progress.currentOperation;
        if (fillEl) fillEl.style.width = `${progress.percentage}%`;
      });

      // Render results
      this.dicompareRenderer.render(body, result);
      if (footer) footer.style.display = '';
    } catch (error) {
      if (body) {
        body.innerHTML = `
          <div class="dicompare-error">
            <p>Validation failed: ${error.message}</p>
          </div>
        `;
      }
      console.error('dicompare validation error:', error);
    }
  }

  /**
   * Print the dicompare report in a new window.
   */
  printDicompareReport() {
    if (!this.dicompareController.complianceResults) return;
    const html = this.dicompareRenderer.generatePrintHtml({
      acquisitions: this.dicompareController.acquisitions,
      complianceResults: this.dicompareController.complianceResults,
      schema: JSON.parse(this.dicompareController.schemaContent || '{}')
    });
    const printWindow = window.open('', '_blank');
    if (printWindow) {
      printWindow.document.write(html);
      printWindow.document.close();
      printWindow.focus();
    }
  }

  // ==================== UI Helpers ====================

  updateOutput(msg) {
    this.console.log(msg);
  }

  setProgress(value, text) {
    this.progress.setProgress(value);
    const statusText = document.getElementById('statusText');
    if (statusText) {
      if (value >= 1) statusText.textContent = 'Complete';
      else if (text) statusText.textContent = text;
      else if (value > 0) statusText.textContent = 'Processing...';
    }
  }

  // Global method for HTML onclick handler
  clearFile() {
    this._buckets = { t1w: [], other: [] };
    this._onBucketsChanged();
  }
}

// Initialize app
window.addEventListener('DOMContentLoaded', () => {
  window.app = new SeedSegApp();
});
