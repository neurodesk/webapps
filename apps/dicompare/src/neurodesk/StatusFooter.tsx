import { useEffect, useRef, useState } from 'react';
import { usePyodide } from '../contexts/PyodideContext';
import { useProcessing } from '../contexts/ProcessingContext';
import { LogEntry, useActivity, useTechnicalLog } from '../utils/technicalLog';

function newestError(entries: LogEntry[]): LogEntry | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index].level === 'error') return entries[index];
  }
  return null;
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

interface FooterState {
  message: string;
  progress: number | null;
  running: boolean;
  error: boolean;
}

/**
 * Shared status footer: the current operation, elapsed time while running,
 * a native progress bar and a cancel button. dicompare's Pyodide start-up,
 * DICOM analysis and validation cannot be interrupted, so the cancel button
 * stays hidden.
 */
export default function StatusFooter() {
  const { status: pyodide } = usePyodide();
  const { isProcessing, processingProgress } = useProcessing();
  const activity = useActivity();
  const entries = useTechnicalLog();
  const [now, setNow] = useState(() => Date.now());
  const startedAt = useRef<number | null>(null);
  const errorFloor = useRef(0);
  const text = useRef<HTMLSpanElement>(null);
  const entriesRef = useRef(entries);
  entriesRef.current = entries;

  const running = pyodide.isLoading || isProcessing || activity.label !== null;
  // The newest error stays visible until the next operation starts.
  const candidate = newestError(entries);
  const lastError = candidate && candidate.id > errorFloor.current ? candidate : null;

  useEffect(() => {
    if (!running) {
      startedAt.current = null;
      return undefined;
    }
    const list = entriesRef.current;
    errorFloor.current = list.length ? list[list.length - 1].id : errorFloor.current;
    startedAt.current = Date.now();
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  let state: FooterState;
  if (isProcessing) {
    state = {
      message: processingProgress?.currentOperation || 'Processing files…',
      progress: processingProgress ? processingProgress.percentage / 100 : null,
      running: true,
      error: false,
    };
  } else if (activity.label) {
    state = { message: `${activity.label}…`, progress: activity.progress, running: true, error: false };
  } else if (pyodide.isLoading) {
    state = {
      message: `Preparing analysis engine · ${Math.round(pyodide.progress)}%`,
      progress: pyodide.progress / 100,
      running: true,
      error: false,
    };
  } else if (lastError) {
    state = { message: lastError.message, progress: 0, running: false, error: true };
  } else if (pyodide.error) {
    state = { message: `Analysis engine unavailable: ${pyodide.error}`, progress: 0, running: false, error: true };
  } else {
    state = {
      message: pyodide.isReady ? 'Ready · load DICOMs, a protocol or a schema' : 'Starting…',
      progress: pyodide.isReady ? 1 : 0,
      running: false,
      error: false,
    };
  }

  const elapsed = running && startedAt.current !== null ? formatElapsed(now - startedAt.current) : '';
  useEffect(() => {
    text.current?.classList.toggle('error', state.error);
  });

  const progressValue = state.progress === null ? undefined : Math.max(0, Math.min(1, state.progress));

  return (
    <footer id="status" className="nd-imaging-status sticky bottom-0 z-40">
      <span className="nd-status-label">Status</span>
      <span
        id="statusText"
        ref={text}
        className="nd-status-text"
        role="status"
        aria-live="polite"
      >
        {state.message}
      </span>
      <span id="elapsed" className="nd-status-elapsed">{elapsed}</span>
      <progress id="progress" max={1} value={progressValue} aria-label="Progress" />
      <button
        id="cancelButton"
        type="button"
        className="nd-btn-cancel"
        title="Cancel"
        aria-label="Cancel"
        hidden
      >
        ×
      </button>
    </footer>
  );
}
