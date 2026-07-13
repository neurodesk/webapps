export function definePlugin(plugin) {
  if (!plugin?.id) throw new Error('Plugin requires id');
  return Object.freeze({
    id: plugin.id,
    name: plugin.name || plugin.id,
    description: plugin.description || '',
    sourceRepos: plugin.sourceRepos || [],
    capabilities: plugin.capabilities || [],
    tasks: plugin.tasks || [],
    pipelines: plugin.pipelines || [],
    labels: plugin.labels || {},
    colormaps: plugin.colormaps || {},
    panels: plugin.panels || [],
    workerSteps: plugin.workerSteps || {},
    validationHooks: plugin.validationHooks || {},
    register: plugin.register || (() => {})
  });
}

export function generateDiscreteColormap(labels, options = {}) {
  const size = options.size || 256;
  const R = new Array(size).fill(0);
  const G = new Array(size).fill(0);
  const B = new Array(size).fill(0);
  const A = new Array(size).fill(0);
  const maxValue = Math.max(1, ...labels.map(label => label.value ?? label.index ?? 0));
  for (const label of labels) {
    const value = label.value ?? label.index;
    const color = label.color || [128, 128, 128, 255];
    const lutIndex = maxValue <= 1 ? (value ? size - 1 : 0) : Math.round((value / maxValue) * (size - 1));
    R[lutIndex] = color[0] ?? 0;
    G[lutIndex] = color[1] ?? 0;
    B[lutIndex] = color[2] ?? 0;
    A[lutIndex] = color[3] ?? 255;
  }
  return { R, G, B, A, min: 0, max: maxValue };
}
