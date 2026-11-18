import { act, render, screen } from '@testing-library/react';
import { ActivityStatusFooter } from './StatusFooter';
import { DicompareWorkerAPI } from '../../services/DicompareWorkerAPI';
import { beginActivity, installConsoleCapture, logError, resetTechnicalLog } from '../../utils/technicalLog';

beforeEach(resetTechnicalLog);

test('the read-only viewer reports errors without processing or Python providers', () => {
  render(<ActivityStatusFooter />);
  expect(screen.getByRole('status')).toHaveTextContent('Ready');
  act(() => logError('Copy DOI failed', new Error('Clipboard denied')));
  expect(screen.getByRole('status')).toHaveTextContent('Copy DOI failed: Clipboard denied');
  expect(screen.getByLabelText('Cancel')).not.toBeVisible();
});

test('a memory recovery notice delivered before Pyodide startup survives until a user workflow starts, and live workflow OOMs stay visible', () => {
  installConsoleCapture(window);
  const statusNotice = 'Page reloaded mid-run (likely low memory). Try a smaller input, close other tabs, or use Standalone.';
  window.dispatchEvent(new CustomEvent('neurodesk-memory-notice', {
    detail: {
      status: statusNotice,
      log: 'Error: This page reloaded before processing finished (Validating DICOMs), which commonly happens on phones when browser memory runs out.',
    },
  }));

  const { rerender } = render(
    <ActivityStatusFooter pyodide={{ isLoading: false, isReady: false, progress: 0, currentOperation: '', error: null }} />,
  );

  // Automatic Pyodide startup begins after the shell dispatched the recovery notice.
  rerender(<ActivityStatusFooter pyodide={{ isLoading: true, isReady: false, progress: 45, currentOperation: 'Loading Python', error: null }} />);
  expect(screen.getByRole('status')).toHaveTextContent('Preparing analysis engine · 45%');

  // Once Pyodide finishes starting, the recovery notice is still surfaced with error styling.
  rerender(<ActivityStatusFooter pyodide={{ isLoading: false, isReady: true, progress: 100, currentOperation: '', error: null }} />);
  const status = screen.getByRole('status');
  expect(status).toHaveTextContent(statusNotice);
  expect(status).toHaveClass('error');

  // Starting a user workflow clears the recovery notice cleanly.
  let finishActivity!: () => void;
  act(() => {
    finishActivity = beginActivity('Validating DICOM session');
  });
  expect(status).toHaveTextContent('Validating DICOM session…');
  expect(status).not.toHaveClass('error');

  // An OOM during the active workflow surfaces immediately instead of hiding behind the activity label!
  act(() => {
    logError('Unexpected error', new RangeError('Out of memory'));
  });
  expect(status).toHaveTextContent('Out of browser memory on this device');
  expect(status).toHaveClass('error');

  act(() => finishActivity());
  expect(status).toHaveTextContent('Out of browser memory on this device');
  expect(status).toHaveClass('error');

  // An OOM logged in the SAME React batch as workflow start is NOT swallowed by the floor cutoff!
  let finishSameBatch!: () => void;
  act(() => {
    finishSameBatch = beginActivity('Validating second session');
    logError('Validation', new RangeError('Array buffer allocation failed'));
  });
  expect(status).toHaveTextContent('Out of browser memory on this device');
  expect(status).toHaveClass('error');

  act(() => finishSameBatch());
  expect(status).toHaveTextContent('Out of browser memory on this device');
  expect(status).toHaveClass('error');
});

test('silent post-startup DicompareWorkerAPI crashes and message errors translate into memory guidance', async () => {
  installConsoleCapture(window);
  const workers: Array<{
    onmessage: ((event: MessageEvent) => void) | null;
    onerror: ((event: ErrorEvent) => void) | null;
    onmessageerror: ((event: MessageEvent) => void) | null;
    postMessage: () => void;
    terminate: () => void;
  }> = [];
  const OriginalWorker = globalThis.Worker;
  globalThis.Worker = class {
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    onmessageerror: ((event: MessageEvent) => void) | null = null;
    postMessage() {}
    terminate() {}
    constructor() { workers.push(this); }
  } as unknown as typeof Worker;

  try {
    render(<ActivityStatusFooter pyodide={{ isLoading: false, isReady: true, progress: 100, currentOperation: '', error: null }} />);
    const api = new DicompareWorkerAPI();
    const pendingInit = api.ensureInitialized();
    workers[0].onmessage?.({ data: { type: 'ready', payload: {} } } as MessageEvent);
    act(() => {
      workers[0].onerror?.({ message: '' } as ErrorEvent);
    });
    await expect(pendingInit).rejects.toThrow(/stopped unexpectedly \(often low device memory\)/);
    expect(screen.getByRole('status')).toHaveTextContent('Processing stopped unexpectedly (often low memory)');
    expect(screen.getByRole('status')).toHaveClass('error');

    const secondRequest = api.ensureInitialized();
    act(() => {
      workers[1].onmessageerror?.({} as MessageEvent);
    });
    await expect(secondRequest).rejects.toThrow(/could not be deserialized \(often low device memory\)/);
  } finally {
    globalThis.Worker = OriginalWorker;
  }
});
