import { bindSectionDisclosures, bindInfoTooltips } from '@neurodesk/webapp-components/ui';
bindSectionDisclosures(document);

/**
 * SeedSeg - Browser-based prostate gold seed segmentation
 *
 * Main application class. Orchestrates controllers, viewer, and inference.
 */

<<<<<<< monorepo
import { registerSeedSegAutomation } from './automation.js';
import { SeedSegInputSet } from './controllers/SeedSegInputSet.js';
import { SeedSegDicomInput } from './controllers/SeedSegDicomInput.js';
import { DicompareReportRenderer } from '@neurodesk/webapp-components/ui';
import { ViewerController } from '@neurodesk/webapp-components';
import { SeedSegPipeline } from './controllers/SeedSegPipeline.js';
import { ConsoleOutput, ProgressManager, ModalManager, bindWindowControls, createMaskEditor, renderInfoIcon } from '@neurodesk/webapp-components/ui';
import { createNiftiFromVolume, readNifti } from '@neurodesk/webapp-components/file-io';
=======
import { FileIOController } from './controllers/FileIOController.js';
import { DicomController } from './controllers/DicomController.js';
import { ViewerController } from './controllers/ViewerController.js';
import { InferenceExecutor } from './controllers/InferenceExecutor.js';
import { ConsoleOutput } from './modules/ui/ConsoleOutput.js';
import { ProgressManager } from './modules/ui/ProgressManager.js';
import { ModalManager } from './modules/ui/ModalManager.js';
>>>>>>> upstream
import * as Config from './app/config.js';
import { resolveModels, validateSelection } from '../vendor/seedseg/src/assets.js';
import { summarizeMarkers } from '../vendor/seedseg/src/nnunet.js';
import { detectionsHint } from './app/detections.js';
import { clearResultsAfterEditing, isEditableStage, markerLabelNames, replaceWithEdit, stageLabel } from './app/mask-edit.js';

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
    // Shared ConsoleOutput themed to reproduce SeedSeg's `console-*` DOM with
    // plain console.log mirroring.
    this.console = new ConsoleOutput({
      outputElementId: 'consoleOutput',
      lineClass: 'console-line',
      timeClass: 'console-time',
      messageClass: 'console-message',
      separator: ' ',
      levelOn: 'message',
      levelClass: (level) => (level === 'info' ? '' : level),
      mirror: (text) => console.log(text),
    });
    this.progress = new ProgressManager(Config.PROGRESS_CONFIG);

    // State
    this.inputFile = null;
    this.currentResultTab = 'input';
    this._buckets = { t1w: [], other: [] };
    this.dicompareFiles = [];

    this.init();
  }

  async init() {
    // Version display
    const versionEl = document.getElementById('appVersion');
    if (versionEl) versionEl.textContent = `v${Config.VERSION}`;
    const aboutVersionEl = document.getElementById('aboutAppVersion');
    if (aboutVersionEl) aboutVersionEl.textContent = `v${Config.VERSION}`;

    // Controllers
    this.fileIOController = new SeedSegInputSet({
      updateOutput: (msg) => this.updateOutput(msg),
      onFileLoaded: (file) => this.onFileLoaded(file)
    });

    this.dicomController = new SeedSegDicomInput({
      updateOutput: (msg) => this.updateOutput(msg),
      onConversionComplete: (niftiFiles) => this._onDicomConversionComplete(niftiFiles),
      onFilesRetained: (files) => this._onDicomFilesRetained(files)
    });

<<<<<<< monorepo
    this.dicompareRenderer = new DicompareReportRenderer();
=======
    // dicompare validation: loaded on first use (_loadDicompare)
    this.dicompareController = null;
    this.dicompareRenderer = null;
>>>>>>> upstream

    this.viewerController = new ViewerController({
      nv: this.nv,
      updateOutput: (msg) => this.updateOutput(msg)
    });

    this.maskEditorOptions = {
      nv: this.nv,
      onApply: (stage, file, { original }) => this.onMaskApplied(stage, file, original),
      onCancel: () => this.onMaskEditClosed(),
      onError: (_stage, error) => this.onMaskEditError(error)
    };
    this.maskEditor = createMaskEditor(this.maskEditorOptions);
    this.maskEditor.addEventListener('nd-mask-edit-end', () => this.setEditButtonsEnabled(true));
    this.maskEditor.addEventListener('nd-mask-edit-start', (event) => this.progress.setText(event.detail.message));
    document.querySelector('main.app-main > .viewer-toolbar').after(this.maskEditor);

    this.inferenceExecutor = new SeedSegPipeline({
      updateOutput: (msg) => this.updateOutput(msg),
      setProgress: (val, text) => this.setProgress(val, text),
      onStageData: (data) => this.handleStageData(data),
      onComplete: data => {
        this.inferenceExecutor.report = data.report;
        if (data.report?.detections) this.showDetections(data.report.detections);
        this.onInferenceComplete();
      },
      onError: (msg) => this.onInferenceError(msg),
      onInitialized: () => {}
    });
    // Modals
    this.aboutModal = new ModalManager('aboutModal');
    this.privacyModal = new ModalManager('privacyModal');
    this.dicompareModal = new ModalManager('dicompareModal');

    // Setup
    await this.setupViewer();
    this.setupEventListeners();
    bindInfoTooltips(document);

    // Log threading support
    if (crossOriginIsolated) {
      this.updateOutput('Multi-threaded WASM enabled');
    } else {
      this.updateOutput('Running single-threaded (COOP/COEP headers not set)');
    }

    // Start ONNX initialization in background
    this.inferenceExecutor.initialize().catch(error => this.onInferenceError(error.message));
    this.automation = registerSeedSegAutomation(this);
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

    // Load example data button
    document.getElementById('loadExampleData')?.addEventListener('click', () => this._loadExampleData());

    document.getElementById('selectAllFolds')?.addEventListener('click', () => {
      Config.FOLDS.forEach((f) => { const cb = document.getElementById(`fold${f}`); if (cb) cb.checked = true; });
    });

    // The legacy v1 model ignores the network and mirroring settings
    document.getElementById('legacyModel')?.addEventListener('change', (e) => {
      this.legacyModels = undefined;
      const ids = [...Config.FOLDS.map((f) => `fold${f}`), 'mirrorTTA', 'selectAllFolds'];
      ids.forEach((id) => { const el = document.getElementById(id); if (el) el.disabled = e.target.checked; });
    });

    // Run button
    const runBtn = document.getElementById('runSegmentation');
    if (runBtn) runBtn.addEventListener('click', () => this.runSegmentation());

    // Cancel button
    const cancelBtn = document.getElementById('cancelButton');
    if (cancelBtn) cancelBtn.addEventListener('click', () => this.cancelSegmentation());

    // Console copy / clear
    const copyConsole = document.getElementById('copyConsole');
    if (copyConsole) copyConsole.addEventListener('click', async () => {
      const ok = await this.console.copyToClipboard();
      if (ok) { copyConsole.textContent = 'Copied!'; setTimeout(() => { copyConsole.textContent = 'Copy'; }, 1500); }
    });
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

  /**
   * Fetch the synthetic example case from Hugging Face and load it like a dropped file.
   */
  async _loadExampleData() {
    const btn = document.getElementById('loadExampleData');
    const { baseUrl, files } = Config.EXAMPLE_DATA;
    const label = btn.innerHTML;

    btn.disabled = true;
    btn.textContent = 'Downloading example data...';
    this.updateOutput('Downloading example data (synthetic, not patient data)...');
    this.setProgress(0, 'Downloading example data...');

    try {
      // HEAD requests first, to learn the total size for the progress bar
      const sizes = await Promise.all(files.map(async (name) => {
        const resp = await fetch(`${baseUrl}/${name}`, { method: 'HEAD' });
        return parseInt(resp.headers.get('Content-Length') || '0', 10);
      }));
      const totalBytes = sizes.reduce((a, b) => a + b, 0);
      const perFileBytes = new Array(files.length).fill(0);
      const updateProgress = () => {
        const done = perFileBytes.reduce((a, b) => a + b, 0);
        const frac = totalBytes > 0 ? done / totalBytes : 0;
        this.setProgress(frac, `Downloaded ${(done / 1e6).toFixed(1)} / ${(totalBytes / 1e6).toFixed(1)} MB`);
      };

      const fetched = await Promise.all(files.map(async (name, i) => {
        const resp = await fetch(`${baseUrl}/${name}`);
        if (!resp.ok) throw new Error(`Failed to fetch ${name}: ${resp.status}`);
        const reader = resp.body.getReader();
        const chunks = [];
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          perFileBytes[i] += value.byteLength;
          updateProgress();
        }
        return new File([new Blob(chunks)], name);
      }));

      this.updateOutput(`Downloaded ${fetched.length} file(s). Loading...`);
      this._handleUnifiedFiles(fetched);
      this.setProgress(0, '');
      this.updateOutput('Example case added (synthetic). Press Run Segmentation to detect the markers.');
    } catch (err) {
      this.setProgress(0, '');
      this.updateOutput(`Error loading example data: ${err.message}`);
      console.error('Example data load failed:', err);
      btn.disabled = false;
    } finally {
      btn.innerHTML = label;
    }
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
    this._addFilesToBuckets(niftiFiles, { assumeT1w: true });
  }

  _showDicomStatus(show) {
    const el = document.getElementById('dicomStatus');
    if (el) el.style.display = show ? 'flex' : 'none';
  }

  _addFilesToBuckets(files, { assumeT1w = false } = {}) {
    let t1wAssigned = assumeT1w ? this._buckets.t1w.length > 0 : true;
    for (const file of files) {
      if (/t1/i.test(file.name)) {
        this._buckets.t1w.push(file);
        t1wAssigned = true;
      } else if (assumeT1w && !t1wAssigned) {
        // Converted scans assign their first image to T1w.
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

    // Example data only makes sense before files are loaded
    const exampleBtn = document.getElementById('loadExampleData');
    if (exampleBtn) exampleBtn.disabled = hasFiles;

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

  // ==================== Viewer Controls ====================

  setupWindowControls() {
    this.windowControls = bindWindowControls({
      getVolume: () => this.nv?.volumes?.[0] || null,
      updateVolume: () => this.nv?.updateGLVolume?.(),
      onReset: volume => {
        if (typeof this.applyAutoContrast === 'function') return this.applyAutoContrast();
        volume.cal_min = volume.global_min ?? 0;
        volume.cal_max = volume.global_max ?? 1;
        this.nv?.updateGLVolume?.();
        this.windowControls.sync();
      }
    });
  }

  syncWindowControls() {
    this.windowControls?.sync();
  }

  syncSlidersToVolume() {
    this.windowControls?.syncSliders();
  }

  downloadCurrentVolume() {
    if (!this.nv.volumes?.length) {
      this.updateOutput('No volume loaded');
      return;
    }
    const vol = this.nv.volumes[0];
    const name = (vol.name || 'volume').replace(/\.(nii|nii\.gz)$/i, '');
    const niftiBuffer = createNiftiFromVolume(vol);
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
    await this.maskEditor.cancel();
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

  async runSegmentation({ legacyModels, model = Config.INFERENCE_DEFAULTS.model, backend = 'auto' } = {}) {
    if (!this.fileIOController.hasValidData()) {
      this.updateOutput('No input volume loaded');
      return;
    }

    const file = this.fileIOController.getActiveFile();

    const pipeline = document.getElementById('legacyModel').checked ? 'legacy-v1' : 'nnunet-v2';
    const folds = pipeline === 'legacy-v1' ? [] : Config.FOLDS.filter(fold => document.getElementById(`fold${fold}`).checked);
    const threshold = document.getElementById('probThreshold').valueAsNumber;
    const nMarkers = document.getElementById('nMarkers').valueAsNumber;
    const mirror = pipeline !== 'legacy-v1' && document.getElementById('mirrorTTA').checked;
    try {
      resolveModels(pipeline === 'legacy-v1' ? legacyModels : folds, { pipeline, model });
      validateSelection({ threshold, nMarkers, mirror });
    } catch (error) {
      this.onInferenceError(error.message);
      return;
    }

    // Read file
    const inputData = await file.arrayBuffer();

    // Clear previous results
    await clearResultsAfterEditing(this.maskEditor, this.inferenceExecutor);
    this.disableAllResultTabs();

    // Disable run; the status footer shows the cancel button while running
    const runBtn = document.getElementById('runSegmentation');
    if (runBtn) runBtn.disabled = true;
    document.getElementById('statusText')?.classList.remove('error');
    this.progress.begin('Starting segmentation...');

    try {
      await this.inferenceExecutor.run({
        inputData,
        settings: {
          pipeline,
          folds,
          mirror,
          threshold,
          nMarkers,
          selectedModels: legacyModels,
          model,
          backend
        }
      });
    } catch (error) {
      this.onInferenceError(error.message);
    }
  }

  cancelSegmentation() {
    this.inferenceExecutor.cancel();
    const runBtn = document.getElementById('runSegmentation');
    if (runBtn) runBtn.disabled = false;
    this.progress.reset('Cancelled');
  }

  // ==================== Results ====================

  static STAGE_NAMES = {
    input: 'Input',
    probability: 'Probability',
    markers: 'Markers',
    model1: 'Model 1', model2: 'Model 2', model3: 'Model 3', model4: 'Model 4',
    avgProb: 'Average probability', consensus: 'Consensus'
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

    // Auto-show the detected markers when they arrive
    if (data.stage === 'markers' || data.stage === 'consensus') {
      this.showResult(data.stage);
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
    showBtn.textContent = stageLabel(displayName, this.inferenceExecutor.getResult(stage));
    showBtn.addEventListener('click', () => this.showResult(stage));
    item.appendChild(showBtn);

    if (isEditableStage(stage)) {
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'nd-edit-btn';
      editBtn.textContent = 'Edit';
      editBtn.title = 'Edit in the viewer';
      editBtn.disabled = this.maskEditor.session.state !== 'idle';
      editBtn.addEventListener('click', () => this.editResult(stage));
      item.appendChild(editBtn);
    }

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

  async editResult(stage) {
    const result = this.inferenceExecutor.getResult(stage);
    if (!result?.file || !this.inputFile) return;
    this.setEditButtonsEnabled(false);
    document.getElementById('statusText')?.classList.remove('error');
    try {
      await this.showResult(stage);
      const labelNames = markerLabelNames(stage, this.inferenceExecutor.report?.detections?.k);
      this.maskEditor.configure({ ...this.maskEditorOptions, labelNames });
      const started = await this.maskEditor.start({
        stage,
        file: result.file,
        label: SeedSegApp.STAGE_NAMES[stage] || stage,
        overlayIndex: 1
      });
      if (!started) this.setEditButtonsEnabled(true);
    } catch (error) {
      this.onMaskEditError(error);
    }
  }

  async onMaskApplied(stage, file, original) {
    replaceWithEdit(this.inferenceExecutor, stage, file, original);
    if (stage === 'markers') await this.refreshDetections(file);
    const showBtn = document.querySelector(`#stage-item-${stage} .stage-btn`);
    if (showBtn) showBtn.textContent = stageLabel(SeedSegApp.STAGE_NAMES[stage] || stage, this.inferenceExecutor.getResult(stage));
    this.updateOutput(`Applied manual edits to ${file.name}`);
    this.onMaskEditClosed();
    await this.renderResult(stage);
  }

  onMaskEditClosed() {
    this.setEditButtonsEnabled(true);
    this.progress.setText('Ready');
  }

  async refreshDetections(file) {
    const detections = this.inferenceExecutor.report?.detections;
    const probabilityFile = this.inferenceExecutor.getResult('probability')?.file;
    if (!detections || !probabilityFile) return;
    const [mask, probability] = await Promise.all([file, probabilityFile].map(async item => readNifti(await item.arrayBuffer())));
    const voxelVolume = mask.header.voxelSize.reduce((product, value) => product * Math.abs(value), 1);
    const edited = summarizeMarkers(mask.data, probability.data, [...mask.dims].reverse(), { k: detections.k, voxelVolume, affine: mask.header.affine });
    this.inferenceExecutor.report.detections = { ...detections, ...edited, nCandidates: edited.markers.length, others: [], edited: true };
    this.showDetections(this.inferenceExecutor.report.detections);
  }

  onMaskEditError(error) {
    this.setEditButtonsEnabled(true);
    const message = error?.message || String(error);
    this.updateOutput(`Mask editing failed: ${message}`);
    this.progress.end(`Error: ${message}`, { success: false });
    document.getElementById('statusText')?.classList.add('error');
  }

  setEditButtonsEnabled(enabled) {
    document.querySelectorAll('#stageButtons .nd-edit-btn').forEach(btn => { btn.disabled = !enabled || this.maskEditor.session.state !== 'idle'; });
  }

  onInferenceComplete() {
    const runBtn = document.getElementById('runSegmentation');
    if (runBtn) runBtn.disabled = false;
    this.progress.end('Complete');
  }

  onInferenceError(msg) {
    const runBtn = document.getElementById('runSegmentation');
    if (runBtn) runBtn.disabled = false;
    this.progress.end(msg ? `Error: ${msg}` : 'Error', { success: false });
    document.getElementById('statusText')?.classList.add('error');
  }

  async showResult(stage) {
    await this.maskEditor.cancel();
    return this.renderResult(stage);
  }

  async renderResult(stage) {
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
    const colormap = (stage === 'markers' || stage === 'consensus') ? 'red' : 'warm';

    // Sync overlay colormap select
    if (overlayColormapSelect) overlayColormapSelect.value = colormap;

    await this.viewerController.showResultAsOverlay(this.inputFile, result.file, colormap);
    this.syncWindowControls();
  }

  disableAllResultTabs() {
    // Clear dynamically added stage buttons and the marker list
    const container = document.getElementById('stageButtons');
    if (container) container.innerHTML = '';
    const panel = document.getElementById('detectionsPanel');
    if (panel) { panel.innerHTML = ''; panel.classList.add('hidden'); }
  }

  /** Marker list: rank, mean probability, position; count flag when fewer than K were found. */
  showDetections(det) {
    const panel = document.getElementById('detectionsPanel');
    if (!panel) return;
    const n = det.markers.length;
    const flag = det.countFlag
      ? `<div class="nd-message warning"><strong>Check:</strong> ${n} of ${det.k} markers found (${det.nCandidates} candidate${det.nCandidates === 1 ? '' : 's'}). Review the image.</div>`
      : `<div class="nd-message success">${n} of ${det.k} markers found.</div>`;
    const rows = det.markers.map((m) => {
      const w = m.centroidWorldMm.map((v) => v.toFixed(1)).join(', ');
      return `<tr>
        <td>${m.rank}</td><td>${m.meanProb.toFixed(3)}</td><td>${m.volumeMm3.toFixed(0)}</td><td><button type="button" class="nd-btn nd-btn-secondary nd-btn-sm" data-world="${m.centroidWorldMm.join(',')}" aria-label="Show marker ${m.rank} at ${w} mm">${w}</button></td></tr>`;
    }).join('');
    const hint = detectionsHint(det);
    panel.innerHTML = `${flag}<div class="nd-table-scroll"><table class="nd-data-table"><thead><tr><th>#</th><th>Mean p</th><th>mm³</th><th>Position (mm)</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
    const meta = document.createElement('p');
    meta.className = 'nd-hint';
    meta.append(hint.text, ' ', renderInfoIcon(hint.details, { label: 'Inference settings' }));
    panel.append(meta);
    bindInfoTooltips(meta);
    panel.classList.remove('hidden');
    panel.querySelectorAll('button[data-world]').forEach((tr) => {
      tr.addEventListener('click', () => {
        const position = tr.dataset.world.split(',').map(Number);
        const vol = this.nv.volumes?.[0];
        if (!vol) return;
        this.nv.scene.crosshairPos = this.nv.mm2frac(position);
        this.nv.updateGLVolume();
      });
    });
  }

  async clearResults() {
    await clearResultsAfterEditing(this.maskEditor, this.inferenceExecutor);
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
<<<<<<< monorepo
  _onDicomFilesRetained(files) {
    this.dicompareFiles = Array.from(files);
    this.dicompareController?.clearFiles();
=======
  /**
   * Load dicompare from its host the first time it is needed. A static import would stop the
   * whole app booting whenever that host is unreachable, so a failure here only disables the report.
   * @returns {Promise<boolean>} True if the dicompare modules are available
   */
  _loadDicompare() {
    this.dicompareLoad ||= Promise.all([
      import('https://webapps.neurodesk.org/dicompare/embed/DicompareController.js'),
      import('https://webapps.neurodesk.org/dicompare/embed/DicompareReportRenderer.js')
    ]).then(([{ DicompareController }, { DicompareReportRenderer }]) => {
      this.dicompareController = new DicompareController({
        schemaUrl: 'https://webapps.neurodesk.org/dicompare/schemas/SeedSeg_Prostate_T1w_v1.0.json',
        updateOutput: (msg) => this.updateOutput(msg)
      });
      this.dicompareRenderer = new DicompareReportRenderer();
      return true;
    }).catch((error) => {
      console.error('Could not load dicompare:', error);
      const btn = document.getElementById('dicompareReportBtn');
      if (btn) {
        btn.disabled = true;
        btn.title = 'dicompare could not be loaded from webapps.neurodesk.org/dicompare';
      }
      this.updateOutput('dicompare report unavailable: could not load it from webapps.neurodesk.org/dicompare');
      return false;
    });
    return this.dicompareLoad;
  }

  async _onDicomFilesRetained(files) {
    if (!(await this._loadDicompare())) return;
    await this.dicompareController.retainDicomFiles(files);
>>>>>>> upstream
    const btn = document.getElementById('dicompareReportBtn');
    if (btn) {
      btn.disabled = files.length === 0;
    }
  }

  /**
   * Run dicompare validation and display results in modal.
   */
  async runDicompareReport() {
<<<<<<< monorepo
    if (!this.dicompareFiles.length) {
=======
    if (!(await this._loadDicompare())) return;
    if (!this.dicompareController.hasFiles()) {
>>>>>>> upstream
      this.updateOutput('No DICOM files available for validation.');
      return;
    }

    const body = document.getElementById('dicompareModalBody');
    const footer = document.getElementById('dicompareModalFooter');

    // If results are already cached, just re-display them
    const cached = this.dicompareController?.getCachedResults();
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
      const { DicompareController } = await import('../vendor/dicompare/DicompareController.js');
      this.dicompareController ||= new DicompareController({
        schemaUrl: new URL('../vendor/dicompare/SeedSeg_Prostate_T1w_v1.0.json', import.meta.url).href,
        workerUrl: new URL('../vendor/dicompare/dicompare-worker.js', import.meta.url).href,
        updateOutput: (msg) => this.updateOutput(msg)
      });
      if (!this.dicompareController.hasFiles()) {
        await this.dicompareController.retainDicomFiles(this.dicompareFiles);
      }
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
    if (!this.dicompareController?.complianceResults) return;
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
    const message = value >= 1 ? 'Complete' : (text || (value > 0 ? 'Processing...' : null));
    this.progress.setProgress(value, message);
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
