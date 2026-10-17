import { useSyncExternalStore } from 'react';

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
}

const MAX_ENTRIES = 500;

type Listener = () => void;

let entries: LogEntry[] = [];
let nextId = 1;
const logListeners = new Set<Listener>();

function emitLog() {
  logListeners.forEach((listener) => listener());
}

export function log(message: string, level: LogLevel = 'info'): void {
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
}

export function getLogEntries(): LogEntry[] {
  return entries;
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

interface Activity { id: number; label: string; progress: number | null }

let activities: Activity[] = [];
let nextActivityId = 1;
let activityState: ActivityState = { label: null, progress: null, startedAt: null };
const activityListeners = new Set<Listener>();

function recompute() {
  const current = activities[activities.length - 1] ?? null;
  const wasBusy = activityState.label !== null;
  activityState = {
    label: current?.label ?? null,
    progress: current?.progress ?? null,
    startedAt: current ? (wasBusy ? activityState.startedAt : Date.now()) : null,
  };
  activityListeners.forEach((listener) => listener());
}

/**
 * Mark an operation as running. Returns a `done` function; call it in a
 * `finally` block. Nested operations show the most recent label.
 */
export function beginActivity(label: string, options: { silent?: boolean } = {}): (result?: { message?: string; level?: LogLevel }) => void {
  const activity: Activity = { id: nextActivityId++, label, progress: null };
  activities = [...activities, activity];
  if (!options.silent) log(label);
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
}

/** Test helper: reset every store. */
export function resetTechnicalLog(): void {
  entries = [];
  activities = [];
  activityState = { label: null, progress: null, startedAt: null };
  emitLog();
  activityListeners.forEach((listener) => listener());
}
