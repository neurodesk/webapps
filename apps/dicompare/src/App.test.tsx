import React from 'react';
import { act, render, screen } from '@testing-library/react';
import App from './App';
import TechnicalLog from './neurodesk/TechnicalLog';
import { log, resetTechnicalLog } from './utils/technicalLog';

beforeEach(() => {
  resetTechnicalLog();
});

test('the workspace is the first screen', async () => {
  await act(async () => {
    render(<App />);
  });

  expect(screen.getByRole('heading', { name: /^workspace$/i })).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: /open workspace/i })).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: /schema library/i })).toBeInTheDocument();
});

test('status sits in the shared footer with elapsed time, progress and a hidden cancel', async () => {
  await act(async () => {
    render(<App />);
  });

  const footer = document.querySelector('footer#status');
  expect(footer).not.toBeNull();
  expect(footer?.querySelector('#statusText.nd-status-text')).not.toBeNull();
  expect(footer?.querySelector('#elapsed')).not.toBeNull();
  expect(footer?.querySelector('progress#progress')).not.toBeNull();
  expect((footer?.querySelector('#cancelButton') as HTMLButtonElement).hidden).toBe(true);
});

test('the technical log starts collapsed with Copy and Clear', async () => {
  // Rendered alone: in jsdom the full app logs a real error when the analysis
  // engine cannot start, and errors open the log by design.
  await act(async () => {
    render(<TechnicalLog />);
  });

  const console = document.getElementById('technicalLog');
  expect(console).not.toBeNull();
  expect(console?.classList.contains('nd-console-container')).toBe(true);
  expect(console?.classList.contains('collapsed')).toBe(true);
  expect(document.getElementById('technicalLogCopy')).not.toBeNull();
  expect(document.getElementById('technicalLogClear')).not.toBeNull();
});

test('the technical log mirrors log entries and opens on errors', async () => {
  await act(async () => {
    render(<App />);
  });

  const console = document.getElementById('technicalLog');

  await act(async () => {
    log('Loaded 3 library schema(s).');
    log('Validation of T1w failed: bad schema', 'error');
  });

  const output = document.getElementById('technicalLogOutput');
  expect(output?.textContent).toContain('Loaded 3 library schema(s).');
  expect(output?.textContent).toContain('Validation of T1w failed: bad schema');
  expect(console?.classList.contains('collapsed')).toBe(false);
  expect(document.getElementById('statusText')?.textContent).toBe('Validation of T1w failed: bad schema');
  expect(document.getElementById('statusText')?.classList.contains('error')).toBe(true);
});
