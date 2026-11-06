import React from 'react';
import { act, render, screen } from '@testing-library/react';
import App from './App';
import TechnicalLog from './components/common/TechnicalLog';
import { log, resetTechnicalLog } from './utils/technicalLog';

beforeEach(() => {
  resetTechnicalLog();
  window.history.replaceState(null, '', '/');
});

const renderAt = async (path: string) => {
  window.history.replaceState(null, '', path);
  await act(async () => {
    render(<App />);
  });
};

test('the landing page is the first screen and links to the workspace and schema library', async () => {
  await renderAt('/');

  expect(screen.getByRole('heading', { name: /mri protocol validation/i })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /open workspace/i })).toHaveAttribute('href', '/workspace');
  const main = screen.getByRole('main');
  expect(main.querySelector('a[href="/schema"]')).not.toBeNull();
  const navigation = screen.getByRole('navigation', { name: 'dicompare' });
  expect(navigation.querySelector('a[href="/schema"]')).not.toBeNull();
  expect(navigation.textContent).toMatch(/dicompare-web v\d+\.\d+\.\d+/);
});

test('the workspace is at /workspace with the dicompare navigation', async () => {
  await renderAt('/workspace');

  expect(screen.getByRole('heading', { name: /^workspace$/i })).toBeInTheDocument();
  const navigation = screen.getByRole('navigation', { name: 'dicompare' });
  expect(navigation.querySelector('a[href="/schema"]')).not.toBeNull();
  expect(navigation.querySelector('a[href="/"]')).not.toBeNull();
});

test('status sits in the shared footer with elapsed time, progress and a hidden cancel', async () => {
  await renderAt('/workspace');

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
  await renderAt('/workspace');

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
