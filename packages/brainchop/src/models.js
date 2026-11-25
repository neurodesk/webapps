// Shared Brainchop model catalog, colormaps, option validation, and output naming.
// Used by both apps/brainchop and the portable @neurodesk/brainchop Node CLI.
import { MODELS as CORE_MODELS } from '@brainchop/core';

export const MODELS = Object.freeze([
  Object.freeze({
    id: 'mindmap',
    coreModel: 'mindmap',
    kind: 'labels',
    label: 'Subcortical + tissue (MindMap-24)',
    hint: '18-class cortical and subcortical segmentation.',
    classes: 18,
  }),
  Object.freeze({
    id: 'mindmap-fast',
    coreModel: 'mindmap-fast',
    kind: 'labels',
    label: 'Subcortical + tissue, fast (MindMap-16)',
    hint: 'Lightweight 18-class preview; not for hippocampal morphometry.',
    classes: 18,
  }),
  Object.freeze({
    id: 'mindsnap',
    coreModel: 'mindsnap',
    kind: 'labels',
    label: 'Desikan-Killiany 104 (MindSnap-104)',
    hint: '104-region cortical, subcortical and corpus callosum atlas.',
    classes: 104,
  }),
  Object.freeze({
    id: 'tissue-fractions',
    coreModel: 'mindmap',
    kind: 'tissues',
    label: 'Tissue fraction maps (GM/WM/CSF)',
    hint: 'Continuous GM, WM, CSF and brain partial-volume fractions.',
    classes: 0,
  }),
]);

export const TISSUE_STAGES = Object.freeze([
  Object.freeze({ id: 'gm', label: 'Grey matter fraction', suffix: 'gm', colormap: 'warm' }),
  Object.freeze({ id: 'wm', label: 'White matter fraction', suffix: 'wm', colormap: 'gray' }),
  Object.freeze({ id: 'csf', label: 'CSF fraction', suffix: 'csf', colormap: 'winter' }),
  Object.freeze({ id: 'brain', label: 'Brain (GM + WM) fraction', suffix: 'brain', colormap: 'warm' }),
]);

export function findModel(id) {
  return MODELS.find((model) => model.id === id) ?? null;
}

export function stemFor(filename) {
  return String(filename || 'image').replace(/\.nii(\.gz)?$/i, '');
}

export function outputNames(filename, modelId = 'mindmap') {
  const model = findModel(modelId);
  if (!model) {
    throw new Error(`Unknown model '${modelId}'. Choose one of: ${MODELS.map((m) => m.id).join(', ')}`);
  }
  const stem = stemFor(filename);
  if (model.kind === 'tissues') {
    return Object.fromEntries(TISSUE_STAGES.map((stage) => [stage.id, `${stem}_${stage.suffix}.nii`]));
  }
  return { segmentation: `${stem}_${model.id}.nii` };
}

export function validateOptions({
  model = 'mindmap',
  saveConform = false,
  noTurbo = false,
  legacyCleanup = false,
} = {}) {
  const entry = findModel(model);
  if (!entry) {
    throw new Error(`Unknown model '${model}'. Choose one of: ${MODELS.map((m) => m.id).join(', ')}`);
  }
  if (typeof saveConform !== 'boolean') {
    throw new Error('saveConform must be a boolean');
  }
  if (typeof noTurbo !== 'boolean') {
    throw new Error('noTurbo must be a boolean');
  }
  if (typeof legacyCleanup !== 'boolean') {
    throw new Error('legacyCleanup must be a boolean');
  }
  if (legacyCleanup && entry.kind !== 'labels') {
    throw new Error('legacyCleanup is only supported for label models (mindmap, mindmap-fast, mindsnap)');
  }
  return {
    model: entry,
    saveConform,
    noTurbo,
    legacyCleanup,
  };
}

export function labelColormap(modelId) {
  const model = findModel(modelId);
  if (!model || model.kind !== 'labels') return null;
  const info = CORE_MODELS[model.coreModel];
  if (!info?.colormap) return null;
  const { R, G, B, labels } = info.colormap;
  const A = R.map((_, index) => (index === 0 ? 0 : 255));
  return { R, G, B, A, labels };
}

export function labelNamesMap(modelId) {
  const lut = labelColormap(modelId);
  if (!lut) return {};
  return Object.fromEntries(lut.labels.map((name, index) => [index, name]));
}
