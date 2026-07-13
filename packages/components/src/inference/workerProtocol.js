export const WorkerRequestType = Object.freeze({
  INIT: 'init',
  LOAD: 'load',
  RUN: 'run',
  RUN_STEP: 'run-step',
  RESET_STATE: 'reset-state',
  RESTORE_STATE: 'restore-state',
  CANCEL: 'cancel'
});

export const WorkerEventType = Object.freeze({
  INITIALIZED: 'initialized',
  PROGRESS: 'progress',
  LOG: 'log',
  ERROR: 'error',
  STAGE_DATA: 'stageData',
  METRICS: 'metrics',
  DETECTED_LABELS: 'detectedLabels',
  VOLUME_INFO: 'volume-info',
  STATE_ARTIFACT: 'state-artifact',
  STATE_RESTORED: 'state-restored',
  STEP_COMPLETE: 'step-complete',
  COMPLETE: 'complete'
});

export function collectTransferables(value, transferables = [], seen = new Set()) {
  if (!value || typeof value !== 'object') return transferables;
  if (value instanceof ArrayBuffer) {
    if (!seen.has(value)) {
      seen.add(value);
      transferables.push(value);
    }
    return transferables;
  }
  if (ArrayBuffer.isView(value)) return collectTransferables(value.buffer, transferables, seen);
  if (Array.isArray(value)) {
    for (const item of value) collectTransferables(item, transferables, seen);
    return transferables;
  }
  for (const item of Object.values(value)) collectTransferables(item, transferables, seen);
  return transferables;
}
