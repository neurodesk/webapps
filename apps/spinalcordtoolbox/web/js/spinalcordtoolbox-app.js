import { createExampleSelector, bindSectionDisclosures } from '@neurodesk/webapp-components/ui';
bindSectionDisclosures(document);

/**
 * SpinalCordToolbox - Browser-based spinal cord segmentation
 *
 * Main application class. Orchestrates controllers, viewer, and inference.
 * Pipeline is split into interactive steps that the user runs sequentially.
 */

import { registerSctAutomation } from './automation.js';
import { SctInputSessions } from './controllers/SctInputSessions.js';
import { SctAnalysis } from './controllers/SctAnalysis.js';
import { SctPipeline } from './controllers/SctPipeline.js';
import { defineConsole } from '@neurodesk/webapp-components/ui';
import { ProgressManager } from '@neurodesk/webapp-components/ui';
import { ModalManager } from '@neurodesk/webapp-components/ui';
import { FallbackNiftiPreview } from './modules/fallback-nifti-preview.js';
import { SctViewer } from './modules/sct-viewer.js';
import { SctManualEdits } from './app/manual-edits.js';
import * as Config from './app/config.js';
import { SessionResultStore, restoreSessionResults, snapshotSessionResults } from './app/session-results.js';
import { ANALYSIS, TECHNICAL, describeRun, routePipelineMessage, routeWorkerLog } from './app/log-channels.js';
import { generateLabelColormap, getLabelName } from './app/labels.js';
import { DEFAULT_TASK_ID, SCT_TASKS, getDefaultTask, getPrimaryModelAsset, getTaskById, getModelCacheKey, getTaskModelUrl, isTaskRunnable } from './app/sct-tasks.js';
import './modules/sct-processing.js';

export class SpinalCordToolboxApp {
  // Shown in the viewer panel when WebGL2/NiiVue cannot initialize. Names the
  // cause (WebGL2) and the remedy (hardware acceleration) so a user with a
  // fixable browser config is not left thinking the app is simply broken.
  static VIEWER_UNAVAILABLE_GUIDANCE =
    'No preview: WebGL2 failed. Enable hardware acceleration (see chrome://gpu), then reload.';

  // Shown under the viewer until the first crosshair readout replaces it.
  static VIEWER_HINT =
    'Pan/zoom mode: scroll or pinch to zoom, right-drag to pan. The reset button restores it.';

  constructor() {
    // Viewer: FreeBrowse around NiiVue, mounted in setupViewer(). `viewer` owns
    // which volumes are shown, `viewerMount` is the shared mount handle
    // ({ nv, ready, destroy }) and `nv` the NiiVue instance; all three stay
    // null when WebGL2 is unavailable.
    this.viewer = null;
    this.viewerMount = null;
    this.nv = null;

    // UI modules
    // One console, two logs (analysis and technical); see app/log-channels.js for what goes where.
    defineConsole();
    this.log = document.getElementById('spinalcordtoolbox-log');
    this.progress = new ProgressManager(Config.PROGRESS_CONFIG);

    // State
    this.inputFile = null;
    this.currentResultTab = 'input';
    this.currentRunningStep = null;
    this.abortUICheckpoint = null;
    this._inputVisible = true;
    this._stageVisibility = {
      input: true,
      segmentation: true,
      lesion: true,
      spine_step1: true,
      spine_discs: true
    };
    this._renderViewerPromise = Promise.resolve();
    this._renderViewerRequested = false;
    this._lastLocationData = null;
    this._viewerMode = 'single';
    this._activeSessionId = null;
    // Per-session results (app/session-results.js). The executor holds the
    // results of `_resultsSessionId`; every other image's are parked here.
    this.sessionResults = new SessionResultStore();
    this._resultsSessionId = null;
    this._comparisonPanels = [];
    this.selectedTask = getDefaultTask();
    // "Stage data changed": every change of a result mask (model output,
    // manual edit, restore, removal) is announced here; see setStageData().
    this.stageEvents = new EventTarget();
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
    const aboutVersionEl = document.getElementById('aboutAppVersion');
    if (aboutVersionEl) aboutVersionEl.textContent = `v${Config.VERSION}`;

    // Controllers
    this.fileIOController = new SctInputSessions({
      updateOutput: (msg) => this.logAnalysis(msg),
      onFileLoaded: (file, context) => (this.inputReady = this.onFileLoaded(file, context)),
      onFilesCleared: () => {
        this.inputCleared = this.onFilesCleared();
      },
      onSessionsChanged: () => this.onInputSessionsChanged()
    });

    this.inferenceExecutor = new SctPipeline({
      updateOutput: (msg) => {
        const { channel, level } = routePipelineMessage(msg);
        this.writeLog(channel, msg, level);
      },
      workerLog: (msg, details) => {
        const { channel, level } = routeWorkerLog(msg, details);
        this.writeLog(channel, msg, level);
      },
      setProgress: (val, text) => this.setProgress(val, text),
      onStageData: (data) => this.handleStageData(data),
      onComplete: () => this.onInferenceComplete(),
      onError: (msg) => this.onInferenceError(msg),
      onInitialized: () => this.onWorkerInitialized(),
      onStepComplete: (step) => this.onStepComplete(step),
      onVolumeInfo: (info) => this.onVolumeInfo(info)
    });

    // Modals
    this.aboutModal = new ModalManager('aboutModal');
    this.citationsModal = new ModalManager('citationsModal');
    this.privacyModal = new ModalManager('privacyModal');

    this.analysis = new SctAnalysis({
      before: document.getElementById('resultsSection'),
      progress: this.progress,
      log: message => this.updateOutput(message),
      canRun: () => !this.inferenceExecutor.isRunning()
    });

    this.setupShellEventListeners();
    this.manualEdits = new SctManualEdits(this);
    this.onStageDataChanged(change => this.onStageMaskChanged(change));

    // The viewer bundle loads while the rest of the page becomes usable, so a
    // file chosen straight after load is never lost. Render paths await it.
    this.viewerReady = this.setupViewer().then((available) => {
      this.syncViewerModeControls();
      if (available) this.manualEdits.attachViewer(this.viewer);
      return available;
    });

    this.setupEventListeners();
    await this.setupExamples();
    this.populateTaskSelector();
    this.setupInfoTooltips();
    this.syncViewerModeControls();

    // Start ONNX initialization in background
    this.inferenceExecutor.initialize();
    await this.viewerReady;
    this.automation = registerSctAutomation(this);
  }

  async setupViewer() {
    try {
      this.viewer = await SctViewer.mount({
        element: document.getElementById('freebrowseViewer'),
        niivueOptions: Config.VIEWER_CONFIG,
        canvasLabel: 'Spinal cord image viewer',
        loadModule: this.loadViewerModule,
        onLocationChange: (data) => {
          this._lastLocationData = data;
          this.updateViewerInfo(data);
        },
        onStageVisibilityChange: (stage, visible) => this.onViewerStageVisibility(stage, visible),
        onComparisonActivate: (sessionId) => this.activateComparisonSession(sessionId),
        onComparisonLocation: (sessionId, data) => this.updateComparisonInfo(sessionId, data),
        updateOutput: (msg) => this.updateOutput(msg)
      });
      this.viewerMount = this.viewer.handle;
      this.nv = this.viewer.nv;
      this.viewerAvailable = true;
      this.setViewerUnavailableMessage('');
      this.setViewerControlsEnabled(true);
      this.updateViewerInfo(null);
      return true;
    } catch (error) {
      this.disableViewer(error?.message || 'Viewer initialization failed.');
      return false;
    }
  }

  isViewerAvailable() {
    return this.viewerAvailable && !!this.viewer?.isAvailable();
  }

  isImagePreviewAvailable() {
    return this.isViewerAvailable() || this.fallbackPreview?.isSupported?.();
  }

  disableViewer(reason) {
    this.viewerAvailable = false;
    this.viewerUnavailableReason = reason;
    this.viewer = null;
    this.viewerMount = null;
    this.nv = null;
    this.fallbackPreview?.setUnavailable(reason);
    this.setViewerUnavailableMessage(reason);
    this.setViewerControlsEnabled(false);
    this.updateViewerInfo({ string: 'Image preview unavailable' });
    this.updateOutput(`Image preview unavailable: ${reason}`, 'warning');
  }

  setViewerUnavailableMessage(reason) {
    document.body.classList.toggle('viewer-unavailable', !!reason);
    const embed = document.getElementById('freebrowseViewer');
    if (embed) embed.hidden = !!reason;
    const message = document.getElementById('viewerUnavailableMessage');
    if (message) {
      message.hidden = !reason;
      if (reason) {
        message.textContent = SpinalCordToolboxApp.VIEWER_UNAVAILABLE_GUIDANCE;
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
      primaryEl.textContent = data?.string || (this.isViewerAvailable() ? SpinalCordToolboxApp.VIEWER_HINT : '');
    }

    const labelEl = document.getElementById('viewerInfoLabel');
    if (labelEl) {
      labelEl.textContent = this.getOverlayLabelText(data);
    }
  }

  getOverlayLabelText(data) {
    if (!this.isViewerAvailable() || !this.nv?.volumes?.length) return '';

    const visibleLabelStages = this.getVisibleOverlayStages().slice().reverse();
    for (const stage of visibleLabelStages) {
      const volumeIndex = this.viewer.getVolumeIndexForStage(stage);
      if (volumeIndex === null || volumeIndex === undefined) continue;

      const rawValue = data?.values?.[volumeIndex]?.value;
      if (!Number.isFinite(rawValue)) continue;

      const labelIndex = Math.round(rawValue);
      if (labelIndex <= 0) continue;

      const taskId = this.getOverlayLabelTaskId(stage);
      return getLabelName(labelIndex, taskId);
    }

    return '';
  }

  // ==================== Event Listeners ====================

  async setupExamples() {
    const response = await fetch(new URL('examples.json', document.baseURI));
    if (!response.ok) throw new Error('Could not load the example catalog.');
    const examples = await response.json();
    this.exampleSelector = createExampleSelector({
      scope: document.querySelector('.app-container'),
      examples,
      onLoad: async (example, { fetchFiles, assertCurrent }) => {
        if (this.manualEdits && !this.manualEdits.confirmDiscard('Loading the example', { others: this.parkedUnsavedEdits?.() || [] })) {
          throw new DOMException('Loading the example was cancelled to keep manual edits.', 'AbortError');
        }
        const files = await fetchFiles();
        assertCurrent();
        this.fileIOController.clearFiles();
        await this.inputCleared;
        assertCurrent();
        this.fileIOController.handleFiles(files);
        await this.inputReady;
      },
      onStatus: (message, error) => this.updateOutput(message, error ? 'error' : 'info'),
    });
    const input = document.getElementById('fileInput');
    input.closest('.section-content').prepend(this.exampleSelector);
  }

  setupEventListeners() {
    const fileInput = document.getElementById('fileInput');
    if (fileInput) {
      fileInput.addEventListener('change', (e) => {
        if (!this.confirmAddingImage()) {
          e.target.value = '';
          return;
        }
        this.fileIOController.handleFiles(e.target.files);
      });
    }

    this.setupDropZone();

    const runBtn = document.getElementById('runSegmentation');
    if (runBtn) runBtn.addEventListener('click', () => this.runSegmentation());

    const modelSelect = document.getElementById('modelSelect');
    if (modelSelect) {
      modelSelect.addEventListener('change', () => this.onTaskSelectionChanged(modelSelect.value));
    }

    const cancelBtn = document.getElementById('cancelButton');
    if (cancelBtn) cancelBtn.addEventListener('click', () => this.analysis?.busy ? this.analysis.cancel() : this.abortCurrentStep());

    document.querySelectorAll('[data-viewer-mode]').forEach(btn => {
      btn.addEventListener('click', () => {
        void this.setViewerMode(btn.dataset.viewerMode);
      });
    });

    const compareLayout = document.getElementById('compareLayoutSelect');
    if (compareLayout) {
      compareLayout.addEventListener('change', () => {
        this.viewer?.setComparisonSliceType(Number(compareLayout.value));
      });
    }

    const compareLink = document.getElementById('compareLinkButton');
    if (compareLink) {
      compareLink.addEventListener('click', () => this.setComparisonLinked(!this.viewer?.isComparisonLinked()));
    }

    const screenshotBtn = document.getElementById('screenshotViewer');
    if (screenshotBtn) {
      screenshotBtn.addEventListener('click', () => this.saveScreenshot());
    }

    const clearResults = document.getElementById('clearResults');
    if (clearResults) {
      clearResults.addEventListener('click', () => {
        if (this.manualEdits.confirmDiscard('Clear All')) this.clearResults();
      });
    }

    window.addEventListener('resize', () => {
      if (!this.isViewerAvailable()) this.fallbackPreview?.redraw?.();
    });
  }

  setupShellEventListeners() {
    this.bindModalButton('aboutButton', this.aboutModal);
    this.bindModalButton('citationsButton', this.citationsModal);
    this.bindModalButton('privacyButton', this.privacyModal);
    this.bindCloseButton('closeAbout', this.aboutModal);
    this.bindCloseButton('closeCitations', this.citationsModal);
    this.bindCloseButton('closePrivacy', this.privacyModal);
  }

  bindModalButton(buttonId, modal) {
    const button = document.getElementById(buttonId);
    if (button) button.addEventListener('click', () => modal.open());
  }

  bindCloseButton(buttonId, modal) {
    const button = document.getElementById(buttonId);
    if (button) button.addEventListener('click', () => modal.close());
  }

  populateTaskSelector() {
    const modelSelect = document.getElementById('modelSelect');
    if (!modelSelect) return;

    modelSelect.innerHTML = '';
    for (const task of SCT_TASKS) {
      if (!isTaskRunnable(task)) continue;
      const option = document.createElement('option');
      option.value = task.id;
      option.textContent = task.displayName;
      if (task.id === this.selectedTask.id) option.selected = true;
      modelSelect.appendChild(option);
    }
    this.applyTaskInferenceDefaults();
    this.updateTaskDetails();
  }

  onTaskSelectionChanged(taskId) {
    this.selectedTask = getTaskById(taskId);
    this.applyTaskInferenceDefaults();
    this.updateTaskDetails();
  }

  applyTaskInferenceDefaults() {
    const assetDefaults = getPrimaryModelAsset(this.selectedTask)?.inferenceDefaults || {};
    const thresholdInput = document.getElementById('thresholdInput');
    if (thresholdInput) {
      thresholdInput.value = String(assetDefaults.probabilityThreshold ?? Config.INFERENCE_DEFAULTS.probabilityThreshold);
    }

    const minSizeInput = document.getElementById('minSizeInput');
    if (minSizeInput) {
      minSizeInput.value = String(assetDefaults.minComponentSize ?? Config.INFERENCE_DEFAULTS.minComponentSize);
    }

    const ttaToggle = document.getElementById('ttaToggle');
    if (ttaToggle) {
      ttaToggle.checked = !!(assetDefaults.testTimeAugmentation ?? Config.INFERENCE_DEFAULTS.testTimeAugmentation);
    }
  }

  updateTaskDetails() {
    const task = this.selectedTask || getDefaultTask();
    const details = document.getElementById('taskDetails');
    const runBtn = document.getElementById('runSegmentation');
    const tooltip = document.getElementById('taskInfoTooltip');
    if (tooltip) tooltip.textContent = task.description || 'Select the segmentation task to run.';
    if (details) {
      const contrasts = (task.inputContrasts || []).join(', ') || 'see SCT documentation';
      details.textContent = `Input: ${contrasts}`;
      details.classList.toggle('task-supported', task.supportStatus === 'supported');
      details.classList.toggle('task-disabled', task.supportStatus !== 'supported');
    }
    if (runBtn) {
      // Run stays locked until an input has unlocked the segmentation step;
      // the section's pointer-events rule does not stop keyboard activation.
      runBtn.disabled = !isTaskRunnable(task) || !this.isStepEnabled('inference');
      runBtn.title = isTaskRunnable(task) ? 'Run SCT segmentation' : 'Task unavailable';
    }
  }

  getSelectedColormapId() {
    return `sct-${this.selectedTask?.id || DEFAULT_TASK_ID}`;
  }

  // `taskId` is the task that produced the result (its `raw.taskId`), so an
  // image keeps its colours when another image ran a different task. A mask
  // drawn from nothing names its own label set (`labelSetId`).
  getOverlayLabelTaskId(stage, taskId = this.selectedTask?.id, labelSetId = this.inferenceExecutor?.getResult(stage)?.labelSetId) {
    if (labelSetId) return labelSetId;
    if (stage === 'lesion') return 'lesion_sci_t2';
    if (stage === 'spine_step1') return 'totalspineseg';
    if (stage === 'spine_discs') return 'spineDiscs';
    if (stage === 'segmentation' && taskId === 'lesion_sci_t2') return 'spinalcord';
    return taskId || DEFAULT_TASK_ID;
  }

  setupDropZone() {
    const zone = document.getElementById('inputDropZone');
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
      if (!this.confirmAddingImage()) return;
      this.fileIOController.handleDropItems(e.dataTransfer.items);
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

  getInputSessions() {
    return this.fileIOController?.getSessions?.() || [];
  }

  getActiveSession() {
    return this.fileIOController?.getActiveSession?.() || null;
  }

  onInputSessionsChanged() {
    // A removed image takes its parked results with it.
    this.sessionResults.retain(this.getInputSessions().map(session => session.id));
    this.syncViewerModeControls();
    if (this.isCompareMode() || this.inputFile) void this.renderViewerVolumes();
  }

  canCompareSessions() {
    return this.isViewerAvailable() && this.getInputSessions().length >= 2;
  }

  isCompareMode() {
    return this._viewerMode === 'compare';
  }

  async setViewerMode(mode) {
    if (mode === 'compare' && !this.canCompareSessions()) {
      this._viewerMode = 'single';
      this.syncViewerModeControls();
      this.logAnalysis('Load at least two images before using Compare view', 'warning');
      return;
    }

    // Compare shows each image's stages, so an open drawing is applied first.
    if (mode === 'compare') await this.manualEdits?.settleBeforeSwitch();
    this._viewerMode = mode === 'compare' ? 'compare' : 'single';
    this.syncViewerModeControls();
    this.manualEdits?.sync();
    await this.renderViewerVolumes();
  }

  syncViewerModeControls() {
    if (this._viewerMode === 'compare' && !this.canCompareSessions()) {
      this._viewerMode = 'single';
    }

    const singleButton = document.getElementById('singleViewButton');
    const compareButton = document.getElementById('compareViewButton');
    if (singleButton) singleButton.classList.toggle('active', !this.isCompareMode());
    if (compareButton) {
      compareButton.classList.toggle('active', this.isCompareMode());
      compareButton.disabled = !this.canCompareSessions();
      compareButton.title = this.canCompareSessions()
        ? 'Show the loaded images side by side'
        : 'Load at least two images to compare them';
    }

    // Layout and linking apply to the comparison panels only; FreeBrowse
    // keeps its own controls for the single view.
    const layoutSelect = document.getElementById('compareLayoutSelect');
    if (layoutSelect) {
      layoutSelect.hidden = !this.isCompareMode();
      if (this.viewer) layoutSelect.value = String(this.viewer.getComparisonSliceType());
    }
    const linkButton = document.getElementById('compareLinkButton');
    if (linkButton) {
      linkButton.hidden = !this.isCompareMode();
      const linked = this.viewer?.isComparisonLinked() ?? true;
      linkButton.classList.toggle('active', linked);
      linkButton.setAttribute('aria-pressed', String(linked));
    }

    const wrapper = document.querySelector('.viewer-canvas-wrapper');
    if (wrapper) wrapper.classList.toggle('compare-mode', this.isCompareMode());

    const comparisonGrid = document.getElementById('comparisonGrid');
    if (comparisonGrid) comparisonGrid.hidden = !this.isCompareMode();
  }

  // One panel per loaded image: its input, then its own label masks, with the
  // Results eye state and label colours of the single view.
  getComparisonPanels() {
    return this.getInputSessions().map(session => ({
      id: session.id,
      name: session.name,
      entries: [
        { file: session.file, stage: 'input', visible: this.isStageVisible('input') },
        ...this.getOverlayEntries(this.getSessionResults(session.id))
      ]
    }));
  }

  // The results of one image: the executor's for the image that owns them,
  // the parked snapshot for any other.
  getSessionResults(sessionId) {
    if (sessionId && sessionId === this._resultsSessionId) return this.inferenceExecutor.getResults();
    return this.sessionResults.peek(sessionId)?.results || {};
  }

  getOverlayEntries(results) {
    return ['segmentation', 'lesion', 'spine_step1', 'spine_discs']
      .filter(stage => results?.[stage]?.file)
      .map(stage => {
        const taskId = results[stage].raw?.taskId;
        const labelSetId = results[stage].labelSetId;
        const labelTaskId = this.getOverlayLabelTaskId(stage, taskId, labelSetId);
        return {
          file: results[stage].file,
          stage,
          visible: this.isStageVisible(stage),
          colormapKey: this.getOverlayColormapId(stage, taskId, labelSetId),
          labelColormap: generateLabelColormap(labelTaskId),
          labelTaskId
        };
      });
  }

  async renderComparisonView() {
    const panels = this.getComparisonPanels();
    this._comparisonPanels = panels;
    const rendered = await this.viewer.showComparison(panels, {
      container: document.getElementById('comparisonGrid'),
      activeSessionId: this.getActiveSession()?.id || this._activeSessionId
    });
    this.syncViewerModeControls();
    if (rendered) {
      const shown = this.viewer.getComparisonViewerCount();
      const suffix = panels.length > shown ? ` (${shown} shown)` : '';
      this.updateViewerInfo({ string: `Comparison: ${panels.length} images${suffix}` });
    }
    return rendered;
  }

  setComparisonLinked(linked) {
    if (!this.viewer) return;
    this.viewer.setComparisonLinked(linked);
    this.syncViewerModeControls();
  }

  // Clicking a panel (or its title) makes that image the active one. A run
  // in progress keeps its image: switching would cancel it.
  // Unsaved manual edits in parked images, as `Stage of image` names.
  parkedUnsavedEdits() {
    const names = new Map(this.getInputSessions().map(session => [session.id, session.name]));
    return [...this.sessionResults.parked].flatMap(([id, snapshot]) => (
      SctManualEdits.unsavedInSnapshot(snapshot, names.get(id) || id)
    ));
  }

  // A new image keeps the others' results, except the least recently used
  // one when the store is full; ask if that one holds unsaved manual edits.
  confirmAddingImage() {
    const store = this.sessionResults;
    if (!this.manualEdits || store.size < store.limit || !this.inferenceExecutor.getStageOrder().length) return true;
    const [oldestId, oldest] = [...store.parked][0] || [];
    if (!oldest) return true;
    const name = this.getInputSessions().find(session => session.id === oldestId)?.name || oldestId;
    const others = SctManualEdits.unsavedInSnapshot(oldest, name);
    return this.manualEdits.confirmDiscard('Loading a new image', { current: false, others });
  }

  activateComparisonSession(sessionId) {
    if (sessionId === this.getActiveSession()?.id) return false;
    if (this.currentRunningStep) {
      this.logAnalysis('Finish or cancel the current run before switching images', 'warning');
      return false;
    }
    return this.fileIOController.activateSession(sessionId);
  }

  // Linked panels all report a location; the active panel's is shown.
  updateComparisonInfo(sessionId, data) {
    if (!this.isCompareMode() || sessionId !== this.getActiveSession()?.id) return;
    const panel = this._comparisonPanels.find(item => item.id === sessionId);
    if (!panel) return;
    const primaryEl = document.getElementById('viewerInfoPrimary');
    if (primaryEl) primaryEl.textContent = `${panel.name}: ${data?.string || ''}`;
    const labelEl = document.getElementById('viewerInfoLabel');
    if (!labelEl) return;
    labelEl.textContent = '';
    for (let index = panel.entries.length - 1; index > 0; index -= 1) {
      const entry = panel.entries[index];
      const value = Math.round(data?.values?.[index]?.value);
      if (!entry.visible || !(value > 0)) continue;
      labelEl.textContent = getLabelName(value, entry.labelTaskId);
      return;
    }
  }

  async saveScreenshot() {
    if (!this.isViewerAvailable()) {
      this.updateOutput('Image preview unavailable');
      return;
    }
    if (this.isCompareMode()) {
      const session = this.getActiveSession();
      const filename = `${(session?.name || 'comparison').replace(/\.(nii|nii\.gz)$/i, '')}_compare_screenshot.png`;
      await this.viewer.saveComparisonScreenshot(session?.id, filename);
      this.logAnalysis(`Screenshot saved: ${filename}`);
      return;
    }
    let filename = 'spinalcordtoolbox_screenshot.png';
    if (this.nv.volumes?.length) {
      const name = (this.nv.volumes[0].name || 'volume').replace(/\.(nii|nii\.gz)$/i, '');
      filename = `${name}_screenshot.png`;
    }
    await this.viewer.saveScreenshot(filename);
    this.logAnalysis(`Screenshot saved: ${filename}`);
  }

  // ==================== File Handling ====================

  async onFileLoaded(file, context = {}) {
    // An open drawing belongs to the outgoing image: apply it there first.
    await this.manualEdits?.settleBeforeSwitch();
    const sessionId = context?.session?.id || null;
    const previousId = this._activeSessionId;
    const switching = Boolean(sessionId && previousId && sessionId !== previousId);
    const overlayVisibility = { ...this._stageVisibility };
    // Synchronously, before any await: the outgoing image's results are
    // parked, so a quick second switch can neither lose nor misfile them.
    this.parkSessionResults(previousId);
    this._activeSessionId = sessionId;

    await this.resetForNewFile({ keepLogs: switching });
    // A later activation replaced this one while the worker was resetting.
    if (this._activeSessionId !== sessionId) return;
    this.inputFile = file;
    // Results eye state is a view setting and survives a switch of image.
    if (switching) this._stageVisibility = overlayVisibility;
    this.setStageVisible('input', true);
    this.restoreSessionResults(sessionId);
    if (switching) this.logAnalysis(`Active image: ${context.session.name}`);
    this.syncViewerModeControls();
    // Display and worker loading run side by side: a slow or missing viewer
    // never delays segmentation.
    const rendered = this.renderViewerVolumes();

    // Send data to worker for loading
    const inputData = await file.arrayBuffer();
    this.setStepRunning('load');
    await this.inferenceExecutor.loadVolume(inputData);
    await rendered;
  }

  // Move the executor's results to the store under `sessionId`, if that
  // image owns them and is still loaded.
  parkSessionResults(sessionId) {
    const owned = Boolean(sessionId) && this._resultsSessionId === sessionId;
    this._resultsSessionId = null;
    if (!owned) return;
    const session = this.getInputSessions().find(item => item.id === sessionId);
    if (!session) return;
    if (this.currentRunningStep === 'inference') {
      this.sessionResults.drop(sessionId);
      this.logAnalysis(`Segmentation of ${session.name} cancelled; run it again on that image`, 'warning');
      return;
    }
    const snapshot = snapshotSessionResults(this.inferenceExecutor);
    const released = this.sessionResults.park(sessionId, snapshot);
    for (const id of released) {
      const name = this.getInputSessions().find(item => item.id === id)?.name || id;
      this.logAnalysis(`Results of ${name} released to limit memory; run the task again to restore them`, 'warning');
    }
  }

  // Hand `sessionId`'s parked results back to the executor and the Results,
  // metrics and analysis mask choices. The executor's results now belong to it.
  restoreSessionResults(sessionId) {
    this._resultsSessionId = sessionId;
    const snapshot = sessionId ? this.sessionResults.unpark(sessionId) : null;
    if (!snapshot) return false;
    restoreSessionResults(this.inferenceExecutor, snapshot);
    for (const [step, status] of Object.entries(snapshot.stepStatus || {})) this.updateStepBadge(step, status);
    const resultsSection = document.getElementById('resultsSection');
    if (resultsSection) {
      resultsSection.classList.remove('hidden');
      resultsSection.classList.remove('collapsed');
    }
    this.rebuildResultsList();
    this.renderAllMetricsResults();
    // Generated mask choices for SCT analysis follow the active image.
    this.syncAnalysisMasks();
    return true;
  }

  async onFilesCleared() {
    this._viewerMode = 'single';
    this._activeSessionId = null;
    this._resultsSessionId = null;
    this.sessionResults.clear();
    this.viewer?.clearComparison(document.getElementById('comparisonGrid'));
    await this.resetForNewFile();
    this.syncViewerModeControls();
    await this.renderViewerVolumes();
  }

  // `keepLogs`: switching between loaded images keeps one running log.
  async resetForNewFile({ keepLogs = false } = {}) {
    if (this.inferenceExecutor.isRunning()) {
      this.inferenceExecutor.cancel();
    }

    this.inputFile = null;
    this.currentResultTab = 'input';
    this.currentRunningStep = null;
    this.abortUICheckpoint = null;
    this._inputVisible = true;
    this.resetStageVisibility();
    this._lastLocationData = null;
    await this.manualEdits?.reset();

    if (!keepLogs) {
      this.log?.clear(ANALYSIS);
      this.log?.clear(TECHNICAL);
    }
    this.resetStatusDisplay();
    this.resetProcessingInputs();
    this.resetViewerControls();
    this.fallbackPreview?.clear();

    await this.resetAllSteps();
    this.updateViewerInfo(null);
  }

  captureAbortUICheckpoint(step) {
    const sectionEnabled = {};
    const buttonsEnabled = {};

    for (const pipelineStep of ['inference']) {
      sectionEnabled[pipelineStep] = this.isStepEnabled(pipelineStep);
      buttonsEnabled[pipelineStep] = this.areStepButtonsEnabled(pipelineStep);
    }

    return {
      step,
      sectionEnabled,
      buttonsEnabled,
      currentResultTab: this.currentResultTab || 'input',
      inputVisible: this._inputVisible,
      stageVisibility: { ...this._stageVisibility }
    };
  }

  beginAbortableStep(step, message = 'Running segmentation…') {
    this.currentRunningStep = step;
    this.abortUICheckpoint = this.captureAbortUICheckpoint(step);
    this.inferenceExecutor.captureCheckpoint(step);
    this.setStatusError(false);
    this.progress.begin(message, { cancellable: true });
    this.manualEdits?.sync();
    // Node test harnesses must not be kept alive by the elapsed counter.
    this.progress.timer?.unref?.();
  }

  async abortCurrentStep() {
    if (!this.currentRunningStep || !this.inferenceExecutor.isRunning()) return;

    const abortedStep = this.currentRunningStep;
    const checkpoint = this.abortUICheckpoint;
    this.progress.setText('Cancelling…');
    this.resetAbortControls();

    try {
      const restoreResult = await this.inferenceExecutor.abortCurrentStep();
      if (!restoreResult) return;
      await this.restoreUIFromAbortCheckpoint(checkpoint, abortedStep);
    } catch (error) {
      this.onInferenceError(error?.message || String(error));
    } finally {
      this.currentRunningStep = null;
      this.abortUICheckpoint = null;
      this.manualEdits?.sync();
    }
  }

  async restoreUIFromAbortCheckpoint(checkpoint, abortedStep) {
    this.setStatusError(false);
    this.progress.reset('Cancelled');
    this.resetAbortControls();

    for (const step of Config.PIPELINE_STEPS) {
      this.updateStepBadge(step, this.inferenceExecutor.getStepStatus(step));
      if (checkpoint?.sectionEnabled?.[step] !== undefined) {
        this.setStepEnabled(step, checkpoint.sectionEnabled[step]);
      }
      if (checkpoint?.buttonsEnabled?.[step] !== undefined) {
        this.setStepButtonsEnabled(step, checkpoint.buttonsEnabled[step]);
      }
    }

    if (abortedStep) {
      this.updateStepBadge(abortedStep, 'pending');
      this.setStepButtonsEnabled(abortedStep, true);
    }

    const resultsSection = document.getElementById('resultsSection');
    if (resultsSection) {
      if (this.inferenceExecutor.getStageOrder().length > 0) {
        resultsSection.classList.remove('hidden');
        resultsSection.classList.remove('collapsed');
      } else {
        resultsSection.classList.add('hidden');
        resultsSection.classList.add('collapsed');
      }
    }

    this.currentResultTab = checkpoint?.currentResultTab || 'input';
    this._stageVisibility = {
      ...this.getDefaultStageVisibility(),
      ...(checkpoint?.stageVisibility || {})
    };

    this.rebuildResultsList();
    this.renderAllMetricsResults();

    const targetStage = (this.currentResultTab === 'input' || this.inferenceExecutor.getResult(this.currentResultTab))
      ? this.currentResultTab
      : 'input';
    this.currentResultTab = targetStage;

    this.setStageVisible('input', checkpoint?.inputVisible ?? true);
    if (this.inputFile && targetStage) {
      await this.renderViewerVolumes();
    }
    this.syncResultViewButtons();
    this.updateViewerInfo(this._lastLocationData);
  }

  // ==================== Pipeline Step Methods ====================

  // `discardEdits`: the caller (automation) has decided; do not ask.
  async runSegmentation({ discardEdits = false } = {}) {
    if (this.inferenceExecutor.isRunning() || this.analysis?.busy) return;
    if (discardEdits) {
      if (this.manualEdits.hasUnsavedEdits()) this.logAnalysis('Manual edits discarded by a new segmentation run', 'warning');
    } else if (!this.manualEdits.confirmDiscard('A new segmentation run')) {
      return;
    }
    await this.manualEdits.reset();

    const modelSelect = document.getElementById('modelSelect');
    const selectedTaskId = modelSelect ? modelSelect.value : DEFAULT_TASK_ID;
    const selectedTask = getTaskById(selectedTaskId);
    const selectedAsset = getPrimaryModelAsset(selectedTask);
    const assetDefaults = selectedAsset?.inferenceDefaults || {};
    const effectivePatchSize = selectedAsset?.patchSize || selectedTask.patchSize || Config.MODEL.patchSize;
    const numericSetting = (elementId, fallback, parser = parseFloat) => {
      const element = document.getElementById(elementId);
      if (!element) return fallback;
      const value = parser(element.value);
      return Number.isFinite(value) ? value : fallback;
    };
    const overlap = assetDefaults.overlap ?? Config.INFERENCE_DEFAULTS.overlap;
    const threshold = numericSetting(
      'thresholdInput',
      assetDefaults.probabilityThreshold ?? Config.INFERENCE_DEFAULTS.probabilityThreshold
    );
    const minComponentSize = numericSetting(
      'minSizeInput',
      assetDefaults.minComponentSize ?? Config.INFERENCE_DEFAULTS.minComponentSize,
      (value) => parseInt(value, 10)
    );
    const ttaDefault = !!(assetDefaults.testTimeAugmentation ?? Config.INFERENCE_DEFAULTS.testTimeAugmentation);
    const ttaToggle = document.getElementById('ttaToggle');
    const testTimeAugmentation = ttaToggle ? !!ttaToggle.checked : ttaDefault;

    if (!isTaskRunnable(selectedTask)) {
      this.logAnalysis(`SCT task "${selectedTask.displayName}" is unavailable.`, 'warning');
      this.updateTaskDetails();
      return;
    }

    if (!selectedAsset) {
      this.logAnalysis(`SCT task "${selectedTask.displayName}" has no model asset.`, 'warning');
      this.updateTaskDetails();
      return;
    }

    const modelBaseUrl = new URL(Config.MODEL_BASE_URL, window.location.href).href;
    const modelUrl = getTaskModelUrl(selectedTask);
    for (const line of describeRun({
      task: selectedTask.displayName,
      input: this.inputFile?.name || 'input',
      model: selectedAsset?.filename || Config.MODEL.name,
      sourceVersion: selectedAsset?.sourceVersion,
      threshold,
      minComponentSize,
      overlap,
      testTimeAugmentation,
      patchSize: effectivePatchSize,
    })) this.logAnalysis(line);
    this.beginAbortableStep('inference');

    // Clear previous results so a stale overlay is not auto-rendered on the
    // new run.
    this.analysis?.setGenerated({});
    this.inferenceExecutor.clearResults();
    this.disableAllResultTabs();
    this.resetStageVisibility();
    await this.renderViewerVolumes();

    this.setStepRunning('inference');
    await this.inferenceExecutor.runInference({
      overlap,
      threshold,
      minComponentSize,
      taskId: selectedTask.id,
      modelAssetId: selectedAsset?.id || selectedTask.id,
      supportStatus: selectedTask.supportStatus,
      cacheKey: getModelCacheKey(selectedTask, selectedAsset),
      provenance: {
        taskId: selectedTask.id,
        modelAssetId: selectedAsset?.id || null,
        sourceVersion: selectedAsset?.sourceVersion || 'unknown',
        appVersion: Config.VERSION
      },
      modelName: selectedAsset?.filename || Config.MODEL.name,
      modelUrl: modelUrl ? new URL(modelUrl, window.location.href).href : null,
      patchSize: effectivePatchSize,
      preprocessing: selectedAsset?.preprocessing || {},
      output: selectedAsset?.output || {},
      keepLargestComponent: !!(assetDefaults.keepLargestComponent ?? Config.INFERENCE_DEFAULTS.keepLargestComponent),
      testTimeAugmentation,
      modelBaseUrl
    });
  }

  // ==================== Step UI Management ====================

  setStepRunning(step) {
    this.updateStepBadge(step, 'running');
    this.setStepButtonsEnabled(step, false);
    if (this.currentRunningStep === step) this.progress.setCancellable(true);
  }

  getStepSectionId(step) {
    const sectionMap = {
      'load': null,
      'inference': 'stepInferenceSection'
    };
    return sectionMap[step] || null;
  }

  getStepButtonIds(step) {
    const buttonMap = {
      'inference': ['runSegmentation']
    };
    return buttonMap[step] || [];
  }

  isStepEnabled(step) {
    const sectionId = this.getStepSectionId(step);
    if (!sectionId) return false;
    const section = document.getElementById(sectionId);
    return !!section && !section.classList.contains('step-disabled');
  }

  areStepButtonsEnabled(step) {
    const buttonIds = this.getStepButtonIds(step);
    if (buttonIds.length === 0) return false;
    return buttonIds.every(id => {
      const btn = document.getElementById(id);
      return !!btn && !btn.disabled;
    });
  }

  // The status-footer × is the only abort control; it is shown while a
  // step can be cancelled.
  resetAbortControls() {
    this.progress.setCancellable(false);
  }

  async resetAllSteps() {
    await this.manualEdits?.reset();
    // Reset worker state
    if (this.inferenceExecutor.isReady()) {
      await this.inferenceExecutor.resetWorkerState();
    }

    this.currentRunningStep = null;
    this.abortUICheckpoint = null;

    // Reset all UI step sections
    for (const step of Config.PIPELINE_STEPS) {
      this.updateStepBadge(step, '');
      this.setStepEnabled(step, false);
      this.setStepButtonsEnabled(step, false);
    }

    // Reset results
    this.analysis?.setGenerated({});
    this.inferenceExecutor.clearResults();
    this.disableAllResultTabs();
    this.resetStageVisibility();

    const resultsSection = document.getElementById('resultsSection');
    if (resultsSection) {
      resultsSection.classList.add('hidden');
      resultsSection.classList.add('collapsed');
    }

    this.resetAbortControls();
  }

  resetStatusDisplay() {
    this.setStatusError(false);
    this.progress.reset('Ready');
  }

  setStatusError(isError) {
    document.getElementById('statusText')?.classList?.toggle('error', Boolean(isError));
  }

  resetProcessingInputs() {
    const thresholdInput = document.getElementById('thresholdInput');
    if (thresholdInput) thresholdInput.value = String(Config.INFERENCE_DEFAULTS.probabilityThreshold);

    const minSizeInput = document.getElementById('minSizeInput');
    if (minSizeInput) minSizeInput.value = String(Config.INFERENCE_DEFAULTS.minComponentSize);

    const ttaToggle = document.getElementById('ttaToggle');
    if (ttaToggle) ttaToggle.checked = Config.INFERENCE_DEFAULTS.testTimeAugmentation;

    this.applyTaskInferenceDefaults();
  }

  // FreeBrowse keeps the user's layout, zoom and window across inputs; only
  // SCT's own viewer buttons are reset here.
  resetViewerControls() {
    this.setViewerControlsEnabled(this.isViewerAvailable());
    this.syncViewerModeControls();
  }

  async onStepComplete(step) {
    const status = this.inferenceExecutor.getStepStatus(step);
    this.updateStepBadge(step, status);
    this.setStepButtonsEnabled(step, true);
    this.resetAbortControls();

    if (this.currentRunningStep === step) {
      this.currentRunningStep = null;
      this.abortUICheckpoint = null;
    }

    this.setStatusError(false);
    if (step === 'load') this.progress.reset('Ready');
    else this.progress.end('Complete');

    // Enable next step section
    switch (step) {
      case 'load':
        this.setStepEnabled('inference', true);
        this.setStepButtonsEnabled('inference', true);
        this.updateTaskDetails();
        break;
      case 'inference':
        break;
    }
    this.manualEdits?.sync();

    // Load stage data into viewer for preprocessing steps
    // (stageData is already handled in handleStageData)
  }

  onVolumeInfo(info) {
    void info;
  }

  updateStepBadge(step, status) {
    const badgeMap = {
      'load': null,
      'inference': 'stepInferenceBadge'
    };
    // Load step doesn't have a visible badge
    if (step === 'load') return;

    const badge = document.getElementById(badgeMap[step]);
    if (!badge) return;

    badge.className = 'step-badge';
    badge.textContent = '';

    switch (status) {
      case 'running':
        badge.classList.add('badge-running');
        badge.textContent = 'Running';
        break;
      case 'complete':
        badge.classList.add('badge-complete');
        badge.textContent = 'Done';
        break;
      case 'skipped':
        badge.classList.add('badge-skipped');
        badge.textContent = 'Skipped';
        break;
      case 'pending':
        badge.classList.add('badge-pending');
        badge.textContent = 'Pending';
        break;
    }
  }

  setStepEnabled(step, enabled) {
    const sectionId = this.getStepSectionId(step);
    if (!sectionId) return;

    const section = document.getElementById(sectionId);
    if (!section) return;

    if (enabled) {
      section.classList.remove('step-disabled');
    } else {
      section.classList.add('step-disabled');
    }
  }

  setStepButtonsEnabled(step, enabled) {
    const buttons = this.getStepButtonIds(step);
    if (!buttons) return;

    for (const id of buttons) {
      const btn = document.getElementById(id);
      if (btn) btn.disabled = !enabled;
    }
  }

  // ==================== Results ====================

  async handleStageData(data) {
    if (data.stage === 'segmentation' || data.stage === 'lesion') this.syncAnalysisMasks();
    const resultsSection = document.getElementById('resultsSection');
    if (resultsSection) {
      resultsSection.classList.remove('hidden');
      resultsSection.classList.remove('collapsed');
    }

    if (data.kind !== 'metrics') this.notifyStageDataChanged(data.stage, 'model');

    if (this.isOverlayStage(data.stage)) {
      this.setStageVisible(data.stage, this.getDefaultStageVisibility()[data.stage] !== false);
      this.setStageVisible('input', true);
      if (!this.isViewerAvailable() && this.fallbackPreview?.isSupported?.()) {
        this.currentResultTab = data.stage;
      }
      await this.renderViewerVolumes();
    } else if (data.kind === 'metrics') {
      this.renderMetricsResult(data.stage);
    } else {
      const result = this.inferenceExecutor.getResult(data.stage);
      if (result?.file) {
        this.currentResultTab = data.stage;
        this.setStageVisible('input', true);
        await this.renderViewerVolumes();
      }
    }

    this.rebuildResultsList();
  }

  isMetricsResultStage(stage) {
    return this.inferenceExecutor.getResult(stage)?.kind === 'metrics';
  }

  getResultListStages() {
    return this.inferenceExecutor.getStageOrder().filter(stage => !this.isMetricsResultStage(stage));
  }

  rebuildResultsList() {
    const container = document.getElementById('stageButtons');
    if (!container) return;
    container.innerHTML = '';

    const stages = this.getResultListStages();
    const dlSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
    const viewSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';

    // Build viewable image rows with uniform layout: eye icon + label + download button.
    // Statistics stages render in the metrics panel instead of this layer list.
    const allStages = this.inputFile
      ? ['input', ...stages.filter(stage => stage !== 'input')]
      : [...stages];

    for (const stage of allStages) {
      const row = document.createElement('div');
      row.className = 'volume-toggle';

      const viewBtn = document.createElement('button');
      viewBtn.className = 'view-btn';
      viewBtn.title = this.isImagePreviewAvailable()
        ? `View ${Config.STAGE_NAMES[stage] || stage}`
        : 'Image preview unavailable';
      viewBtn.innerHTML = viewSvg;
      viewBtn.dataset.stage = stage;
      viewBtn.disabled = !this.isImagePreviewAvailable();

      if (this.isOverlayStage(stage)) {
        viewBtn.classList.toggle('active', this.isViewerAvailable()
          ? this.isStageVisible(stage)
          : this.currentResultTab === stage);
        viewBtn.addEventListener('click', () => {
          if (this.isViewerAvailable()) {
            void this.toggleStageVisibility(stage, !this.isStageVisible(stage));
          } else {
            void this.viewStage(stage);
          }
        });
      } else {
        // Initialize active state based on what's currently displayed
        viewBtn.classList.toggle('active', this.currentResultTab === stage && this.isStageVisible('input'));
        // Base volume stages: toggle load/unload as base volume
        viewBtn.addEventListener('click', () => {
          if (this.isViewerAvailable() && this.currentResultTab === stage && this.isStageVisible('input')) {
            // Already showing this stage — hide it
            void this.toggleInputVisibility(false);
            viewBtn.classList.remove('active');
          } else {
            void this.viewStage(stage);
          }
        });
      }
      row.appendChild(viewBtn);

      const label = document.createElement('span');
      label.className = 'stage-label';
      const result = stage === 'input' ? null : this.inferenceExecutor.getResult(stage);
      label.textContent = Config.STAGE_NAMES[stage] || stage;
      const manualEdit = result?.manualEdit;
      if (manualEdit) {
        label.textContent += manualEdit.kind === 'new' ? ' (drawn)' : ' (edited)';
        label.title = manualEdit.kind === 'new' ? 'Drawn by hand' : 'Manually edited';
        row.dataset.manualEdit = manualEdit.kind;
      }
      row.appendChild(label);

      // Edit opens the shared mask editor on this result (app/manual-edits.js).
      if (this.manualEdits?.canEdit(stage)) {
        const editBtn = document.createElement('button');
        editBtn.className = 'nd-edit-btn';
        editBtn.type = 'button';
        editBtn.title = 'Edit in the viewer';
        editBtn.textContent = 'Edit';
        editBtn.disabled = !this.manualEdits.canStart();
        editBtn.addEventListener('click', () => void this.manualEdits.start(stage));
        row.appendChild(editBtn);
      }

      // Download button (not for input — user already has the file)
      if (stage !== 'input') {
        const dlBtn = document.createElement('button');
        dlBtn.className = 'download-btn';
        dlBtn.title = `Download ${Config.STAGE_NAMES[stage] || stage}`;
        dlBtn.innerHTML = dlSvg;
        dlBtn.addEventListener('click', () => this.downloadStage(stage));
        row.appendChild(dlBtn);
      }

      container.appendChild(row);
    }
  }

  downloadStage(stage) {
    const result = this.inferenceExecutor.getResult(stage);
    if (!this.inferenceExecutor.downloadStage(stage)) return false;
    if (result?.manualEdit) {
      result.manualEdit.downloaded = true;
      this.logAnalysis(`Downloaded ${result.manualEdit.kind === 'new' ? 'hand-drawn' : 'manually edited'} mask: ${result.file.name}`);
    }
    return true;
  }

  // ==================== SCT analysis ====================

  // The active image's masks, as SCT analysis offers them. Only whole-cord
  // segmentations are valid cord masks; the producing task is the result's
  // own, so a parked image keeps its choices.
  syncAnalysisMasks() {
    const generated = {};
    const cord = this.inferenceExecutor.getResult('segmentation');
    const lesion = this.inferenceExecutor.getResult('lesion')?.file;
    if (cord?.file && ['spinalcord', 'lesion_sci_t2'].includes(cord.raw?.taskId)) generated.cord = cord.file;
    if (lesion) generated.lesion = lesion;
    this.analysis?.setGenerated(generated);
  }

  downloadMetricsResult(stage) {
    const result = this.inferenceExecutor.getResult(stage);
    if (result?.kind !== 'metrics') {
      this.logAnalysis(`${stage} statistics not available`, 'warning');
      return;
    }

    const csv = result.csv || '';
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const filename = result.file?.name || `${stage}.csv`;
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    this.logAnalysis(`Downloaded statistics: ${filename}`);
  }

  formatMetric(value) {
    if (value === null || value === undefined || value === '') return '';
    if (!Number.isFinite(Number(value))) return String(value);
    const number = Number(value);
    return Number.isInteger(number) ? String(number) : number.toFixed(3).replace(/\.?0+$/, '');
  }

  // Removes one metrics block, or all of them when no stage is given.
  clearMetricsResult(stage = null) {
    const panel = document.getElementById('metricsResults');
    if (!panel) return;
    if (stage) {
      panel.querySelector(`[data-metrics-stage="${stage}"]`)?.remove();
    } else {
      panel.innerHTML = '';
    }
    panel.classList.toggle('hidden', panel.children.length === 0);
  }

  renderAllMetricsResults() {
    this.clearMetricsResult();
    for (const stage of this.inferenceExecutor.getStageOrder()) {
      if (this.isMetricsResultStage(stage)) this.renderMetricsResult(stage);
    }
  }

  describeLesionMetrics(result) {
    const summary = result.summary || {};
    // Damage ratio and tissue bridges need a cord mask; lesion-only tasks
    // (lesion_ms) produce none, so their table keeps the lesion geometry.
    const hasCord = this.inferenceExecutor.hasResult('segmentation');
    return {
      summary: [
        ['Lesions', summary.lesion_count],
        ['Volume mm3', summary.total_volume_mm3],
        ['Length mm', summary.total_length_mm],
        ['Max width mm', summary.max_width_mm]
      ],
      columns: [
        ['lesion_id', 'Lesion'],
        ['volume_mm3', 'Volume mm3'],
        ['length_mm', 'Length mm'],
        ['max_width_mm', 'Width mm'],
        ['max_axial_damage_ratio', 'Damage'],
        ['dorsal_bridge_width_mm', 'Dorsal mm'],
        ['ventral_bridge_width_mm', 'Ventral mm'],
        ['total_bridge_width_mm', 'Bridge mm']
      ].filter(([column]) => hasCord || !/damage|bridge/.test(column))
    };
  }

  renderMetricsResult(stage) {
    const panel = document.getElementById('metricsResults');
    const result = this.inferenceExecutor.getResult(stage);
    if (!panel || result?.kind !== 'metrics') {
      this.clearMetricsResult(stage);
      return;
    }

    const view = this.describeLesionMetrics(result);
    const rows = Array.isArray(result.rows) ? result.rows : [];
    const title = Config.STAGE_NAMES[stage] || 'Statistics';

    const block = document.createElement('div');
    block.className = 'metrics-block';
    block.dataset.metricsStage = stage;

    const dlSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
    const header = document.createElement('div');
    header.className = 'metrics-header';
    const titleEl = document.createElement('span');
    titleEl.className = 'metrics-title';
    titleEl.textContent = title;
    header.appendChild(titleEl);
    const downloadBtn = document.createElement('button');
    downloadBtn.className = 'metrics-download-btn';
    downloadBtn.type = 'button';
    downloadBtn.title = `Download ${title} CSV`;
    downloadBtn.setAttribute('aria-label', `Download ${title} CSV`);
    downloadBtn.innerHTML = `${dlSvg}<span>CSV</span>`;
    downloadBtn.addEventListener('click', () => this.downloadMetricsResult(stage));
    header.appendChild(downloadBtn);
    block.appendChild(header);

    if (view.note) {
      const note = document.createElement('p');
      note.className = 'step-description metrics-note';
      note.textContent = view.note;
      block.appendChild(note);
    }

    const summaryGrid = document.createElement('div');
    summaryGrid.className = 'metrics-summary';
    view.summary.forEach(([label, value]) => {
      const item = document.createElement('div');
      item.className = 'metrics-summary-item';
      const labelEl = document.createElement('span');
      labelEl.className = 'metrics-summary-label';
      labelEl.textContent = label;
      const valueEl = document.createElement('span');
      valueEl.className = 'metrics-summary-value';
      valueEl.textContent = this.formatMetric(value);
      item.appendChild(labelEl);
      item.appendChild(valueEl);
      summaryGrid.appendChild(item);
    });
    block.appendChild(summaryGrid);

    const wrapper = document.createElement('div');
    wrapper.className = 'metrics-table-wrapper';
    wrapper.tabIndex = 0;
    wrapper.setAttribute('role', 'region');
    wrapper.setAttribute('aria-label', `${title} table`);
    const table = document.createElement('table');
    table.className = 'metrics-table';
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const [, label] of view.columns) {
      const th = document.createElement('th');
      th.textContent = label;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const row of rows) {
      const tr = document.createElement('tr');
      for (const [column] of view.columns) {
        const td = document.createElement('td');
        td.textContent = this.formatMetric(row[column]);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrapper.appendChild(table);
    block.appendChild(wrapper);

    const existing = panel.querySelector(`[data-metrics-stage="${stage}"]`);
    if (existing) existing.replaceWith(block);
    else panel.appendChild(block);
    panel.classList.remove('hidden');
  }

  // ==================== Stage data ====================

  /**
   * Subscribe to "stage data changed": `listener({ stage, file, source,
   * previousFile, result })` runs whenever a result mask is produced or
   * replaced. `source` is `model` (inference output), `edit` (a manual edit
   * was applied) or `restore` (back to the model's mask, or a drawn mask
   * removed, when `file` is null). Returns the unsubscribe function.
   */
  onStageDataChanged(listener) {
    const handler = event => listener(event.detail);
    this.stageEvents.addEventListener('stagedatachanged', handler);
    return () => this.stageEvents.removeEventListener('stagedatachanged', handler);
  }

  notifyStageDataChanged(stage, source, previousFile = null) {
    const result = this.inferenceExecutor.getResult(stage);
    this.stageEvents.dispatchEvent(new CustomEvent('stagedatachanged', {
      detail: { stage, source, file: result?.file || null, previousFile, result }
    }));
  }

  /**
   * The one way to replace a stage's mask outside inference. `file` is a
   * NIfTI on the input's grid. `manualEdit` (provenance) is kept on the
   * result; null clears it. Updates the viewer, the Results list and every
   * subscriber of onStageDataChanged().
   */
  async setStageData(stage, file, { source = 'edit', manualEdit, labelSetId = null } = {}) {
    const executor = this.inferenceExecutor;
    const previous = executor.getResult(stage);
    const taskId = previous?.raw?.taskId || this.selectedTask?.id || DEFAULT_TASK_ID;
    executor.results[stage] = {
      ...(previous || { kind: 'nifti', description: 'Manual mask', provenance: null }),
      file,
      raw: { ...(previous?.raw || {}), stage, taskId, kind: 'nifti' },
      manualEdit: manualEdit === undefined ? previous?.manualEdit || null : manualEdit,
      labelSetId: labelSetId || previous?.labelSetId || null
    };
    if (!executor.stageOrder.includes(stage)) executor.stageOrder.push(stage);
    this.showResultsSection();
    this.notifyStageDataChanged(stage, source, previous?.file || null);
    await this.renderViewerVolumes();
    this.rebuildResultsList();
  }

  async removeStageData(stage, { source = 'restore' } = {}) {
    const previous = this.inferenceExecutor.getResult(stage);
    if (!previous) return;
    this.inferenceExecutor.removeResult(stage);
    this.notifyStageDataChanged(stage, source, previous.file || null);
    await this.renderViewerVolumes();
    this.rebuildResultsList();
  }

  showResultsSection() {
    const resultsSection = document.getElementById('resultsSection');
    if (!resultsSection) return;
    resultsSection.classList.remove('hidden');
    resultsSection.classList.remove('collapsed');
  }

  // Keeps everything derived from a mask in step with it. Inference output
  // arrives with its metrics; an edited lesion or cord mask makes the
  // automatic lesion metrics stale, so they are dropped and SCT analysis
  // (which offers the edited masks) measures the edit.
  onStageMaskChanged({ stage, source }) {
    this.manualEdits?.sync();
    if (stage === 'segmentation' || stage === 'lesion') this.syncAnalysisMasks();
    if (source === 'model') return;
    if ((stage === 'segmentation' || stage === 'lesion') && this.inferenceExecutor.getResult('lesion_metrics')) {
      this.inferenceExecutor.removeResult('lesion_metrics');
      this.clearMetricsResult('lesion_metrics');
      this.logAnalysis(`${Config.STAGE_NAMES.lesion_metrics} removed: they described the model's ${Config.STAGE_NAMES[stage] || stage}. Run SCT analysis on the edited mask.`, 'warning');
    }
  }

  async viewStage(stage) {
    if (this.isCompareMode() && stage !== 'input') {
      await this.setViewerMode('single');
    }

    const result = stage === 'input' ? null : this.inferenceExecutor.getResult(stage);
    if (result?.kind === 'metrics') {
      this.renderMetricsResult(stage);
      this.syncResultViewButtons();
      return;
    }

    const file = stage === 'input'
      ? this.inputFile
      : result?.file;
    if (!file) return;

    this.currentResultTab = stage;
    this.setStageVisible('input', true);

    await this.renderViewerVolumes();

    const container = document.getElementById('stageButtons');
    if (container) {
      container.querySelectorAll('.view-btn').forEach(btn => {
        const btnStage = btn.dataset.stage;
        if (this.isOverlayStage(btnStage)) {
          btn.classList.toggle('active', this.isStageVisible(btnStage));
        } else {
          btn.classList.toggle('active', btnStage === stage && this.isStageVisible('input'));
        }
      });
    }
  }

  getCurrentBaseFile() {
    if (this.currentResultTab === 'input') return this.inputFile;
    if (this.isOverlayStage(this.currentResultTab)) return this.inputFile;
    const result = this.inferenceExecutor.getResult(this.currentResultTab);
    if (result?.kind === 'metrics') return this.inputFile;
    return result?.file || this.inputFile;
  }

  getFallbackPreviewFile() {
    if (this.currentResultTab === 'input') return this.inputFile;
    const result = this.inferenceExecutor.getResult(this.currentResultTab);
    if (result?.kind === 'metrics') return this.inputFile;
    return result?.file || this.inputFile;
  }

  isOverlayStage(stage) {
    return stage === 'segmentation' || stage === 'lesion' || stage === 'spine_step1' || stage === 'spine_discs';
  }

  getOverlayColormapId(stage, taskId = this.selectedTask?.id, labelSetId = this.inferenceExecutor?.getResult(stage)?.labelSetId) {
    if (labelSetId) return `sct-${labelSetId}`;
    if (stage === 'lesion') return 'sct-lesion';
    if (stage === 'spine_step1') return 'sct-totalspineseg';
    if (stage === 'spine_discs') return 'sct-spine-discs';
    if (stage === 'segmentation' && taskId === 'lesion_sci_t2') return 'sct-spinalcord';
    return `sct-${taskId || DEFAULT_TASK_ID}`;
  }

  getDefaultStageVisibility() {
    return {
      input: true,
      segmentation: true,
      lesion: true,
      spine_step1: true,
      spine_discs: true
    };
  }

  resetStageVisibility() {
    this._stageVisibility = this.getDefaultStageVisibility();
    this._inputVisible = this._stageVisibility.input;
  }

  isStageVisible(stage) {
    if (stage === 'input') return this._inputVisible;
    return this._stageVisibility?.[stage] ?? true;
  }

  setStageVisible(stage, visible) {
    if (!this._stageVisibility) this.resetStageVisibility();
    this._stageVisibility[stage] = visible;
    if (stage === 'input') this._inputVisible = visible;
  }

  getVisibleOverlayStages() {
    return ['segmentation', 'lesion', 'spine_step1', 'spine_discs'].filter(stage => (
      this.isStageVisible(stage) && this.inferenceExecutor.hasResult(stage)
    ));
  }

  getOverlayStagesWithResults() {
    return ['segmentation', 'lesion', 'spine_step1', 'spine_discs'].filter(stage => (
      this.inferenceExecutor.hasResult(stage)
    ));
  }

  // The requested viewer stack, bottom to top: the base image, then every
  // label-mask stage of the current run. Visibility is a property of an entry
  // (NiiVue opacity), not of membership, so an eye toggle never reloads a
  // volume. This and renderViewerVolumes() are the only place that decides
  // which volumes the main viewer shows.
  getViewerStack() {
    const baseFile = this.getCurrentBaseFile();
    if (!baseFile) return [];

    const stackEntries = [{
      file: baseFile,
      stage: this.currentResultTab && !this.isOverlayStage(this.currentResultTab) ? this.currentResultTab : 'input',
      visible: this.isStageVisible('input')
    }];
    for (const overlayStage of this.getOverlayStagesWithResults()) {
      const result = this.inferenceExecutor.getResult(overlayStage);
      const taskId = result?.raw?.taskId;
      stackEntries.push({
        file: result?.file,
        stage: overlayStage,
        // While a stage's mask is on the drawing layer its overlay is hidden.
        visible: this.isStageVisible(overlayStage) && !this.manualEdits?.isHiding(overlayStage),
        colormapKey: this.getOverlayColormapId(overlayStage, taskId),
        labelColormap: generateLabelColormap(this.getOverlayLabelTaskId(overlayStage, taskId))
      });
    }
    return stackEntries.filter(entry => entry.file);
  }

  // Single and Compare share one queue, so a mode switch never interleaves
  // with a result update.
  async renderViewerVolumes() {
    await this.viewerReady;
    if (!this.isViewerAvailable()) return this.renderFallbackPreview();
    this._renderViewerRequested = true;
    this._renderViewerPromise = this._renderViewerPromise.then(async () => {
      if (!this._renderViewerRequested) return;
      this._renderViewerRequested = false;
      if (this.isCompareMode()) {
        await this.renderComparisonView();
        return;
      }
      this.viewer.clearComparison(document.getElementById('comparisonGrid'));
      await this._renderViewerVolumesNow();
    }).catch(error => this.updateOutput(`Viewer update failed: ${error.message}`, 'error'));
    return this._renderViewerPromise;
  }

  async renderFallbackPreview(file = this.getFallbackPreviewFile(), { stage = this.currentResultTab || 'input' } = {}) {
    if (!this.fallbackPreview?.isSupported?.() || !file) return false;
    const stageName = Config.STAGE_NAMES[stage] || (stage === 'input' ? 'Input' : stage);
    const rendered = await this.fallbackPreview.renderFile(file, {
      stageName,
      reason: this.viewerUnavailableReason
    });
    if (rendered) {
      this.updateViewerInfo({ string: `${stageName}: 2D preview` });
    }
    return rendered;
  }

  async _renderViewerVolumesNow() {
    await this.viewer.showVolumes(this.getViewerStack());
  }

  // FreeBrowse's own eye, opacity slider and delete button change a stage's
  // visibility without going through the Results list; keep the two in step.
  onViewerStageVisibility(stage, visible) {
    // The stage on the drawing layer is hidden by the editor, not the user.
    if (this.manualEdits?.isHiding(stage)) return;
    const shownStage = this.isOverlayStage(stage) ? stage : 'input';
    if (this.isStageVisible(shownStage) === visible) return;
    this.setStageVisible(shownStage, visible);
    this.syncResultViewButtons();
    this.updateViewerInfo(this._lastLocationData);
  }

  syncResultViewButtons() {
    const container = document.getElementById('stageButtons');
    if (!container) return;

    container.querySelectorAll('.view-btn').forEach(btn => {
      const stage = btn.dataset.stage;
      if (this.isViewerAvailable() && this.isOverlayStage(stage)) {
        btn.classList.toggle('active', this.isStageVisible(stage));
      } else {
        btn.classList.toggle('active', stage === this.currentResultTab && this.isStageVisible('input'));
      }
    });
  }

  // In Compare, a Results eye applies to that stage in every panel, so the
  // images are compared like with like.
  async toggleInputVisibility(visible) {
    this.setStageVisible('input', visible);
    if (!this.isViewerAvailable()) return;
    await this.renderViewerVolumes();
    this.rebuildResultsList();
    if (!this.isCompareMode()) this.updateViewerInfo(this._lastLocationData);
  }

  async toggleStageVisibility(stage, visible) {
    this.setStageVisible(stage, visible);
    if (!this.isViewerAvailable()) {
      this.syncResultViewButtons();
      return;
    }
    await this.renderViewerVolumes();
    this.syncResultViewButtons();
    if (!this.isCompareMode()) this.updateViewerInfo(this._lastLocationData);
  }

  onWorkerInitialized() {}

  async onInferenceComplete() {
    this.currentRunningStep = null;
    this.abortUICheckpoint = null;
    this.setStatusError(false);
    this.progress.end('Complete');

    if (this.isViewerAvailable() && this.getVisibleOverlayStages().length > 0) {
      await this.renderViewerVolumes();
      this.rebuildResultsList();
    }
  }

  onInferenceError(msg) {
    this.currentRunningStep = null;
    this.abortUICheckpoint = null;
    this.progress.end(msg ? `Error: ${msg}` : 'Error', { success: false });
    this.setStatusError(true);

    // Reset any running badges back
    for (const step of Config.PIPELINE_STEPS) {
      const status = this.inferenceExecutor.getStepStatus(step);
      if (status === 'running') {
        this.updateStepBadge(step, 'pending');
        this.setStepButtonsEnabled(step, true);
      }
    }
  }

  disableAllResultTabs() {
    const container = document.getElementById('stageButtons');
    if (container) container.innerHTML = '';
    this.clearMetricsResult();
    this.resetStageVisibility();
  }

  async clearResults() {
    await this.manualEdits?.reset();
    this.analysis?.setGenerated({});
    this.inferenceExecutor.clearResults();
    this.disableAllResultTabs();
    this.currentResultTab = 'input';
    this.setStageVisible('input', true);

    const resultsSection = document.getElementById('resultsSection');
    if (resultsSection) {
      resultsSection.classList.add('hidden');
      resultsSection.classList.add('collapsed');
    }

    if (this.inputFile) void this.renderViewerVolumes();

    this.updateViewerInfo(this._lastLocationData);
  }

  // ==================== UI Helpers ====================

  // Technical log: model fetch, backend, tensor shapes, timings, viewer and worker lifecycle.
  updateOutput(msg, level) {
    this.writeLog(TECHNICAL, msg, level);
  }

  // Analysis log: input, task and parameters, result summaries, saved outputs, warnings.
  logAnalysis(msg, level) {
    this.writeLog(ANALYSIS, msg, level);
  }

  writeLog(channel, msg, level = 'info') {
    console.log(msg);
    this.log?.log(msg, level, channel);
  }

  // Worker progress. The shared executor also reports its terminal states
  // through here ('Failed' before onError, 'Cancelled', 'Ready' after an
  // abort restore); those are owned by onInferenceError / the abort path.
  setProgress(value, text) {
    if (text === 'Failed' || text === 'Ready') return;
    if (text === 'Cancelled') {
      this.setStatusError(false);
      this.progress.reset('Cancelled');
      this.currentRunningStep = null;
      return;
    }
    let label = null;
    if (value >= 1) label = 'Complete';
    else if (text) label = text;
    else if (value > 0) label = 'Processing...';
    this.progress.setProgress(value, label);
  }

  clearFiles() {
    this.fileIOController.clearFiles();
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.app = new SpinalCordToolboxApp();
});
