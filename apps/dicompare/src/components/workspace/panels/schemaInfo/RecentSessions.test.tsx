import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import RecentSessions from './RecentSessions';
import { getLogEntries, resetTechnicalLog } from '../../../../utils/technicalLog';
import StatusFooter from '../../../common/StatusFooter';
import TechnicalLog from '../../../common/TechnicalLog';

vi.mock('../../../../contexts/PyodideContext', () => ({
  usePyodide: () => ({ status: { isReady: true, isLoading: false, error: null } }),
}));
vi.mock('../../../../contexts/ProcessingContext', () => ({
  useProcessing: () => ({ isProcessing: false, processingProgress: null }),
}));

test('opening a session stays busy until its loader settles, then permits retry after failure', async () => {
  resetTechnicalLog();
  let fail: (reason: Error) => void = () => { throw new Error('session load did not start'); };
  const load = vi.fn<() => Promise<void>>()
    .mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }))
    .mockResolvedValueOnce(undefined);
  render(<><RecentSessions
    sessions={[{ id: 'saved', name: 'Saved session', createdAt: '2026-10-17', updatedAt: '2026-10-17', itemCount: 1, storageSize: 100 }]}
    isLoading={false}
    activeSessionId={null}
    onLoadSession={load}
    onDeleteSession={() => {}}
    onCreateNew={() => {}}
    onClearAll={() => {}}
  /><StatusFooter /><TechnicalLog /></>);
  fireEvent.click(screen.getByRole('button', { name: 'Open' }));
  expect(screen.getByRole('button', { name: 'Loading...' })).toBeDisabled();
  await act(async () => { fail(new Error('storage unavailable')); });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Open' })).toBeEnabled());
  expect(getLogEntries().map(entry => entry.message)).toEqual(['Session load failed: storage unavailable']);
  expect(document.getElementById('statusText')?.textContent).toBe('Session load failed: storage unavailable');
  expect(document.getElementById('technicalLogOutput')?.textContent).toContain('Session load failed: storage unavailable');
  fireEvent.click(screen.getByRole('button', { name: 'Open' }));
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Open' })).toBeEnabled());
});
