/**
 * Which loaded image owns which results.
 *
 * The pipeline executor holds the results of the active session only: the
 * Results list, downloads, metrics, morphometry sources, automation artifacts
 * and the main viewer all read it. When the user makes another image active,
 * the outgoing session's results are parked here and the incoming session's
 * parked results, if any, are handed back to the executor. Compare reads
 * parked results to draw each panel's own overlays.
 *
 * Memory is bounded by count: results are kept for the active session plus the
 * `MAX_SESSIONS_WITH_RESULTS - 1` most recently active others (the most a
 * comparison shows at once). Parking one more releases the least recently used
 * session's results; the caller tells the user. Parked results keep only their
 * `File`s and metric rows: the worker's transfer buffer (`raw.niftiData`),
 * which duplicates each mask, is dropped.
 */

export const MAX_SESSIONS_WITH_RESULTS = 4;

const PAYLOAD_KEYS = ['niftiData', 'data', 'buffer'];

function withoutPayload(raw) {
  if (!raw || typeof raw !== 'object') return raw ?? null;
  const kept = { ...raw };
  for (const key of PAYLOAD_KEYS) delete kept[key];
  return kept;
}

/**
 * Copy what belongs to the current session out of `executor` (results, their
 * order, the settings that produced them) together with `extra` app state.
 * Returns null when the session has no results to keep.
 */
export function snapshotSessionResults(executor, extra = {}) {
  const stageOrder = executor.getStageOrder().filter(stage => executor.getResult(stage)?.file);
  if (!stageOrder.length) return null;
  const results = {};
  for (const stage of stageOrder) {
    const result = executor.getResult(stage);
    results[stage] = { ...result, raw: withoutPayload(result.raw) };
  }
  const stepStatus = {};
  for (const step of executor.steps || []) {
    if (step !== 'load' && executor.getStepStatus(step) === 'complete') stepStatus[step] = 'complete';
  }
  return {
    results,
    stageOrder,
    stepStatus,
    lastRunSettings: executor.lastRunSettings ?? null,
    lastMorphometrySettings: executor.lastMorphometrySettings ?? null,
    ...extra
  };
}

/** Hand a snapshot back to `executor`, replacing whatever results it holds. */
export function restoreSessionResults(executor, snapshot) {
  executor.results = { ...snapshot.results };
  executor.stageOrder = [...snapshot.stageOrder];
  for (const [step, status] of Object.entries(snapshot.stepStatus || {})) executor.stepStatus[step] = status;
  executor.lastRunSettings = snapshot.lastRunSettings ?? null;
  executor.lastMorphometrySettings = snapshot.lastMorphometrySettings ?? null;
}

export class SessionResultStore {
  /** `limit` counts parked sessions; the active session's results are the one more. */
  constructor({ limit = MAX_SESSIONS_WITH_RESULTS - 1 } = {}) {
    this.limit = Math.max(0, limit);
    this.parked = new Map();
  }

  /** Park `snapshot` for `sessionId`. Returns the ids released to stay within the limit. */
  park(sessionId, snapshot) {
    this.parked.delete(sessionId);
    if (!snapshot) return [];
    this.parked.set(sessionId, snapshot);
    const released = [];
    while (this.parked.size > this.limit) {
      const [oldest] = this.parked.keys();
      this.parked.delete(oldest);
      released.push(oldest);
    }
    return released;
  }

  /** The parked snapshot, left in place (Compare reads it). */
  peek(sessionId) {
    return this.parked.get(sessionId) || null;
  }

  /** Remove and return the parked snapshot (the session becomes active). */
  unpark(sessionId) {
    const snapshot = this.peek(sessionId);
    this.parked.delete(sessionId);
    return snapshot;
  }

  has(sessionId) {
    return this.parked.has(sessionId);
  }

  drop(sessionId) {
    this.parked.delete(sessionId);
  }

  /** Forget every session not in `sessionIds` (removed images). */
  retain(sessionIds) {
    const keep = new Set(sessionIds);
    for (const id of [...this.parked.keys()]) {
      if (!keep.has(id)) this.parked.delete(id);
    }
  }

  clear() {
    this.parked.clear();
  }

  get size() {
    return this.parked.size;
  }
}
