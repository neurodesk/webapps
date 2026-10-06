/**
 * The Edit masks section: correct a result stage by hand, or draw a new mask,
 * on FreeBrowse's drawing layer, and make the result the stage's data.
 *
 * FreeBrowse's Drawing tab owns the tools (pen, erase, pen fill, undo). This
 * controller adds what it lacks: which stage to edit, which label the pen
 * paints (by name), Apply, Discard and Restore, and the guard that keeps a new
 * run or a new file from dropping unsaved edits unnoticed. Applying goes
 * through `app.setStageData()`, the one place a stage's mask changes; derived
 * results listen to `app.onStageDataChanged()`.
 */
import { createNiftiFromData, decodeNiftiBuffer, extractNiftiHeader, readNiftiImageData } from '@neurodesk/webapp-components/file-io';
import { MaskEditor, labelCounts } from '../modules/mask-editor.js';
import { generateLabelColormap } from './labels.js';
import { getTaskLabels } from './sct-tasks.js';
import { STAGE_NAMES } from './config.js';

// Stages a mask can be drawn for from nothing, and the label set it uses.
export const NEW_MASKS = Object.freeze([
  { stage: 'segmentation', labelSetId: 'spinalcord', name: 'New spinal cord mask' },
  { stage: 'lesion', labelSetId: 'lesion', name: 'New lesion mask' }
]);

const EDITABLE_STAGES = ['segmentation', 'lesion', 'spine_step1', 'spine_discs'];

/** `spinalcord_segmentation.nii` -> `spinalcord_segmentation_edited.nii`. */
export function editedFileName(name) {
  const base = String(name || 'mask.nii').replace(/(_edited)?\.nii(\.gz)?$/i, '');
  return `${base}_edited.nii`;
}

/**
 * A mask NIfTI with `template`'s header (the stage's own file, or the input),
 * uint8 voxels and `cal_max` set to the largest label, as the worker writes
 * model output. Unchanged voxels give back the model's file byte for byte.
 */
export function buildMaskNifti(native, template) {
  const header = extractNiftiHeader(template);
  const view = new DataView(header);
  const dims = [view.getInt16(42, true), view.getInt16(44, true), view.getInt16(46, true)];
  return createNiftiFromData(native, header, { dims });
}

export async function readMaskVoxels(file) {
  const buffer = await decodeNiftiBuffer(await file.arrayBuffer());
  return { buffer, voxels: readNiftiImageData(buffer, Uint8Array).data };
}

export class SctManualEdits {
  constructor(app) {
    this.app = app;
    this.editor = null;
    this.section = document.getElementById('editSection');
    this.stageSelect = document.getElementById('editStageSelect');
    this.labelSelect = document.getElementById('editLabelSelect');
    this.buttons = {
      start: document.getElementById('editStart'),
      apply: document.getElementById('editApply'),
      discard: document.getElementById('editDiscard'),
      revert: document.getElementById('editRevert')
    };
    this.stageSelect?.addEventListener('change', () => this.sync());
    this.labelSelect?.addEventListener('change', () => this.editor?.setLabel(Number(this.labelSelect.value)));
    this.buttons.start?.addEventListener('click', () => void this.start());
    this.buttons.apply?.addEventListener('click', () => void this.apply());
    this.buttons.discard?.addEventListener('click', () => this.discard());
    this.buttons.revert?.addEventListener('click', () => this.revert());
  }

  attachViewer(viewer) {
    if (!viewer?.nv) return;
    this.editor = new MaskEditor({
      nv: viewer.nv,
      showDrawingTools: () => viewer.handle?.showDrawingTools?.() ?? false,
      setPenField: value => viewer.handle?.setDrawingPenValue?.(value) ?? false,
      onAdopt: request => this.adopt(request),
      onAdopted: () => this.adopted(),
      onClosedByViewer: (native, stage) => void this.closedByViewer(native, stage),
      onPenValue: value => this.showLabel(value)
    });
    this.sync();
  }

  get editingStage() {
    return this.editor?.stage || null;
  }

  isEditing() {
    return Boolean(this.editor?.isActive());
  }

  /** True while `stage`'s overlay must stay hidden: its mask is on the drawing layer. */
  isHiding(stage) {
    return Boolean(stage) && (stage === this.editingStage || stage === this.pendingStage);
  }

  // ==================== Choices ====================

  result(stage) {
    return this.app.inferenceExecutor.getResult(stage);
  }

  /** `{ value, stage, labelSetId, name, isNew }` for each choice in the Mask select. */
  choices() {
    const list = [];
    for (const stage of EDITABLE_STAGES) {
      if (!this.app.inferenceExecutor.hasResult(stage)) continue;
      const edited = this.result(stage)?.manualEdit;
      list.push({
        value: stage,
        stage,
        labelSetId: this.app.getOverlayLabelTaskId(stage),
        name: `${STAGE_NAMES[stage] || stage}${edited ? ' (edited)' : ''}`,
        isNew: false
      });
    }
    for (const mask of NEW_MASKS) {
      if (this.app.inferenceExecutor.hasResult(mask.stage)) continue;
      list.push({ value: `new:${mask.stage}`, stage: mask.stage, labelSetId: mask.labelSetId, name: mask.name, isNew: true });
    }
    return list;
  }

  selectedChoice() {
    const list = this.choices();
    return list.find(choice => choice.value === this.stageSelect?.value) || list[0] || null;
  }

  isAvailable() {
    return Boolean(this.editor && this.app.inputFile && this.app.isViewerAvailable() && !this.app.isCompareMode?.());
  }

  sync() {
    const available = this.isAvailable();
    const editing = this.isEditing();
    const running = Boolean(this.app.currentRunningStep || this.app.inferenceExecutor?.isRunning());
    this.section?.classList.toggle('step-disabled', !available);

    if (this.stageSelect) {
      // After an apply the stage just edited stays selected, so Restore is at hand.
      const previous = editing ? null : this.preferredStage || this.stageSelect.value;
      this.preferredStage = null;
      const list = this.choices();
      this.stageSelect.replaceChildren(...list.map(choice => new Option(choice.name, choice.value)));
      const keep = editing
        ? list.find(choice => choice.stage === this.editingStage && !choice.isNew)?.value
          ?? list.find(choice => choice.stage === this.editingStage)?.value
        : list.some(choice => choice.value === previous) ? previous : list[0]?.value;
      if (keep) this.stageSelect.value = keep;
      this.stageSelect.disabled = !available || editing;
    }

    const choice = this.selectedChoice();
    if (this.labelSelect) {
      const labels = choice ? getTaskLabels(choice.labelSetId).filter(label => label.index > 0) : [];
      const previous = Number(this.labelSelect.value);
      this.labelSelect.replaceChildren(...labels.map(label => new Option(label.name, String(label.index))));
      const wanted = editing ? this.editor.session.label : previous;
      if (labels.some(label => label.index === wanted)) this.labelSelect.value = String(wanted);
      this.labelSelect.disabled = !available || labels.length < 2;
    }

    const edited = !editing && choice && !choice.isNew ? this.result(choice.stage)?.manualEdit : null;
    this.setButton('start', !editing, available && !running && Boolean(choice));
    this.setButton('apply', editing, true);
    this.setButton('discard', editing, true);
    this.setButton('revert', Boolean(edited), available && !running);
    if (this.buttons.revert) {
      this.buttons.revert.textContent = edited?.kind === 'new' ? 'Remove mask' : 'Restore model mask';
    }
  }

  setButton(name, shown, enabled) {
    const button = this.buttons[name];
    if (!button) return;
    button.hidden = !shown;
    button.disabled = !enabled;
  }

  showLabel(value) {
    if (!this.labelSelect) return;
    if ([...this.labelSelect.options].some(option => Number(option.value) === value)) {
      this.labelSelect.value = String(value);
    }
  }

  // ==================== Session ====================

  /** Builds an editor request for `choice`: the stage's voxels, colours and label. */
  async request(choice) {
    let native = null;
    if (!choice.isNew) {
      const file = this.result(choice.stage)?.file;
      if (!file) throw new Error(`${choice.name} has no mask.`);
      native = (await readMaskVoxels(file)).voxels;
    }
    const label = Number(this.labelSelect?.value) || getTaskLabels(choice.labelSetId).find(item => item.index > 0)?.index || 1;
    return {
      stage: choice.stage,
      native,
      labelSetId: choice.labelSetId,
      labelColormap: generateLabelColormap(choice.labelSetId),
      label,
      opacity: this.app.viewer?.getStageOpacity(choice.stage, true) ?? 0.7,
      choice
    };
  }

  async start(choice = this.selectedChoice()) {
    if (!choice || !this.isAvailable() || this.isEditing()) return false;
    try {
      // The input must be the base image: the drawing layer takes its grid.
      if (this.app.currentResultTab !== 'input') {
        this.app.currentResultTab = 'input';
      }
      const request = await this.request(choice);
      this.editor.stageChoice = choice;
      // The stage's overlay is hidden while its mask is on the drawing layer.
      this.pendingStage = choice.stage;
      await this.app.renderViewerVolumes();
      await this.editor.begin(request);
      this.pendingStage = null;
      this.app.logAnalysis(choice.isNew
        ? `Manual edit: drawing a ${choice.name.replace(/^New /, '')} on ${this.app.inputFile?.name || 'the image'}`
        : `Manual edit: editing ${choice.name} in the Drawing tab`);
      this.sync();
      return true;
    } catch (error) {
      this.pendingStage = null;
      this.app.logAnalysis(`Manual edit could not start: ${error.message}`, 'error');
      await this.app.renderViewerVolumes();
      this.sync();
      return false;
    }
  }

  async apply() {
    if (!this.isEditing()) return false;
    const stage = this.editingStage;
    const native = this.editor.apply();
    await this.commit(stage, native);
    return true;
  }

  discard() {
    if (!this.isEditing()) return;
    const stage = this.editingStage;
    const changed = this.editor.changedVoxels();
    this.editor.discard();
    this.app.logAnalysis(`Manual edit discarded for ${STAGE_NAMES[stage] || stage}${changed ? ` (${changed} voxels not kept)` : ''}`, changed ? 'warning' : 'info');
    void this.app.renderViewerVolumes();
    this.sync();
  }

  /** Closes a session without asking, for a new file or a cleared session. */
  reset() {
    if (this.isEditing()) this.editor.discard();
    this.pendingStage = null;
    this.sync();
  }

  /** Makes `native` (voxels in the input's file order) the data of `stage`. */
  async commit(stage, native) {
    const previous = this.result(stage);
    const original = previous?.manualEdit?.original || (previous?.file ? { file: previous.file, raw: previous.raw } : null);
    const template = previous?.file
      ? await decodeNiftiBuffer(await previous.file.arrayBuffer())
      : await decodeNiftiBuffer(await this.app.inputFile.arrayBuffer());
    let changed = 0;
    if (previous?.file) {
      const before = readNiftiImageData(template, Uint8Array).data;
      for (let index = 0; index < native.length; index += 1) if (before[index] !== native[index]) changed += 1;
    } else {
      for (const value of native) if (value) changed += 1;
    }
    const kind = original ? 'edited' : 'new';
    const name = original
      ? editedFileName(original.file.name)
      : `${(this.app.inputFile?.name || 'image').replace(/\.nii(\.gz)?$/i, '')}_${stage}_manual.nii`;
    const file = new File([buildMaskNifti(native, template)], name, { type: 'application/octet-stream' });
    const choice = NEW_MASKS.find(mask => mask.stage === stage);
    await this.app.setStageData(stage, file, {
      source: 'edit',
      labelSetId: previous?.labelSetId || (previous ? null : choice?.labelSetId),
      manualEdit: { kind, original, changedVoxels: changed, downloaded: false, at: new Date().toISOString() }
    });
    this.preferredStage = stage;
    const counts = [...labelCounts(native)].map(([label, count]) => `${label}: ${count}`).join(', ') || 'empty';
    this.app.logAnalysis(`Manual edit applied to ${STAGE_NAMES[stage] || stage}: ${changed} voxels changed; voxels per label ${counts}; saved as ${name}`);
    this.sync();
  }

  /** Back to the model's mask, or remove a mask drawn from nothing. */
  async revert(stage = this.selectedChoice()?.stage) {
    const result = this.result(stage);
    const edit = result?.manualEdit;
    if (!edit || this.isEditing()) return false;
    if (edit.kind === 'new' || !edit.original) {
      await this.app.removeStageData(stage, { source: 'restore' });
      this.app.logAnalysis(`Manual mask removed: ${STAGE_NAMES[stage] || stage}`);
    } else {
      await this.app.setStageData(stage, edit.original.file, { source: 'restore', manualEdit: null });
      this.app.logAnalysis(`Model mask restored: ${STAGE_NAMES[stage] || stage} (${edit.original.file.name})`);
    }
    this.sync();
    return true;
  }

  // ==================== FreeBrowse's own drawing buttons ====================

  // FreeBrowse's Create empty drawing layer or Edit as drawing opened a layer.
  // It becomes an edit of the stage it came from (Edit as drawing on an SCT
  // result) or of the stage chosen in the Mask select, and its voxels are
  // refilled with the exact mapping, which NiiVue's loadDrawing lacks.
  async adopt({ action, stage }) {
    if (!this.isAvailable()) return null;
    let choice = null;
    if (action === 'load') {
      if (!stage) return null;
      choice = this.choices().find(item => item.stage === stage && !item.isNew);
    } else {
      choice = this.selectedChoice();
    }
    if (!choice) return null;
    const request = await this.request(choice);
    this.app.logAnalysis(`Manual edit: FreeBrowse's drawing layer now edits ${choice.name}`);
    return request;
  }

  adopted() {
    this.sync();
    void this.app.renderViewerVolumes();
  }

  // FreeBrowse's Save Drawing closes the layer and adds it as a new volume.
  // The edit is applied to its stage instead, and that volume is dropped by
  // the next render.
  async closedByViewer(native, stage) {
    this.app.logAnalysis(`Manual edit saved from the Drawing tab for ${STAGE_NAMES[stage] || stage}`);
    await this.commit(stage, native);
    const nv = this.app.nv;
    nv?.addEventListener('volumeLoaded', () => void this.app.renderViewerVolumes(), { once: true });
  }

  // ==================== Unsaved edits ====================

  unsavedStages() {
    const stages = EDITABLE_STAGES.filter(stage => {
      const edit = this.result(stage)?.manualEdit;
      return edit && !edit.downloaded;
    });
    if (this.isEditing() && this.editor.isDirty() && !stages.includes(this.editingStage)) stages.unshift(this.editingStage);
    return stages;
  }

  hasUnsavedEdits() {
    return this.unsavedStages().length > 0;
  }

  /**
   * Asks before `action` drops edits that were not applied or not downloaded.
   * Returns true when the action may go ahead.
   */
  confirmDiscard(action) {
    const stages = this.unsavedStages();
    if (!stages.length) return true;
    const names = stages.map(stage => STAGE_NAMES[stage] || stage).join(', ');
    const ok = globalThis.confirm?.(`${action} discards your manual edits to ${names}, which you have not downloaded. Continue?`) ?? false;
    if (!ok) {
      this.app.logAnalysis(`Kept manual edits to ${names}: ${action.toLowerCase()} was cancelled`, 'warning');
      return false;
    }
    this.app.logAnalysis(`Manual edits to ${names} discarded: ${action.toLowerCase()}`, 'warning');
    if (this.isEditing()) this.editor.discard();
    return true;
  }
}
