/**
 * The console holds two logs.
 *
 * Analysis is what a scientist reads back: the input, the task and its
 * parameters, result summaries, saved outputs, and the warnings and errors
 * that change how a result should be read.
 *
 * Technical is the machinery: model fetch and cache, backend selection,
 * tensor shapes, per-patch statistics, timings, viewer and worker lifecycle.
 *
 * A line goes to exactly one of them.
 */
export const ANALYSIS = 'analysis';
export const TECHNICAL = 'technical';

function levelOf(message, fallback = 'info') {
  if (/^(error|worker error)\b/i.test(message)) return 'error';
  if (/^warning\b/i.test(message)) return 'warning';
  return fallback;
}

/** Worker lines are technical unless the worker posts them with `channel: 'analysis'`. */
export function routeWorkerLog(message, details = {}) {
  const text = String(message ?? '');
  const channel = details.channel === ANALYSIS ? ANALYSIS : TECHNICAL;
  return { channel, level: levelOf(text, details.level || 'info') };
}

/**
 * Lines the shared pipeline executor writes itself. A failed or aborted run
 * changes what the user may conclude, so it is analysis; worker start-up,
 * "Starting ...", "Cancelling..." and completion bookkeeping are technical.
 */
export function routePipelineMessage(message) {
  const text = String(message ?? '');
  if (/^(error|worker error)\b/i.test(text)) return { channel: ANALYSIS, level: 'error' };
  if (/^Aborted\b/.test(text)) return { channel: ANALYSIS, level: 'warning' };
  return { channel: TECHNICAL, level: levelOf(text) };
}

/** One line describing the run: task, input and the parameters that shape the result. */
export function describeRun({ task, input, model, sourceVersion, threshold, minComponentSize, overlap, testTimeAugmentation, patchSize }) {
  const parameters = [
    `model ${model}${sourceVersion ? ` (${sourceVersion})` : ''}`,
    `threshold ${threshold}`,
    `min component ${minComponentSize} voxels`,
    `overlap ${overlap}`,
    `TTA ${testTimeAugmentation ? 'on' : 'off'}`,
    `patch ${[].concat(patchSize || []).join('x')}`,
  ];
  return [`Task: ${task} on ${input}`, `Parameters: ${parameters.join(', ')}`];
}
