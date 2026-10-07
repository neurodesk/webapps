/**
 * Manual mask edits with the shared `nd-mask-editor` on FreeBrowse's NiiVue.
 *
 * A result row's Edit button opens the shared editor's toolbar row under the
 * viewer toolbar (Draw, Erase, Fill, Label, Brush, Undo, Apply, Cancel); the
 * editor and its drawing adapter own the session and the voxel round trip.
 * This controller adds what SCT needs around it:
 *
 * - Apply goes through `app.setStageData()`, the one place a stage's mask
 *   changes, so the viewer, Results, Compare panels and SCT analysis's mask
 *   choices follow. The edited file is `<model output>_edited.nii[.gz]` and
 *   the result carries its provenance (`manualEdit`).
 * - FreeBrowse's own Drawing tab and Edit as drawing are locked for the
 *   session; if a drawing layer is opened or closed by anything but the
 *   editor anyway, the session is cancelled rather than shared.
 * - Unsaved edits (a drawing with strokes, or an applied edit that was not
 *   downloaded) are confirmed before an action drops them.
 * - Before the active image changes, a drawing with strokes is applied to its
 *   own image and an untouched one is closed.
 */
import { createMaskEditor } from '@neurodesk/webapp-components/ui';
import { decodeNiftiBuffer, readNiftiImageData } from '@neurodesk/webapp-components/file-io';
import { generateLabelColormap } from './labels.js';
import { getTaskLabels } from './sct-tasks.js';
import { STAGE_NAMES } from './config.js';

export const EDITABLE_STAGES = Object.freeze(['segmentation', 'lesion', 'spine_step1', 'spine_discs']);

const IDLE = Object.freeze({ state: 'idle' });

const stageName = stage => STAGE_NAMES[stage] || stage;

/** `spinalcord_segmentation.nii` -> `spinalcord_segmentation_edited.nii`; `.nii.gz` stays gzipped. */
export function editedFileName(name) {
  const text = String(name || 'mask.nii');
  const extension = /\.nii\.gz$/i.test(text) ? '.nii.gz' : '.nii';
  const base = text.replace(/(_edited)?\.nii(\.gz)?$/i, '');
  return `${base}_edited${extension}`;
}

/** Label values of a mask file in its own voxel order, rounded as the editor paints them. */
export async function readMaskLabels(file) {
  const buffer = await decodeNiftiBuffer(await file.arrayBuffer());
  const { data } = readNiftiImageData(buffer, Float64Array);
  return Uint8Array.from(data, value => Math.min(255, Math.max(0, Math.round(value))) || 0);
}

/** Voxels whose label differs between two masks on one grid. */
export function countChanged(a, b) {
  if (a.length !== b.length) throw new Error(`The edited mask has ${b.length} voxels; the result has ${a.length}.`);
  let changed = 0;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) changed += 1;
  return changed;
}

/** Labelled voxel count per label value, label 0 excluded. */
export function labelCounts(mask) {
  const counts = new Map();
  for (const value of mask) if (value) counts.set(value, (counts.get(value) || 0) + 1);
  return counts;
}

/** `{ value: name }` for the Label select of a stage's label set. */
export function labelNames(labelSetId) {
  const names = {};
  for (const label of getTaskLabels(labelSetId)) {
    if (label.index > 0 && label.index < 256) names[label.index] = label.name;
  }
  return names;
}

export class SctManualEdits {
  constructor(app) {
    this.app = app;
    this.editor = null;
    this.viewer = null;
    // The stage whose session is open, from Edit until the editor is idle.
    this.stage = null;
    // The stage whose overlay the viewer hides because the drawing shows it.
    this.hiddenStage = null;
    this.strokes = 0;
    this.switching = null;
  }

  /** Puts the shared editor's toolbar row under the viewer toolbar, on FreeBrowse's NiiVue. */
  attachViewer(viewer, { toolbar = document.querySelector('main.app-main > .viewer-toolbar') } = {}) {
    if (!viewer?.nv || this.editor) return;
    this.viewer = viewer;
    const editor = createMaskEditor({ nv: viewer.nv });
    editor.addEventListener('nd-mask-edit-start', ({ detail }) => {
      this.app.setStatusError?.(false);
      this.app.progress?.reset(detail.message);
    });
    editor.addEventListener('nd-mask-edit-end', () => void this.ended());
    toolbar?.after(editor);
    viewer.nv.addEventListener('drawingChanged', event => this.onDrawingChanged(event.detail || {}));
    this.editor = editor;
    this.sync();
  }

  get session() {
    return this.editor?.session ?? IDLE;
  }

  get editingStage() {
    return this.stage;
  }

  isEditing() {
    return this.stage !== null || this.session.state !== 'idle';
  }

  /** True while `stage`'s overlay must stay hidden: its mask is on the drawing layer. */
  isHiding(stage) {
    return Boolean(stage) && stage === this.hiddenStage;
  }

  /** True once the drawing has seen a stroke; Undo does not count back. */
  isDirty() {
    return this.session.state === 'editing' && this.strokes > 0;
  }

  /** `stage` has a mask the editor can open. */
  canEdit(stage) {
    return Boolean(this.editor) && EDITABLE_STAGES.includes(stage) && Boolean(this.app.inferenceExecutor.getResult(stage)?.file);
  }

  /** Edit buttons are live: no session open, no run, a viewer to draw in. */
  canStart() {
    const app = this.app;
    return Boolean(this.editor && app.isViewerAvailable?.())
      && !this.isEditing()
      && !app.currentRunningStep
      && !app.inferenceExecutor?.isRunning?.();
  }

  sync() {
    const enabled = this.canStart();
    for (const button of document.querySelectorAll('#stageButtons .nd-edit-btn')) button.disabled = !enabled;
  }

  // ==================== Session ====================

  async start(stage) {
    const app = this.app;
    const result = app.inferenceExecutor.getResult(stage);
    if (!this.canEdit(stage) || !this.canStart()) return false;
    this.stage = stage;
    this.hiddenStage = stage;
    this.strokes = 0;
    this.lockFreeBrowse(true);
    this.sync();
    try {
      // The drawing takes the input's grid, so the input is the base image.
      if (app.isCompareMode()) await app.setViewerMode('single');
      app.currentResultTab = 'input';
      app.setStageVisible('input', true);
      app.setStageVisible(stage, true);
      await app.renderViewerVolumes();
      app.syncResultViewButtons();
      if (app.inferenceExecutor.getResult(stage) !== result || this.stage !== stage) {
        await this.ended();
        return false;
      }
      const labelSetId = app.getOverlayLabelTaskId(stage);
      this.editor.configure({
        nv: app.nv,
        labelNames: labelNames(labelSetId),
        onApply: (edited, file, { original }) => this.commit(edited, file, original),
        onCancel: cancelled => this.cancelled(cancelled),
        onError: (_stage, error) => this.report(error),
      });
      const started = await this.editor.start({
        stage,
        file: result.file,
        label: stageName(stage),
        colormap: generateLabelColormap(labelSetId),
      });
      if (!started) return false;
      app.logAnalysis(`Manual edit: editing ${stageName(stage)} (${result.file.name})`);
      return true;
    } catch (error) {
      this.report(error);
      await this.ended();
      return false;
    }
  }

  // The editor calls this from Apply: `file` is the drawing on `original`'s grid.
  async commit(stage, file, original) {
    const app = this.app;
    const previous = app.inferenceExecutor.getResult(stage);
    this.hiddenStage = null;
    const before = await readMaskLabels(original);
    const after = await readMaskLabels(file);
    const changed = countChanged(before, after);
    if (changed === 0) {
      app.logAnalysis(`Manual edit: no voxels changed in ${stageName(stage)}; the result is unchanged`);
      return;
    }
    const model = previous?.manualEdit?.original || { file: original, raw: previous?.raw ?? null };
    const name = editedFileName(model.file.name);
    const named = new File([file], name, { type: file.type || 'application/octet-stream' });
    await app.setStageData(stage, named, {
      source: 'edit',
      manualEdit: { kind: 'edited', original: model, changedVoxels: changed, downloaded: false, at: new Date().toISOString() }
    });
    const counts = [...labelCounts(after)].map(([label, count]) => `${label}: ${count}`).join(', ') || 'empty';
    app.logAnalysis(`Manual edit applied to ${stageName(stage)}: ${changed} voxels changed; voxels per label ${counts}; saved as ${name}`);
  }

  cancelled(stage) {
    this.app.logAnalysis(`Manual edit closed without changes to ${stageName(stage)}${this.strokes ? ' (strokes discarded)' : ''}`, this.strokes ? 'warning' : 'info');
  }

  report(error) {
    const message = error?.message || String(error);
    this.app.logAnalysis(`Manual edit failed: ${message}`, 'error');
    this.app.progress?.end(`Error: ${message}`, { success: false });
    this.app.setStatusError?.(true);
  }

  // The editor is idle again (applied, cancelled or failed): the overlay
  // returns, FreeBrowse's drawing controls unlock and Edit is live again.
  async ended() {
    if (this.session.state !== 'idle') return;
    const wasOpen = this.stage !== null;
    this.stage = null;
    this.hiddenStage = null;
    this.strokes = 0;
    this.lockFreeBrowse(false);
    this.sync();
    if (!wasOpen) return;
    const status = document.getElementById('statusText');
    if (!status?.classList.contains('error')) this.app.progress?.reset('Ready');
    await this.app.renderViewerVolumes();
    this.app.rebuildResultsList();
  }

  lockFreeBrowse(locked) {
    this.viewer?.handle?.setDrawingLocked?.(locked);
  }

  // Strokes make the drawing dirty. A layer opened, replaced or closed while
  // the editor is editing did not come from the editor (it only does so
  // while opening or applying): the session is cancelled, not shared.
  onDrawingChanged({ action }) {
    if (this.session.state !== 'editing') return;
    if (action === 'stroke') {
      this.strokes += 1;
      return;
    }
    if (action === 'create' || action === 'load' || action === 'close') {
      this.app.logAnalysis(`Manual edit of ${stageName(this.stage)} cancelled: another tool changed the drawing layer`, 'warning');
      void this.editor.cancel();
    }
  }

  /**
   * Before the active image changes (another image, Compare): a drawing with
   * strokes is applied to its own image's stage, an untouched one is closed.
   * Concurrent callers share one settle, so results are parked only after it.
   */
  settleBeforeSwitch() {
    if (this.switching) return this.switching;
    if (!this.isEditing()) return Promise.resolve();
    const stage = this.stage;
    const settle = this.isDirty()
      ? (this.app.logAnalysis(`Manual edit applied to ${stageName(stage)} before switching images`), this.editor.apply())
      : this.editor.cancel();
    this.switching = Promise.resolve(settle).then(() => this.ended()).finally(() => {
      this.switching = null;
    });
    return this.switching;
  }

  /** Closes an open session without keeping its drawing (new file, cleared results). */
  async reset() {
    if (!this.isEditing()) return;
    await this.editor.cancel();
    await this.ended();
  }

  // ==================== Unsaved edits ====================

  unsavedStages() {
    const stages = EDITABLE_STAGES.filter(stage => {
      const edit = this.app.inferenceExecutor.getResult(stage)?.manualEdit;
      return edit && !edit.downloaded;
    });
    if (this.isDirty() && !stages.includes(this.stage)) stages.unshift(this.stage);
    return stages;
  }

  hasUnsavedEdits() {
    return this.unsavedStages().length > 0;
  }

  /** `Stage of image` for every unsaved edit in a parked image's `snapshot`. */
  static unsavedInSnapshot(snapshot, imageName) {
    return Object.entries(snapshot?.results || {})
      .filter(([, result]) => result?.manualEdit && !result.manualEdit.downloaded)
      .map(([stage]) => `${stageName(stage)} of ${imageName}`);
  }

  /**
   * Asks before `action` drops edits that were not applied or not downloaded:
   * the active image's (unless `current` is false) and the `others` named.
   * Returns true when the action may go ahead.
   */
  confirmDiscard(action, { current = true, others = [] } = {}) {
    const stages = current ? this.unsavedStages() : [];
    if (!stages.length && !others.length) return true;
    const names = [...stages.map(stageName), ...others].join(', ');
    const ok = globalThis.confirm?.(`${action} discards your manual edits to ${names}, which you have not downloaded. Continue?`) ?? false;
    if (!ok) {
      this.app.logAnalysis(`Kept manual edits to ${names}: ${action.toLowerCase()} was cancelled`, 'warning');
      return false;
    }
    this.app.logAnalysis(`Manual edits to ${names} discarded: ${action.toLowerCase()}`, 'warning');
    return true;
  }
}
