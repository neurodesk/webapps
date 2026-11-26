import manifest from '../model.manifest.json' with { type: 'json' };

export { manifest };

export const MODELS = Object.freeze(
  manifest.assets.map((asset) => Object.freeze({ ...asset, url: manifest.base_url + asset.filename })),
);

export function modelById(id) {
  const model = MODELS.find((entry) => entry.id === id);
  if (!model) throw new Error(`TotalSegmentator has no model for ${id}.`);
  return model;
}

export const CT_SUBSETS = Object.freeze([
  Object.freeze({ id: 'all', label: 'All structures (5 models)', modelIds: Object.freeze(['total-ct-organs', 'total-ct-vertebrae', 'total-ct-cardiac', 'total-ct-muscles', 'total-ct-ribs']) }),
  Object.freeze({ id: 'muscles', label: 'Muscles & bones (23)', modelIds: Object.freeze(['total-ct-muscles']) }),
  Object.freeze({ id: 'vertebrae', label: 'Vertebrae (26)', modelIds: Object.freeze(['total-ct-vertebrae']) }),
  Object.freeze({ id: 'ribs', label: 'Ribs (26)', modelIds: Object.freeze(['total-ct-ribs']) }),
  Object.freeze({ id: 'organs', label: 'Organs (24)', modelIds: Object.freeze(['total-ct-organs']) }),
  Object.freeze({ id: 'cardiac', label: 'Cardiac & vessels (18)', modelIds: Object.freeze(['total-ct-cardiac']) }),
]);

export const MR_SUBSETS = Object.freeze([
  Object.freeze({ id: 'all', label: 'All structures (2 models)', modelIds: Object.freeze(['total-mr-organs', 'total-mr-muscles']) }),
  Object.freeze({ id: 'muscles', label: 'Muscles & bones (21)', modelIds: Object.freeze(['total-mr-muscles']) }),
  Object.freeze({ id: 'organs', label: 'Organs (29)', modelIds: Object.freeze(['total-mr-organs']) }),
]);

export const TASKS = Object.freeze([
  Object.freeze({
    id: 'total',
    label: 'CT — Whole body (117 structures)',
    modality: 'ct',
    supportsResolution: true,
    subsets: CT_SUBSETS,
  }),
  Object.freeze({
    id: 'total_mr',
    label: 'MRI — Whole body (50 structures)',
    modality: 'mri',
    supportsResolution: true,
    subsets: MR_SUBSETS,
  }),
  Object.freeze({
    id: 'vertebrae_mr',
    label: 'MRI — Vertebrae (25 structures)',
    modality: 'mri',
    supportsResolution: false,
    subsets: null,
  }),
  Object.freeze({
    id: 'abdominal_muscles',
    label: 'CT — Abdominal muscles (22 structures)',
    modality: 'ct',
    supportsResolution: false,
    subsets: null,
  }),
]);

export function taskById(id) {
  const task = TASKS.find((entry) => entry.id === id);
  if (!task) throw new Error(`Unknown TotalSegmentator task: ${id}`);
  return task;
}

// Resolves which model entries (and optional crop model) a task + resolution + subset runs.
export function resolveTaskPlan({ task = 'total', resolution, subset = 'all' } = {}) {
  const spec = taskById(task);
  if (task === 'total') {
    const resolvedResolution = resolution ?? 'fast';
    if (resolvedResolution === 'fast') {
      if (subset !== 'all') {
        throw new Error(`Subset "${subset}" requires full resolution (1.5 mm) for task "${task}".`);
      }
      return { task: spec, resolution: 'fast', subset: 'all', models: [modelById('total-ct-3mm')], cropModel: null };
    }
    if (resolvedResolution === 'full') {
      const group = CT_SUBSETS.find((entry) => entry.id === subset);
      if (!group) {
        throw new Error(`Unsupported subset "${subset}" for task "${task}". Valid subsets: ${CT_SUBSETS.map((s) => s.id).join(', ')}.`);
      }
      return { task: spec, resolution: 'full', subset: group.id, models: group.modelIds.map(modelById), cropModel: null };
    }
    throw new Error(`Unsupported resolution "${resolvedResolution}" for task "${task}".`);
  }
  if (task === 'total_mr') {
    const resolvedResolution = resolution ?? 'fast';
    if (resolvedResolution === 'fast') {
      if (subset !== 'all') {
        throw new Error(`Subset "${subset}" requires full resolution (1.5 mm) for task "${task}".`);
      }
      return { task: spec, resolution: 'fast', subset: 'all', models: [modelById('total-mr-3mm')], cropModel: null };
    }
    if (resolvedResolution === 'full') {
      const group = MR_SUBSETS.find((entry) => entry.id === subset);
      if (!group) {
        throw new Error(`Unsupported subset "${subset}" for task "${task}". Valid subsets: ${MR_SUBSETS.map((s) => s.id).join(', ')}.`);
      }
      return { task: spec, resolution: 'full', subset: group.id, models: group.modelIds.map(modelById), cropModel: null };
    }
    throw new Error(`Unsupported resolution "${resolvedResolution}" for task "${task}".`);
  }
  if (task === 'vertebrae_mr') {
    if (resolution !== undefined && resolution !== 'full') {
      throw new Error(`Task "${task}" only supports full resolution (got "${resolution}").`);
    }
    if (subset !== 'all') {
      throw new Error(`Task "${task}" does not support subset "${subset}".`);
    }
    return { task: spec, resolution: 'full', subset: 'all', models: [modelById('vertebrae-mr')], cropModel: null };
  }
  if (task === 'abdominal_muscles') {
    if (resolution !== undefined && resolution !== 'full') {
      throw new Error(`Task "${task}" only supports full resolution (got "${resolution}").`);
    }
    if (subset !== 'all') {
      throw new Error(`Task "${task}" does not support subset "${subset}".`);
    }
    return {
      task: spec,
      resolution: 'full',
      subset: 'all',
      models: [modelById('abdominal-muscles-ct')],
      cropModel: modelById('body-ct-6mm'),
    };
  }
  throw new Error(`Unsupported task: ${task}`);
}
