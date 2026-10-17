import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import VolumeThumbnail from './VolumeThumbnail';
import { getVolumeThumbnail } from '../../utils/niivueThumbnail';
import { getLogEntries, resetTechnicalLog } from '../../utils/technicalLog';

vi.mock('../../utils/niivueThumbnail', () => ({ getVolumeThumbnail: vi.fn() }));

beforeEach(() => {
  resetTechnicalLog();
  vi.mocked(getVolumeThumbnail).mockReset();
});

test('a failed preview stops loading and reports the rejection', async () => {
  vi.mocked(getVolumeThumbnail).mockRejectedValue(new Error('worker failed'));
  const { container } = render(<VolumeThumbnail url="scan.nii" />);
  await waitFor(() => expect(container.querySelector('.animate-spin')).toBeNull());
  expect(getLogEntries().map(entry => entry.message)).toEqual(['Volume preview failed: worker failed']);
});

test('a superseded preview cannot report a false error or replace the current image', async () => {
  let rejectOld: (reason: Error) => void = () => { throw new Error('old preview did not start'); };
  vi.mocked(getVolumeThumbnail)
    .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject; }))
    .mockResolvedValueOnce('data:image/png;base64,new');
  const { rerender } = render(<VolumeThumbnail url="old.nii" />);
  rerender(<VolumeThumbnail url="new.nii" />);
  await waitFor(() => expect(screen.getByAltText('Volume preview').getAttribute('src')).toBe('data:image/png;base64,new'));
  await act(async () => { rejectOld(new Error('old worker stopped')); });
  expect(getLogEntries()).toEqual([]);
  expect(screen.getByAltText('Volume preview').getAttribute('src')).toBe('data:image/png;base64,new');
});
