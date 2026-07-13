/**
 * MuscleMap - Browser-based whole-body muscle segmentation
 *
 * Main application class. Orchestrates controllers, viewer, and inference.
 */

import { FileIOController } from './controllers/FileIOController.js';
import { DicomController } from './controllers/DicomController.js?v=1.2.35';
import { ViewerController } from './controllers/ViewerController.js?v=1.2.35';
import { InferenceExecutor } from './controllers/InferenceExecutor.js';
import { ConsoleOutput } from '@neurodesk/webapp-components/ui';
import { ProgressManager } from '@neurodesk/webapp-components/ui';
import { ModalManager } from '@neurodesk/webapp-components/ui';
import { MuscleLegend } from './modules/ui/MuscleLegend.js';
import { MetricsSummary } from './modules/ui/MetricsSummary.js';
import { FallbackNiftiPreview } from './modules/fallback-nifti-preview.js';
import * as Config from './app/config.js';
import { generateNiivueColormap, getLabelName, getLabelColor, getMuscleLabels, getLabelsForModel } from './app/labels.js';

class MuscleMapApp {
  static VIEWER_UNAVAILABLE_GUIDANCE =
    'Image preview unavailable: WebGL2 could not initialize. You can still load images, run segmentation, and download results. '
    + 'To restore the interactive 3D viewer, enable hardware acceleration in your browser (Chrome: Settings > System; details at chrome://gpu), then reload.';

  constructor() {
    // NiiVue
    this.nv = new niivue.Niivue({
      ...Config.VIEWER_CONFIG,
      onLocationChange: (data) => {
        this._lastLocationData = data;
        this.updateViewerInfo(data);
      }
    });

    // UI modules
    // Shared ConsoleOutput themed to reproduce MuscleMap's exact `console-*` DOM + semantic
    // level colouring (warning:/error:/…failed) and plain console.log mirroring.
    this.console = new ConsoleOutput({
      outputElementId: 'consoleOutput',
      lineClass: 'console-line',
      timeClass: 'console-time',
      messageClass: 'console-message',
      separator: ' ',
      levelOn: 'message',
      levelClass: (level) => (level === 'info' ? '' : level),
      deriveLevel: (text) => {
        const n = String(text).trim().toLowerCase();
        if (n.startsWith('warning:')) return 'warning';
        if (n.startsWith('error:') || n.includes('failed')) return 'error';
        return 'info';
      },
      mirror: (text) => console.log(text),
    });
    this.progress = new ProgressManager(Config.PROGRESS_CONFIG);
    this.muscleLegend = new MuscleLegend('muscleLegend');
    this.metricsSummary = new MetricsSummary('metricsSummary');

    // State
    this.inputFile = null;
    this.currentResultTab = 'input';
    this.currentModelName = Config.MODELS[0].name;
    this.segmentationResults = [];
    this.activeSegmentationId = null;
    this._pendingMetrics = null;
    this._metricsSourceId = null;
    this._detectedLabels = null;
    this._lastDetectedLabelIndices = [];
    this._lastHadDixonImfInputs = false;
    this._overlaySliderValue = 0.5;
    this._inputVisible = true;
    this._segmentationVisible = true;
    this._lastLocationData = null;
    this._suppressIntermediateResults = false;
    this._activeWorkerTask = null;
    this.viewerAvailable = false;
    this.viewerUnavailableReason = '';
    this.fallbackPreview = new FallbackNiftiPreview({
      canvasId: 'fallbackCanvas2d',
      messageId: 'viewerUnavailableMessage',
      updateOutput: (msg) => this.updateOutput(msg)
    });

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
    this.dicomController = new DicomController({
      updateOutput: (msg) => this.updateOutput(msg),
      onConversionComplete: (files) => {
        this.fileIOController.setFiles(files);
      }
    });

    this.fileIOController = new FileIOController({
      updateOutput: (msg) => this.updateOutput(msg),
      onFileLoaded: (file) => this.onFileLoaded(file),
      onViewFile: (file) => this.onFileLoaded(file),
      onFilesChanged: () => this.onFilesChanged(),
      onDicomFiles: (files) => this.dicomController.convertFiles(files)
    });

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
      onInitialized: () => this.onWorkerInitialized(),
      onDetectedLabels: (labels) => this.handleDetectedLabels(labels),
      onMetrics: (metrics) => this.handleMetrics(metrics)
    });

    // Modals
    this.aboutModal = new ModalManager('aboutModal');
    this.citationsModal = new ModalManager('citationsModal');
    this.privacyModal = new ModalManager('privacyModal');

    // Register custom colormap
    const colormapData = generateNiivueColormap();

    // Setup
    const viewerReady = await this.setupViewer();

    // Register colormap after viewer is ready
    if (viewerReady) {
      this.viewerController.registerMuscleColormap(colormapData);
    }

    this.setupEventListeners();
    this.setupInfoTooltips();
    this.setupStartPage();

    // Start ONNX initialization in background
    this.inferenceExecutor.initialize();
  }

  async setupViewer() {
    const capturedErrors = [];
    const restoreConsoleError = this.captureNiivueConsoleErrors(capturedErrors);
    try {
      await this.nv.attachTo('gl1');
      if (!this.nv.gl) {
        throw new Error('WebGL2 context unavailable after attach.');
      }
      this.nv.setMultiplanarPadPixels(5);
      this.nv.setSliceType(this.nv.sliceTypeMultiplanar);
      this.nv.setInterpolation(true);
      this.nv.drawScene();
      await new Promise(resolve => requestAnimationFrame(() => resolve()));
      if (capturedErrors.length > 0) {
        throw new Error(capturedErrors[0]);
      }
      this.viewerAvailable = true;
      this.setViewerUnavailableMessage('');
      this.setViewerControlsEnabled(true);
      return true;
    } catch (error) {
      this.disableViewer(error?.message || 'Viewer initialization failed.');
      return false;
    } finally {
      restoreConsoleError();
    }
  }

  captureNiivueConsoleErrors(capturedErrors) {
    const originalConsoleError = console.error;
    console.error = (...args) => {
      const message = args.map(arg => {
        if (typeof arg === 'string') return arg;
        if (arg instanceof Error) return arg.message;
        try {
          return JSON.stringify(arg);
        } catch {
          return String(arg);
        }
      }).join(' ');
      if (message.includes('niivue-error')) capturedErrors.push(message);
      originalConsoleError.apply(console, args);
    };
    return () => {
      console.error = originalConsoleError;
    };
  }

  isViewerAvailable() {
    return this.viewerAvailable && !!this.nv && this.viewerController?.isAvailable?.();
  }

  isImagePreviewAvailable() {
    return this.isViewerAvailable() || this.fallbackPreview?.isSupported?.();
  }

  disableViewer(reason) {
    this.viewerAvailable = false;
    this.viewerUnavailableReason = reason;
    if (this.viewerController) this.viewerController.nv = null;
    this.fallbackPreview?.setUnavailable(reason);
    this.setViewerUnavailableMessage(reason);
    this.setViewerControlsEnabled(false);
    this.updateViewerInfo({ string: 'Image preview unavailable' });
    this.updateOutput(`Image preview unavailable: ${reason}`);
  }

  setViewerUnavailableMessage(reason) {
    document.body.classList.toggle('viewer-unavailable', !!reason);
    const message = document.getElementById('viewerUnavailableMessage');
    if (message) {
      message.hidden = !reason;
      if (reason) {
        message.textContent = MuscleMapApp.VIEWER_UNAVAILABLE_GUIDANCE;
        message.title = reason;
      } else {
        message.title = '';
      }
    }
  }

  setViewerControlsEnabled(enabled) {
    document.querySelectorAll('.viewer-toolbar button, .viewer-toolbar input, .viewer-toolbar select').forEach(control => {
      control.disabled = !enabled;
    });
  }

  // ==================== Viewer Footer ====================

  updateViewerInfo(data) {
    const primaryEl = document.getElementById('viewerInfoPrimary');
    if (primaryEl) {
      primaryEl.textContent = data?.string || '';
    }

    const labelEl = document.getElementById('viewerInfoLabel');
    if (labelEl) {
      labelEl.textContent = this.getOverlayLabelText(data);
    }
  }

  getOverlayLabelText(data) {
    if (!this.isViewerAvailable()) return '';
    if (!this._segmentationVisible) return '';
    if (!this.nv?.volumes || this.nv.volumes.length < 2) return '';

    const rawValue = data?.values?.[1]?.value;
    if (!Number.isFinite(rawValue)) return '';

    const labelIndex = Math.round(rawValue);
    if (labelIndex <= 0) return '';

    const modelLabels = getLabelsForModel(this.currentModelName);
    const labelName = getLabelName(labelIndex, modelLabels);
    const labelValue = modelLabels[labelIndex]?.value ?? labelIndex;
    return `#${labelValue} ${labelName}`;
  }

  // ==================== Event Listeners ====================

  setupEventListeners() {
    const fileInput = document.getElementById('fileInput');
    if (fileInput) {
      fileInput.addEventListener('change', (e) => this.fileIOController.handleFileInput(e));
    }
    const addFilesButton = document.getElementById('addFilesButton');
    if (addFilesButton && fileInput) {
      addFilesButton.addEventListener('click', () => {
        fileInput.value = '';
        fileInput.click();
      });
    }

    this.setupDropZone();

    const runBtn = document.getElementById('runSegmentation');
    if (runBtn) runBtn.addEventListener('click', () => this.runSegmentation());

    const consolidateBtn = document.getElementById('consolidateSegmentations');
    if (consolidateBtn) consolidateBtn.addEventListener('click', () => this.consolidateSegmentations());

    const calculateMetricsBtn = document.getElementById('calculateMetrics');
    if (calculateMetricsBtn) calculateMetricsBtn.addEventListener('click', () => this.calculateMetrics());

    const metricsSegmentationSelect = document.getElementById('metricsSegmentationSelect');
    if (metricsSegmentationSelect) {
      metricsSegmentationSelect.addEventListener('change', () => {
        this.clearMetricsIfSourceChanged(metricsSegmentationSelect.value);
        this.syncPostprocessingControls();
      });
    }

    const cancelBtn = document.getElementById('cancelButton');
    if (cancelBtn) cancelBtn.addEventListener('click', () => this.cancelSegmentation());

    const copyConsole = document.getElementById('copyConsole');
    if (copyConsole) copyConsole.addEventListener('click', async () => {
      const ok = await this.console.copyToClipboard();
      if (ok) {
        copyConsole.textContent = 'Copied!';
        setTimeout(() => { copyConsole.textContent = 'Copy'; }, 1500);
      }
    });

    const clearConsole = document.getElementById('clearConsole');
    if (clearConsole) clearConsole.addEventListener('click', () => this.console.clear());

    document.querySelectorAll('.view-tab[data-view]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (!this.isViewerAvailable()) return;
        document.querySelectorAll('.view-tab[data-view]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.viewerController.setViewType(btn.dataset.view);
      });
    });

    const opacitySlider = document.getElementById('overlayOpacity');
    if (opacitySlider) {
      opacitySlider.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        this._overlaySliderValue = val;
        if (this.isViewerAvailable() && this._segmentationVisible) {
          this.viewerController.setOverlayOpacity(val);
        }
        const display = document.getElementById('overlayOpacityValue');
        if (display) display.textContent = `${Math.round(val * 100)}%`;
      });
    }

    this.setupWindowControls();

    const interpToggle = document.getElementById('interpolation');
    if (interpToggle) {
      interpToggle.addEventListener('change', (e) => {
        if (!this.isViewerAvailable()) return;
        this.nv.setInterpolation(!e.target.checked);
        this.nv.drawScene();
      });
    }

    const colorbarToggle = document.getElementById('colorbarToggle');
    if (colorbarToggle) {
      colorbarToggle.addEventListener('change', (e) => {
        if (!this.isViewerAvailable()) return;
        this.nv.opts.isColorbar = e.target.checked;
        this.nv.drawScene();
      });
    }

    const crosshairToggle = document.getElementById('crosshairToggle');
    if (crosshairToggle) {
      crosshairToggle.addEventListener('change', (e) => {
        if (!this.isViewerAvailable()) return;
        this.nv.setCrosshairWidth(e.target.checked ? 1 : 0);
      });
    }

    const downloadBtn = document.getElementById('downloadCurrentVolume');
    if (downloadBtn) {
      downloadBtn.addEventListener('click', () => this.downloadCurrentVolume());
    }

    const screenshotBtn = document.getElementById('screenshotViewer');
    if (screenshotBtn) {
      screenshotBtn.addEventListener('click', () => this.saveScreenshot());
    }

    const colormapSelect = document.getElementById('colormapSelect');
    if (colormapSelect) {
      colormapSelect.addEventListener('change', (e) => {
        if (this.isViewerAvailable() && this.nv.volumes?.length) {
          this.nv.volumes[0].colormap = e.target.value;
          this.nv.updateGLVolume();
        }
      });
    }

    const clearResults = document.getElementById('clearResults');
    if (clearResults) clearResults.addEventListener('click', () => this.clearResults());

    const imfToggle = document.getElementById('imfToggle');
    if (imfToggle) {
      imfToggle.addEventListener('change', () => this.syncImfControls());
      this.syncImfControls();
    }
    const imfModeSelect = document.getElementById('imfModeSelect');
    if (imfModeSelect) imfModeSelect.addEventListener('change', () => this.syncImfControls());

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
  }

  setupStartPage() {
    const startPage = document.getElementById('startPage');
    const enterButton = document.getElementById('enterAppButton');
    if (!startPage || !enterButton) return;

    enterButton.addEventListener('click', () => {
      startPage.classList.add('hidden');
      document.getElementById('fileInput')?.focus();
    });

    const startPrivacyButton = document.getElementById('startPrivacyButton');
    if (startPrivacyButton) startPrivacyButton.addEventListener('click', () => this.privacyModal.open());

    const inlinePrivacyButton = document.getElementById('startPrivacyInlineButton');
    if (inlinePrivacyButton) inlinePrivacyButton.addEventListener('click', () => this.privacyModal.open());

    const startCitationsButton = document.getElementById('startCitationsButton');
    if (startCitationsButton) startCitationsButton.addEventListener('click', () => this.citationsModal.open());
  }

  setupDropZone() {
    const zone = document.getElementById('fileDropZone');
    if (!zone) return;

    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
      zone.classList.add('dragover');
    });

    zone.addEventListener('dragleave', () => {
      zone.classList.remove('dragover');
    });

    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('dragover');

      const files = Array.from(e.dataTransfer.files);
      const hasNifti = files.some(f => FileIOController.isNiftiFile(f));

      if (hasNifti) {
        this.fileIOController.handleDroppedFiles(files);
      } else if (e.dataTransfer.items?.length) {
        // Could be a folder drop (DICOM) - use items API for directory traversal
        this.dicomController.convertDropItems(e.dataTransfer.items);
      } else if (files.length > 0) {
        this.fileIOController.handleDroppedFiles(files);
      }
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
        let top = iconRect.top - tipRect.height - 6;
        let left = iconRect.left + iconRect.width / 2 - tipRect.width / 2;
        if (top < 4) top = iconRect.bottom + 6;
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
      if (!this.isViewerAvailable() || !this.nv.volumes.length) return;
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
      if (!this.isViewerAvailable() || !this.nv.volumes.length) return;
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
        if (!this.isViewerAvailable() || !this.nv.volumes.length) return;
        const vol = this.nv.volumes[0];
        vol.cal_min = vol.global_min ?? 0;
        vol.cal_max = vol.global_max ?? 1;
        this.nv.updateGLVolume();
        this.syncWindowControls();
      });
    }
  }

  syncWindowControls() {
    if (!this.isViewerAvailable() || !this.nv.volumes.length) return;
    const vol = this.nv.volumes[0];
    const windowMin = document.getElementById('windowMin');
    const windowMax = document.getElementById('windowMax');
    if (windowMin) windowMin.value = (vol.cal_min ?? 0).toPrecision(4);
    if (windowMax) windowMax.value = (vol.cal_max ?? 1).toPrecision(4);
    this.syncSlidersToVolume();
    const dlBtn = document.getElementById('downloadCurrentVolume');
    if (dlBtn) dlBtn.disabled = false;
  }

  syncSlidersToVolume() {
    if (!this.isViewerAvailable() || !this.nv.volumes.length) return;
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
    if (!this.isViewerAvailable() || !this.nv.volumes?.length) {
      this.updateOutput('No volume loaded');
      return;
    }

    const downloads = [];
    if (this._inputVisible) {
      const baseFile = this.viewerController?.getCurrentFile?.() || this.inputFile;
      if (baseFile) {
        downloads.push({
          file: baseFile,
          name: baseFile.name || 'input.nii',
          label: 'input image'
        });
      } else {
        downloads.push(this.createNiftiDownloadFromVolume(this.nv.volumes[0], 'input image'));
      }
    }

    const activeSegmentation = this.getSegmentationSourceById(this.activeSegmentationId);
    if (this._segmentationVisible && activeSegmentation?.file) {
      downloads.push({
        file: activeSegmentation.file,
        name: activeSegmentation.file.name || `${activeSegmentation.id}.nii`,
        label: activeSegmentation.label || 'segmentation'
      });
    } else if (this._segmentationVisible && this.nv.volumes.length > 1) {
      downloads.push(this.createNiftiDownloadFromVolume(this.nv.volumes[1], 'segmentation'));
    }

    if (downloads.length === 0) {
      this.updateOutput('No visible scene layers selected for download');
      return;
    }

    for (const item of downloads) {
      this.downloadFile(item.file, item.name);
    }

    const labels = downloads.map(item => item.label || item.name).join(', ');
    this.updateOutput(`Downloaded scene layer${downloads.length === 1 ? '' : 's'}: ${labels}`);
  }

  createNiftiDownloadFromVolume(vol, label = 'volume') {
    const name = (vol.name || 'volume').replace(/\.(nii|nii\.gz)$/i, '');
    const niftiBuffer = this.createNiftiFromVolume(vol);
    return {
      file: new File([niftiBuffer], `${name}.nii`, { type: 'application/octet-stream' }),
      name: `${name}.nii`,
      label
    };
  }

  downloadFile(file, name = file?.name || 'download.nii') {
    if (!file) return;
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
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
    view.setUint8(344, 0x6E);
    view.setUint8(345, 0x2B);
    view.setUint8(346, 0x31);
    view.setUint8(347, 0x00);

    new Uint8Array(buffer, headerSize).set(new Uint8Array(img.buffer, img.byteOffset, img.byteLength));
    return buffer;
  }

  saveScreenshot() {
    if (!this.isViewerAvailable()) {
      this.updateOutput('Screenshot unavailable: 3D viewer is disabled');
      return;
    }
    let filename = 'musclemap_screenshot.png';
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
    if (this.isViewerAvailable()) {
      const loaded = await this.viewerController.loadBaseVolume(file);
      if (loaded) {
        this.fallbackPreview?.clear?.();
      } else {
        await this.renderFallbackPreview(file, { stageName: 'Input image' });
      }
      this.syncWindowControls();

      // Set slice thickness default from loaded volume's z-spacing
      if (this.nv.volumes?.length) {
        const zSpacing = Math.abs(this.nv.volumes[0].hdr?.pixDims?.[3] || 1);
        const sliceInput = document.getElementById('sliceThickness');
        if (sliceInput) {
          sliceInput.value = parseFloat(zSpacing.toFixed(2));
        }
      }
    } else {
      await this.renderFallbackPreview(file, { stageName: 'Input image' });
    }

    const runBtn = document.getElementById('runSegmentation');
    if (runBtn) runBtn.disabled = false;

    this.currentResultTab = 'input';
    const overlayControl = document.getElementById('overlayControl');
    if (overlayControl) overlayControl.classList.add('hidden');

    // Hide legend and metrics
    this.muscleLegend.hide();
    this.metricsSummary.hide();
    this._pendingMetrics = null;
    this._metricsSourceId = null;
    this._detectedLabels = null;
    this.syncImfControls();
    this.syncPostprocessingControls();
  }

  onFilesChanged() {
    this.syncImfControls();
    this.syncPostprocessingControls();
    const entries = this.fileIOController.getEntries();
    const currentEntry = entries.find(entry => entry.file === this.inputFile) || null;
    const currentIsDisplayable = currentEntry && currentEntry.role !== 'segmentation';
    const primary = this.fileIOController.getPrimaryImageEntry();
    if (!currentIsDisplayable && primary) {
      void this.onFileLoaded(primary.file);
    } else if (!primary && this.inputFile && (!currentEntry || currentEntry.role === 'segmentation')) {
      this.inputFile = null;
      this.updateOutput('No displayable input image selected');
    }

    const runBtn = document.getElementById('runSegmentation');
    if (runBtn) runBtn.disabled = !this.fileIOController.hasValidData();
  }

  async renderFallbackPreview(file, { stageName = 'Image' } = {}) {
    if (!this.fallbackPreview?.isSupported?.() || !file) return false;
    const rendered = await this.fallbackPreview.renderFile(file, {
      stageName,
      reason: this.viewerUnavailableReason
    });
    if (rendered) {
      this.updateViewerInfo({ string: `${stageName}: 2D preview` });
    }
    return rendered;
  }

  // ==================== Inference ====================

  getSelectedModelConfig() {
    const modelSelect = document.getElementById('modelSelect');
    const selectedModelName = modelSelect ? modelSelect.value : Config.MODELS[0].name;
    return Config.MODELS.find(m => m.name === selectedModelName) || Config.MODELS[0];
  }

  setWorkerButtonsBusy(busy) {
    const runBtn = document.getElementById('runSegmentation');
    const consolidateBtn = document.getElementById('consolidateSegmentations');
    const calculateMetricsBtn = document.getElementById('calculateMetrics');
    const cancelBtn = document.getElementById('cancelButton');
    const consolidationSourceCount = this.getAvailableSegmentationSources()
      .filter(source => source.type !== 'consolidated')
      .length;

    if (runBtn) runBtn.disabled = busy || !this.fileIOController.hasValidData();
    if (consolidateBtn) consolidateBtn.disabled = busy || consolidationSourceCount <= 1;
    if (calculateMetricsBtn) calculateMetricsBtn.disabled = busy || !this.getSelectedMetricsSegmentationSource();
    if (cancelBtn) cancelBtn.disabled = !busy;
  }

  async cloneResultFile(file, name) {
    if (!file) return null;
    const buffer = await file.arrayBuffer();
    return new File([buffer], name || file.name, { type: file.type || 'application/octet-stream' });
  }

  async runSegmentation() {
    const entries = this.fileIOController.getEntries();
    if (entries.length === 0) {
      this.updateOutput('No input volume loaded');
      return;
    }

    const modelConfig = this.getSelectedModelConfig();

    // Get overlap setting
    const overlapSelect = document.getElementById('overlapSelect');
    const overlap = overlapSelect ? parseFloat(overlapSelect.value) : Config.INFERENCE_DEFAULTS.overlap;

    // Get chunk size setting
    const chunkSizeSelect = document.getElementById('chunkSizeSelect');
    const chunkSizeRaw = chunkSizeSelect ? chunkSizeSelect.value : Config.INFERENCE_DEFAULTS.chunkSize;
    const chunkSize = chunkSizeRaw === 'auto' ? 'auto' : parseInt(chunkSizeRaw, 10);

    // Get WebGPU toggle state
    const webgpuToggle = document.getElementById('webgpuToggle');
    const useWebGPU = webgpuToggle ? webgpuToggle.checked : true;

    // Get slice thickness
    const sliceThicknessInput = document.getElementById('sliceThickness');
    const sliceThickness = sliceThicknessInput ? parseFloat(sliceThicknessInput.value) : -1;

    // Get low-resolution postprocessing toggle state
    const lowResToggle = document.getElementById('lowResToggle');
    const lowRes = lowResToggle ? lowResToggle.checked : Config.INFERENCE_DEFAULTS.lowRes;

    const modelBaseUrl = new URL(Config.MODEL_BASE_URL, window.location.href).href;
    const segmentEntries = this.fileIOController.getSegmentEntries();
    const uploadedSegmentations = this.fileIOController.getSegmentationEntries();
    if (segmentEntries.length === 0 && uploadedSegmentations.length === 0) {
      this.updateOutput('Select at least one contrast to segment or provide a segmentation label map.');
      return;
    }

    if (segmentEntries.length === 0) {
      this.updateOutput('No contrast selected for segmentation. Uploaded label maps are available for postprocessing.');
      this.refreshResultsPanel();
      this.syncPostprocessingControls();
      return;
    }

    this.setWorkerButtonsBusy(true);

    // Clear previous
    this.inferenceExecutor.clearResults();
    this.segmentationResults = [];
    this.activeSegmentationId = null;
    this.disableAllResultTabs();
    this.muscleLegend.hide();
    this.metricsSummary.hide();
    this._pendingMetrics = null;
    this._metricsSourceId = null;
    this._detectedLabels = null;
    this._lastDetectedLabelIndices = [];
    this.syncPostprocessingControls();

    // Store selected model for result display
    this.currentModelName = modelConfig.name;

    // Re-register colormap with model-specific labels
    const modelLabels = getLabelsForModel(modelConfig.name);
    const colormapData = generateNiivueColormap(modelLabels);
    if (this.isViewerAvailable()) {
      this.viewerController.registerMuscleColormap(colormapData);
    }

    const generatedSegmentations = [];
    const baseSettings = {
      modelName: modelConfig.name,
      numClasses: modelConfig.numClasses,
      roiSize: modelConfig.roiSize,
      overlap,
      chunkSize,
      modelBaseUrl,
      useWebGPU,
      sliceThickness,
      lowRes,
      calculateMetrics: false,
      imfMetrics: { enabled: false }
    };

    this._suppressIntermediateResults = true;
    this._activeWorkerTask = 'segmentation';
    try {
      for (const entry of segmentEntries) {
        this.updateOutput(`Segmenting ${entry.file.name}...`);
        this._lastDetectedLabelIndices = [];
        const inputData = await entry.file.arrayBuffer();
        await this.inferenceExecutor.run({ inputData, settings: { ...baseSettings } });
        const fullResult = this.inferenceExecutor.getResult('segmentation');
        if (!fullResult?.file) throw new Error(`No segmentation produced for ${entry.file.name}`);

        const baseName = (entry.file.name || 'contrast').replace(/\.(nii|nii\.gz)$/i, '');
        const displayResult = this.inferenceExecutor.getResult('segmentation_display');
        const file = await this.cloneResultFile(fullResult.file, `${baseName}_segmentation.nii`);
        const displayFile = displayResult?.file
          ? await this.cloneResultFile(displayResult.file, `${baseName}_segmentation_display.nii`)
          : null;
        const segmentation = {
          id: `generated-${Date.now()}-${generatedSegmentations.length}`,
          type: 'generated',
          label: `${entry.file.name} segmentation`,
          file,
          displayFile,
          baseFile: entry.file,
          modelName: modelConfig.name,
          numClasses: modelConfig.numClasses,
          labelIndices: [...this._lastDetectedLabelIndices]
        };
        generatedSegmentations.push(segmentation);
        this.segmentationResults.push(segmentation);
      }

      this._suppressIntermediateResults = false;
      this._activeWorkerTask = null;
      this.updateOutput(`Generated ${generatedSegmentations.length} segmentation${generatedSegmentations.length === 1 ? '' : 's'}.`);
      this.refreshResultsPanel();
      this.syncPostprocessingControls();
      const firstResult = this.segmentationResults[0];
      if (firstResult) await this.showSegmentationSource(firstResult.id);
      this.setProgress(1, 'Complete');
      const statusText = document.getElementById('statusText');
      if (statusText) statusText.textContent = 'Ready';
    } catch (error) {
      this._suppressIntermediateResults = false;
      this._activeWorkerTask = null;
      this.updateOutput(`Error: ${error.message}`);
      this.onInferenceError(error.message);
      return;
    } finally {
      this._suppressIntermediateResults = false;
      this._activeWorkerTask = null;
      this.setWorkerButtonsBusy(false);
      this.syncPostprocessingControls();
    }
  }

  syncImfControls() {
    const entries = this.fileIOController.getEntries();
    const thresholdSources = entries.filter(entry => entry.role !== 'segmentation');
    const fatEntries = this.fileIOController.getEntriesByRole('dixon_fat');
    const waterEntries = this.fileIOController.getEntriesByRole('dixon_water');
    const hasDixon = fatEntries.length > 0 && waterEntries.length > 0;

    const methodSelect = document.getElementById('imfMethodSelect');
    const componentsSelect = document.getElementById('imfComponentsSelect');
    const enabled = !!document.getElementById('imfToggle')?.checked;
    const modeSelect = document.getElementById('imfModeSelect');
    const sourceSelect = document.getElementById('imfSourceSelect');
    const fatSelect = document.getElementById('imfFatSelect');
    const waterSelect = document.getElementById('imfWaterSelect');
    const sourceGroup = document.getElementById('imfSourceGroup');
    const thresholdControls = document.getElementById('imfThresholdControls');
    const dixonControls = document.getElementById('imfDixonControls');

    if (modeSelect) {
      const currentMode = modeSelect.value;
      const dixonBecameAvailable = hasDixon && !this._lastHadDixonImfInputs;
      modeSelect.innerHTML = '';
      modeSelect.appendChild(new Option('T1/T2 SE thresholding', 'threshold'));
      if (hasDixon) {
        modeSelect.appendChild(new Option('T1/T2 SE + Dixon fat/water', 'both'));
        modeSelect.appendChild(new Option('Dixon fat/water only', 'dixon'));
      }
      if (hasDixon && currentMode === 'dixon') {
        modeSelect.value = 'dixon';
      } else if (hasDixon && (currentMode === 'both' || dixonBecameAvailable)) {
        modeSelect.value = 'both';
      } else {
        modeSelect.value = 'threshold';
      }
      modeSelect.disabled = !enabled;
    }
    this._lastHadDixonImfInputs = hasDixon;

    const mode = modeSelect?.value || 'threshold';
    const usesThreshold = mode !== 'dixon';
    const usesDixon = mode === 'dixon' || mode === 'both';
    this.populateEntrySelect(sourceSelect, thresholdSources, 'No image available');
    this.populateEntrySelect(fatSelect, fatEntries, 'No Dixon fat image');
    this.populateEntrySelect(waterSelect, waterEntries, 'No Dixon water image');

    if (sourceSelect) sourceSelect.disabled = !enabled || !usesThreshold || thresholdSources.length === 0;
    if (methodSelect) methodSelect.disabled = !enabled || !usesThreshold;
    if (componentsSelect) componentsSelect.disabled = !enabled || !usesThreshold;
    if (fatSelect) fatSelect.disabled = !enabled || !usesDixon;
    if (waterSelect) waterSelect.disabled = !enabled || !usesDixon;

    sourceGroup?.classList.toggle('hidden', !usesThreshold);
    thresholdControls?.classList.toggle('hidden', !usesThreshold);
    dixonControls?.classList.toggle('hidden', !usesDixon);

    this.syncMetricsActionState();
  }

  populateEntrySelect(select, entries, emptyLabel) {
    if (!select) return;
    const previous = select.value;
    select.innerHTML = '';
    if (entries.length === 0) {
      select.appendChild(new Option(emptyLabel, ''));
      return;
    }
    for (const entry of entries) {
      select.appendChild(new Option(entry.file.name, entry.id));
    }
    if (entries.some(entry => entry.id === previous)) select.value = previous;
  }

  syncConsolidationControls() {
    const group = document.getElementById('consolidateGroup');
    const button = document.getElementById('consolidateSegmentations');
    const sourceCount = this.getAvailableSegmentationSources()
      .filter(source => source.type !== 'consolidated')
      .length;
    if (group) group.classList.toggle('hidden', sourceCount <= 1);
    if (button) button.disabled = this.inferenceExecutor.isRunning() || sourceCount <= 1;
  }

  getUploadedSegmentationSources() {
    return this.fileIOController.getSegmentationEntries().map(entry => ({
      id: `uploaded-${entry.id}`,
      type: 'uploaded',
      label: entry.file.name,
      file: entry.file,
      displayFile: null,
      baseFile: this.fileIOController.getPrimaryImageEntry()?.file || this.inputFile,
      modelName: this.currentModelName,
      numClasses: this.getSelectedModelConfig().numClasses,
      labelIndices: null
    }));
  }

  getAvailableSegmentationSources() {
    return [
      ...this.segmentationResults,
      ...this.getUploadedSegmentationSources()
    ];
  }

  getSegmentationSourceById(id) {
    return this.getAvailableSegmentationSources().find(source => source.id === id) || null;
  }

  getSelectedMetricsSegmentationSource() {
    const select = document.getElementById('metricsSegmentationSelect');
    if (!select?.value) return this.getAvailableSegmentationSources()[0] || null;
    return this.getSegmentationSourceById(select.value);
  }

  syncPostprocessingControls() {
    const section = document.getElementById('postprocessingSection');
    const select = document.getElementById('metricsSegmentationSelect');
    const sources = this.getAvailableSegmentationSources();

    if (section) section.classList.toggle('hidden', sources.length === 0);

    if (select) {
      const previous = select.value;
      select.innerHTML = '';
      if (sources.length === 0) {
        select.appendChild(new Option('No segmentation available', ''));
      } else {
        for (const source of sources) {
          select.appendChild(new Option(source.label, source.id));
        }
        if (sources.some(source => source.id === previous)) {
          select.value = previous;
        } else if (this.activeSegmentationId && sources.some(source => source.id === this.activeSegmentationId)) {
          select.value = this.activeSegmentationId;
        } else {
          select.value = sources[0].id;
        }
      }
      select.disabled = sources.length === 0 || this.inferenceExecutor.isRunning();
    }

    this.syncConsolidationControls();
    this.syncMetricsActionState();
  }

  syncMetricsActionState() {
    const button = document.getElementById('calculateMetrics');
    if (!button) return;
    button.disabled = this.inferenceExecutor.isRunning() || !this.getSelectedMetricsSegmentationSource();
  }

  clearMetricsIfSourceChanged(sourceId) {
    if (!this._metricsSourceId || this._metricsSourceId === sourceId) return;
    this.metricsSummary.hide();
    this._pendingMetrics = null;
    this._metricsSourceId = null;
  }

  async consolidateSegmentations() {
    const sources = this.getAvailableSegmentationSources()
      .filter(source => source.type !== 'consolidated');
    if (sources.length <= 1) {
      this.updateOutput('At least two segmentation label maps are required for consolidation.');
      return;
    }

    const sourceModel = sources.find(source => source.modelName)?.modelName;
    const modelConfig = Config.MODELS.find(m => m.name === sourceModel) || this.getSelectedModelConfig();
    const numClasses = Math.max(
      modelConfig.numClasses,
      ...sources.map(source => source.numClasses || 0)
    );
    this.setWorkerButtonsBusy(true);
    this.metricsSummary.hide();
    this._pendingMetrics = null;
    this._metricsSourceId = null;
    this._lastDetectedLabelIndices = [];
    this._activeWorkerTask = 'consolidation';
    this._suppressIntermediateResults = true;

    try {
      const payload = {
        segmentationDataList: await Promise.all(sources.map(source => source.file.arrayBuffer())),
        settings: {
          numClasses
        }
      };
      await this.inferenceExecutor.consolidateSegmentations(payload);
      const result = this.inferenceExecutor.getResult('segmentation');
      if (!result?.file) throw new Error('No consolidated segmentation produced');

      const file = await this.cloneResultFile(result.file, 'consolidated_segmentation.nii');
      const consolidated = {
        id: `consolidated-${Date.now()}`,
        type: 'consolidated',
        label: 'Consolidated segmentation',
        file,
        displayFile: null,
        baseFile: sources.find(source => source.baseFile)?.baseFile || this.inputFile,
        modelName: modelConfig.name,
        numClasses,
        labelIndices: [...this._lastDetectedLabelIndices]
      };

      this.segmentationResults = this.segmentationResults.filter(item => item.type !== 'consolidated');
      this.segmentationResults.push(consolidated);
      this._suppressIntermediateResults = false;
      this._activeWorkerTask = null;
      this.updateOutput('Consolidated segmentation ready for inspection and metrics.');
      this.refreshResultsPanel();
      this.syncPostprocessingControls();
      await this.showSegmentationSource(consolidated.id);
      const metricsSelect = document.getElementById('metricsSegmentationSelect');
      if (metricsSelect) metricsSelect.value = consolidated.id;
    } catch (error) {
      this.updateOutput(`Error: ${error.message}`);
      this.onInferenceError(error.message);
    } finally {
      this._suppressIntermediateResults = false;
      this._activeWorkerTask = null;
      this.setWorkerButtonsBusy(false);
      this.syncPostprocessingControls();
    }
  }

  async calculateMetrics() {
    const segmentationSource = this.getSelectedMetricsSegmentationSource();
    if (!segmentationSource) {
      this.updateOutput('Choose a segmentation label map before calculating metrics.');
      return;
    }

    const imfConfig = this.getImfMetricConfig();
    if (imfConfig.error) {
      this.updateOutput(imfConfig.error);
      return;
    }

    const modelConfig = Config.MODELS.find(m => m.name === segmentationSource.modelName) || this.getSelectedModelConfig();
    this.currentModelName = modelConfig.name;
    this.setWorkerButtonsBusy(true);
    this.metricsSummary.hide();
    this._pendingMetrics = null;
    this._metricsSourceId = null;
    this._activeWorkerTask = 'metrics';

    try {
      const payload = {
        segmentationDataList: [await segmentationSource.file.arrayBuffer()],
        settings: {
          numClasses: segmentationSource.numClasses || modelConfig.numClasses,
          consolidateSegmentations: false,
          imfMetrics: imfConfig.workerSettings
        }
      };

      if (imfConfig.sourceEntry) {
        payload.metricSourceData = await imfConfig.sourceEntry.file.arrayBuffer();
      }
      if (imfConfig.fatEntry && imfConfig.waterEntry) {
        payload.dixonFatData = await imfConfig.fatEntry.file.arrayBuffer();
        payload.dixonWaterData = await imfConfig.waterEntry.file.arrayBuffer();
      }

      await this.inferenceExecutor.calculateMetrics(payload);
      this.updateOutput('Metrics ready.');
    } catch (error) {
      this.updateOutput(`Error: ${error.message}`);
      this.onInferenceError(error.message);
    } finally {
      this._activeWorkerTask = null;
      this.setWorkerButtonsBusy(false);
      this.syncPostprocessingControls();
    }
  }

  getEntryById(id) {
    return this.fileIOController.getEntries().find(entry => entry.id === id) || null;
  }

  getImfMetricConfig() {
    const enabled = !!document.getElementById('imfToggle')?.checked;
    const defaults = Config.INFERENCE_DEFAULTS.imfMetrics;
    if (!enabled) return { workerSettings: { enabled: false } };

    const mode = document.getElementById('imfModeSelect')?.value || 'threshold';
    const usesThreshold = mode !== 'dixon';
    const usesDixon = mode === 'dixon' || mode === 'both';
    const sourceEntry = usesThreshold
      ? this.getEntryById(document.getElementById('imfSourceSelect')?.value) ||
        this.fileIOController.getPrimaryImageEntry()
      : null;
    const fatEntry = usesDixon
      ? this.getEntryById(document.getElementById('imfFatSelect')?.value)
      : null;
    const waterEntry = usesDixon
      ? this.getEntryById(document.getElementById('imfWaterSelect')?.value)
      : null;

    if (usesThreshold && (!sourceEntry || sourceEntry.role === 'segmentation')) {
      return { error: 'T1/T2 SE IMF metrics require one source image and a segmentation.' };
    }
    if (usesDixon && (!fatEntry || !waterEntry)) {
      return { error: 'Dixon IMF metrics require both a fat image and a water image.' };
    }

    return {
      sourceEntry,
      fatEntry,
      waterEntry,
      workerSettings: {
        enabled: true,
        mode,
        method: document.getElementById('imfMethodSelect')?.value || defaults.method,
        components: parseInt(document.getElementById('imfComponentsSelect')?.value || defaults.components, 10)
      }
    };
  }

  cancelSegmentation() {
    this.inferenceExecutor.cancel();
    this._suppressIntermediateResults = false;
    this._activeWorkerTask = null;
    const runBtn = document.getElementById('runSegmentation');
    const cancelBtn = document.getElementById('cancelButton');
    if (runBtn) runBtn.disabled = false;
    if (cancelBtn) cancelBtn.disabled = true;
    this.syncPostprocessingControls();
  }

  // ==================== Results ====================

  handleStageData(data) {
    if (this._suppressIntermediateResults) return;
    if (data.stage !== 'segmentation') return;

    const resultsSection = document.getElementById('resultsSection');
    if (resultsSection) {
      resultsSection.classList.remove('hidden');
      resultsSection.classList.remove('collapsed');
    }

    this.addVolumeToggles();

    const overlayControl = document.getElementById('overlayControl');
    if (overlayControl) overlayControl.classList.toggle('hidden', !this.isViewerAvailable());
  }

  handleDetectedLabels(labelIndices) {
    this._lastDetectedLabelIndices = Array.isArray(labelIndices) ? [...labelIndices] : [];
    if (this._suppressIntermediateResults) return;
    this.showDetectedMuscles(labelIndices);
  }

  refreshResultsPanel() {
    const sources = this.getAvailableSegmentationSources();
    const resultsSection = document.getElementById('resultsSection');
    if (resultsSection) {
      resultsSection.classList.toggle('hidden', sources.length === 0);
      if (sources.length > 0) resultsSection.classList.remove('collapsed');
    }

    this.addVolumeToggles();

    const overlayControl = document.getElementById('overlayControl');
    if (overlayControl) overlayControl.classList.toggle('hidden', sources.length === 0 || !this.isViewerAvailable());
  }

  addVolumeToggles() {
    const container = document.getElementById('stageButtons');
    if (!container) return;
    container.innerHTML = '';

    // Input Image toggle
    const inputRow = document.createElement('div');
    inputRow.className = 'volume-toggle';
    const inputLabel = document.createElement('label');
    inputLabel.className = 'viewer-checkbox';
    const inputCb = document.createElement('input');
    inputCb.type = 'checkbox';
    inputCb.id = 'toggleInput';
    inputCb.checked = this._inputVisible;
    inputCb.disabled = !this.isViewerAvailable() && !this.fallbackPreview?.isSupported?.();
    inputLabel.appendChild(inputCb);
    inputLabel.appendChild(document.createTextNode('Input Image'));
    inputRow.appendChild(inputLabel);
    container.appendChild(inputRow);

    inputCb.addEventListener('change', (e) => this.toggleInputVisibility(e.target.checked));
    const sources = this.getAvailableSegmentationSources();
    if (sources.length === 0) return;

    const segRow = document.createElement('div');
    segRow.className = 'volume-toggle';
    const segLabel = document.createElement('label');
    segLabel.className = 'viewer-checkbox';
    const segCb = document.createElement('input');
    segCb.type = 'checkbox';
    segCb.id = 'toggleSegmentation';
    segCb.checked = this._segmentationVisible;
    segCb.disabled = !this.isViewerAvailable() && !this.fallbackPreview?.isSupported?.();
    segLabel.appendChild(segCb);
    segLabel.appendChild(document.createTextNode('Segmentation overlay'));
    segRow.appendChild(segLabel);
    container.appendChild(segRow);

    const resultList = document.createElement('div');
    resultList.className = 'segmentation-result-list';
    for (const source of sources) {
      const row = document.createElement('div');
      row.className = 'segmentation-result-row';

      const label = document.createElement('label');
      label.className = 'viewer-checkbox segmentation-result-label';
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'activeSegmentation';
      radio.value = source.id;
      radio.checked = source.id === (this.activeSegmentationId || sources[0].id);
      radio.disabled = !this.isViewerAvailable() && !this.fallbackPreview?.isSupported?.();
      radio.addEventListener('change', () => {
        if (radio.checked) void this.showSegmentationSource(source.id);
      });
      label.appendChild(radio);
      label.appendChild(document.createTextNode(source.label));

      const dlBtn = document.createElement('button');
      dlBtn.className = 'download-btn segmentation-download-button';
      dlBtn.type = 'button';
      dlBtn.title = 'Download segmentation';
      dlBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg><span>Download</span>';
      dlBtn.addEventListener('click', () => this.downloadSegmentationSource(source.id));

      row.appendChild(label);
      row.appendChild(dlBtn);
      resultList.appendChild(row);
    }
    container.appendChild(resultList);

    segCb.addEventListener('change', (e) => this.toggleOverlayVisibility(e.target.checked));
  }

  async showSegmentationSource(id) {
    const source = this.getSegmentationSourceById(id);
    if (!source) return;

    this.activeSegmentationId = source.id;
    this.currentModelName = source.modelName || this.currentModelName;
    const overlayFile = source.displayFile || source.file;
    const baseFile = source.baseFile || this.fileIOController.getPrimaryImageEntry()?.file || this.inputFile;

    document.querySelectorAll('input[name="activeSegmentation"]').forEach(input => {
      input.checked = input.value === source.id;
    });

    if (this.isViewerAvailable() && baseFile) {
      const overlayOpacity = this._segmentationVisible ? this._overlaySliderValue : 0;
      const canReuseHiddenBase = !this._inputVisible && this.nv?.volumes?.length > 0;
      if (canReuseHiddenBase) {
        await this.viewerController.replaceOverlay(overlayFile, 'musclemap', overlayOpacity);
      } else {
        await this.viewerController.showResultAsOverlay(baseFile, overlayFile, 'musclemap', {
          baseOpacity: this._inputVisible ? 1 : 0,
          overlayOpacity
        });
      }
      this.applyVolumeVisibility();
      this.syncWindowControls();
    } else {
      await this.renderFallbackPreview(overlayFile, { stageName: source.label });
    }

    this.clearMetricsIfSourceChanged(source.id);

    if (source.labelIndices?.length) {
      this.showDetectedMuscles(source.labelIndices);
    } else {
      this._detectedLabels = null;
      this.muscleLegend.hide();
    }

    const metricsSelect = document.getElementById('metricsSegmentationSelect');
    if (metricsSelect && Array.from(metricsSelect.options).some(option => option.value === source.id)) {
      metricsSelect.value = source.id;
    }
    this.updateViewerInfo(this._lastLocationData);
  }

  downloadSegmentationSource(id) {
    const source = this.getSegmentationSourceById(id);
    if (!source?.file) return;

    const name = source.file.name || `${source.id}.nii`;
    this.downloadFile(source.file, name);
    this.updateOutput(`Downloaded segmentation: ${name}`);
  }

  toggleInputVisibility(visible) {
    this._inputVisible = visible;
    if (!this.isViewerAvailable()) {
      if (visible) void this.renderFallbackPreview(this.inputFile, { stageName: 'Input image' });
      return;
    }
    if (visible) {
      const source = this.getSegmentationSourceById(this.activeSegmentationId);
      if (source?.baseFile && this.viewerController.getCurrentFile?.() !== source.baseFile) {
        void this.showSegmentationSource(source.id);
        return;
      }
    }
    this.viewerController.setBaseOpacity(visible ? 1 : 0);
  }

  applyVolumeVisibility() {
    if (!this.isViewerAvailable()) return;
    this.viewerController.setBaseOpacity(this._inputVisible ? 1 : 0);
    this.viewerController.setOverlayOpacity(this._segmentationVisible ? this._overlaySliderValue : 0);

    const opacitySlider = document.getElementById('overlayOpacity');
    if (opacitySlider) opacitySlider.disabled = !this._segmentationVisible;
    this.updateViewerInfo(this._lastLocationData);
  }

  toggleOverlayVisibility(visible) {
    this._segmentationVisible = visible;
    if (!this.isViewerAvailable()) {
      if (visible) {
        const source = this.getSegmentationSourceById(this.activeSegmentationId) ||
          this.getAvailableSegmentationSources()[0];
        void this.renderFallbackPreview(source?.displayFile || source?.file, { stageName: source?.label || 'Segmentation' });
      }
      this.updateViewerInfo(this._lastLocationData);
      return;
    }
    const opacitySlider = document.getElementById('overlayOpacity');
    if (visible) {
      this.viewerController.setOverlayOpacity(this._overlaySliderValue);
      if (opacitySlider) opacitySlider.disabled = false;
    } else {
      this.viewerController.setOverlayOpacity(0);
      if (opacitySlider) opacitySlider.disabled = true;
    }
    this.updateViewerInfo(this._lastLocationData);
  }

  showDetectedMuscles(labelIndices) {
    const modelLabels = getLabelsForModel(this.currentModelName);
    const allLabels = getMuscleLabels(modelLabels);
    const detected = labelIndices.map(idx => {
      const label = allLabels.find(l => l.index === idx);
      return label || { index: idx, name: getLabelName(idx, modelLabels), color: getLabelColor(idx, modelLabels) };
    });
    this._detectedLabels = detected;
    this.muscleLegend.show(detected, this._pendingMetrics);

    // If metrics already arrived, show summary
    if (this._pendingMetrics) {
      this.metricsSummary.show(this._pendingMetrics, detected);
    }
  }

  handleMetrics(metrics) {
    if (this._suppressIntermediateResults) return;
    this._pendingMetrics = metrics;
    this._metricsSourceId = document.getElementById('metricsSegmentationSelect')?.value ||
      this.activeSegmentationId ||
      null;

    // If detected labels already arrived, update legend with volumes and show summary
    if (this._detectedLabels) {
      this.muscleLegend.show(this._detectedLabels, metrics);
      this.metricsSummary.show(metrics, this._detectedLabels);
    }
  }

  onWorkerInitialized() {
    if (this.inferenceExecutor.webgpuAvailable) {
      const group = document.getElementById('webgpuGroup');
      if (group) group.classList.remove('hidden');
    }
  }

  onInferenceComplete() {
    if (this._suppressIntermediateResults) return;

    const runBtn = document.getElementById('runSegmentation');
    const cancelBtn = document.getElementById('cancelButton');
    const statusText = document.getElementById('statusText');
    if (runBtn) runBtn.disabled = false;
    if (cancelBtn) cancelBtn.disabled = true;
    if (statusText) statusText.textContent = 'Ready';

    if (this._activeWorkerTask === 'metrics') {
      this.syncPostprocessingControls();
      return;
    }

    // Load segmentation into viewer: prefer downsampled display version for faster 3D rendering
    const displayResult = this.inferenceExecutor.getResult('segmentation_display');
    const fullResult = this.inferenceExecutor.getResult('segmentation');
    const overlayFile = displayResult?.file || fullResult?.file;
    if (overlayFile && this.inputFile) {
      if (this.isViewerAvailable()) {
        this.viewerController.showResultAsOverlay(this.inputFile, overlayFile, 'musclemap', {
          baseOpacity: this._inputVisible ? 1 : 0,
          overlayOpacity: this._segmentationVisible ? this._overlaySliderValue : 0
        }).then(() => {
          this.applyVolumeVisibility();
          this.syncWindowControls();
        });
      } else {
        void this.renderFallbackPreview(overlayFile, { stageName: 'Segmentation' });
      }
    }
  }

  onInferenceError(msg) {
    const runBtn = document.getElementById('runSegmentation');
    const cancelBtn = document.getElementById('cancelButton');
    const statusText = document.getElementById('statusText');
    if (runBtn) runBtn.disabled = false;
    if (cancelBtn) cancelBtn.disabled = true;
    if (statusText) statusText.textContent = 'Error';
  }

  disableAllResultTabs() {
    const container = document.getElementById('stageButtons');
    if (container) container.innerHTML = '';
    this._inputVisible = true;
    this._segmentationVisible = true;
    this._overlaySliderValue = 0.5;
  }

  clearResults() {
    this.inferenceExecutor.clearResults();
    this.segmentationResults = [];
    this.activeSegmentationId = null;
    this.disableAllResultTabs();
    this.muscleLegend.hide();
    this.metricsSummary.hide();
    this._pendingMetrics = null;
    this._metricsSourceId = null;
    this._detectedLabels = null;
    this._lastDetectedLabelIndices = [];

    const resultsSection = document.getElementById('resultsSection');
    if (resultsSection) {
      resultsSection.classList.add('hidden');
      resultsSection.classList.add('collapsed');
    }

    const overlayControl = document.getElementById('overlayControl');
    if (overlayControl) overlayControl.classList.add('hidden');

    const opacitySlider = document.getElementById('overlayOpacity');
    if (opacitySlider) {
      opacitySlider.disabled = false;
      opacitySlider.value = 0.5;
    }
    const opacityDisplay = document.getElementById('overlayOpacityValue');
    if (opacityDisplay) opacityDisplay.textContent = '50%';

    if (this.inputFile && this.isViewerAvailable()) {
      this.viewerController.loadBaseVolume(this.inputFile);
    } else if (this.inputFile) {
      void this.renderFallbackPreview(this.inputFile, { stageName: 'Input image' });
    }

    this.updateViewerInfo(this._lastLocationData);
    this.syncPostprocessingControls();
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

  clearFiles() {
    this.fileIOController.clearFiles();
    this.inputFile = null;
    this.clearResults();
  }
}

function startMuscleMapApp() {
  if (!window.app) window.app = new MuscleMapApp();
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', startMuscleMapApp);
} else {
  startMuscleMapApp();
}
