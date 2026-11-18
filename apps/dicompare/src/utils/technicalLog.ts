import { useSyncExternalStore } from 'react';
import { formatMemoryError, isMemoryErrorMessage } from '@neurodesk/webapp-components/ui';

/**
 * Technical log and activity store.
 *
 * A module-level store (no provider needed) so hooks, contexts and plain
 * services can all write to the same log. Components read it through
 * `useTechnicalLog()` / `useActivity()` via `useSyncExternalStore`.
 */

export type LogLevel = 'info' | 'success' | 'warning' | 'error';

export interface LogEntry {
  id: number;
  time: Date;
  level: LogLevel;
  message: string;
}

export interface ActivityState {
  /** Label of the running operation, or null when idle. */
  label: string | null;
  /** Fractional progress 0..1, or null when indeterminate. */
  progress: number | null;
  /** Epoch ms when the current run of activity started. */
  startedAt: number | null;
  /** Latest log entry id recorded synchronously when the activity started. */
  logFloorId: number;
}

const MAX_ENTRIES = 500;

type Listener = () => void;

let entries: LogEntry[] = [];
let nextId = 1;
const logListeners = new Set<Listener>();
let recoveryNotice: string | null = null;
const recoveryListeners = new Set<Listener>();

function emitLog() {
  logListeners.forEach((listener) => listener());
}

function emitRecovery() {
  recoveryListeners.forEach((listener) => listener());
}

export function log(message: string, level: LogLevel = 'info'): void {
  const formatted = level === 'error' && isMemoryErrorMessage(message) ? formatMemoryError(message) : null;
  if (formatted) {
    const rawEntry: LogEntry = { id: nextId++, time: new Date(), level: 'info', message: formatted.log };
    const statusEntry: LogEntry = { id: nextId++, time: new Date(), level: 'error', message: formatted.status };
    entries = [...entries, rawEntry, statusEntry].slice(-MAX_ENTRIES);
    emitLog();
    return;
  }
  const entry: LogEntry = { id: nextId++, time: new Date(), level, message };
  entries = entries.length >= MAX_ENTRIES ? [...entries.slice(1), entry] : [...entries, entry];
  emitLog();
}

/** Log a caught error with a short context prefix. */
export function logError(context: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error ?? 'Unknown error');
  log(`${context}: ${detail}`, 'error');
}

export function clearLog(): void {
  entries = [];
  emitLog();
  clearRecoveryNotice();
}

export function getRecoveryNotice(): string | null {
  return recoveryNotice;
}

export function clearRecoveryNotice(): void {
  if (recoveryNotice === null) return;
  recoveryNotice = null;
  emitRecovery();
}

function subscribeRecovery(listener: Listener) {
  recoveryListeners.add(listener);
  return () => { recoveryListeners.delete(listener); };
}

export function useRecoveryNotice(): string | null {
  return useSyncExternalStore(subscribeRecovery, getRecoveryNotice, getRecoveryNotice);
}

export function getLogEntries(): LogEntry[] {
  return entries;
}

export function getLatestLogId(): number {
  return entries.length ? entries[entries.length - 1].id : 0;
}

function subscribeLog(listener: Listener) {
  logListeners.add(listener);
  return () => { logListeners.delete(listener); };
}

export function useTechnicalLog(): LogEntry[] {
  return useSyncExternalStore(subscribeLog, getLogEntries, getLogEntries);
}

// ---------------------------------------------------------------------------
// Activity: short operations (validation, export) that are not tracked by the
// processing context but should show in the status footer.
// ---------------------------------------------------------------------------

interface Activity { id: number; label: string; progress: number | null; logFloorId: number }

let activities: Activity[] = [];
let nextActivityId = 1;
let activityState: ActivityState = { label: null, progress: null, startedAt: null, logFloorId: 0 };
const activityListeners = new Set<Listener>();

function recompute() {
  const current = activities[activities.length - 1] ?? null;
  const root = activities[0] ?? null;
  const wasBusy = activityState.label !== null;
  activityState = {
    label: current?.label ?? null,
    progress: current?.progress ?? null,
    startedAt: current ? (wasBusy ? activityState.startedAt : Date.now()) : null,
    logFloorId: root ? root.logFloorId : activityState.logFloorId,
  };
  activityListeners.forEach((listener) => listener());
}

/**
 * Mark an operation as running. Returns a `done` function; call it in a
 * `finally` block. Nested operations show the most recent label.
 */
export function beginActivity(label: string, options: { silent?: boolean } = {}): (result?: { message?: string; level?: LogLevel }) => void {
  clearRecoveryNotice();
  if (!options.silent) log(label);
  const activity: Activity = { id: nextActivityId++, label, progress: null, logFloorId: getLatestLogId() };
  activities = [...activities, activity];
  recompute();
  let finished = false;
  return (result) => {
    if (finished) return;
    finished = true;
    activities = activities.filter((item) => item.id !== activity.id);
    if (result?.message) log(result.message, result.level ?? 'success');
    recompute();
  };
}

function subscribeActivity(listener: Listener) {
  activityListeners.add(listener);
  return () => { activityListeners.delete(listener); };
}

const getActivity = () => activityState;

export function useActivity(): ActivityState {
  return useSyncExternalStore(subscribeActivity, getActivity, getActivity);
}

/** True while any tracked activity runs; nested operations log quietly. */
export function isActivityRunning(): boolean {
  return activities.length > 0;
}

function describe(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

let consoleCaptured = false;

/**
 * Mirror console.error and console.warn into the technical log so every
 * caught error that is reported to the console also reaches the user, and
 * record uncaught errors and rejections.
 */
export function installConsoleCapture(target: Window & typeof globalThis = window): void {
  if (consoleCaptured) return;
  consoleCaptured = true;
  const originalError = console.error.bind(console);
  const originalWarn = console.warn.bind(console);
  let forwarding = false;
  const forward = (level: LogLevel, args: unknown[]) => {
    if (forwarding) return;
    forwarding = true;
    try {
      log(args.map(describe).join(' ').replace(/^\[[\w.]+\]\s*/, ''), level);
    } finally {
      forwarding = false;
    }
  };
  console.error = (...args: unknown[]) => {
    originalError(...args);
    forward('error', args);
  };
  console.warn = (...args: unknown[]) => {
    originalWarn(...args);
    forward('warning', args);
  };
  target.addEventListener('error', (event) => log(`Unexpected error: ${event.message}`, 'error'));
  target.addEventListener('unhandledrejection', (event) => logError('Unexpected error', event.reason));
  (target as unknown as Record<symbol, boolean>)[Symbol.for('neurodesk.statusManaged')] = true;
  target.addEventListener('neurodesk-memory-notice', (event) => {
    const detail = (event as CustomEvent<{ status?: string; log?: string }>).detail;
    if (detail?.log) log(detail.log, 'info');
    if (detail?.status) {
      log(detail.status, 'error');
      recoveryNotice = detail.status;
      emitRecovery();
    }
  });
  target.addEventListener('neurodesk-memory-restored', () => {
    const webglStatus = formatMemoryError('WebGL context lost', { kind: 'webgl' })?.status;
    if (webglStatus && entries.some((entry) => entry.level === 'error' && entry.message === webglStatus)) {
      entries = entries.filter((entry) => !(entry.level === 'error' && entry.message === webglStatus));
      emitLog();
    }
    if (recoveryNotice === webglStatus) clearRecoveryNotice();
  });
}

/** Test helper: reset every store. */
export function resetTechnicalLog(): void {
  entries = [];
  activities = [];
  activityState = { label: null, progress: null, startedAt: null, logFloorId: 0 };
  recoveryNotice = null;
  emitLog();
  emitRecovery();
  activityListeners.forEach((listener) => listener());
}
