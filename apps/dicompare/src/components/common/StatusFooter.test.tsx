import { act, render, screen } from '@testing-library/react';
import { ActivityStatusFooter } from './StatusFooter';
import { beginActivity, installConsoleCapture, logError, resetTechnicalLog } from '../../utils/technicalLog';

beforeEach(resetTechnicalLog);

test('the read-only viewer reports errors without processing or Python providers', () => {
  render(<ActivityStatusFooter />);
  expect(screen.getByRole('status')).toHaveTextContent('Ready');
  act(() => logError('Copy DOI failed', new Error('Clipboard denied')));
  expect(screen.getByRole('status')).toHaveTextContent('Copy DOI failed: Clipboard denied');
  expect(screen.getByLabelText('Cancel')).not.toBeVisible();
});

test('a memory recovery notice delivered before Pyodide startup survives until a user workflow starts', () => {
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

  act(() => finishActivity());
  expect(status).toHaveTextContent('Ready · load DICOMs, a protocol or a schema');
  expect(status).not.toHaveClass('error');
});
