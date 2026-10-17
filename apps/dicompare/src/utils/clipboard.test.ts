import { waitFor } from '@testing-library/react';
import { copyText } from './clipboard';
import { asyncCallback } from './asyncCallback';
import { getLogEntries, resetTechnicalLog } from './technicalLog';

beforeEach(resetTechnicalLog);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function clipboard(writeText: (text: string) => Promise<void>, legacyCopy: () => boolean) {
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn(legacyCopy) });
}

test('copies with the Clipboard API without invoking the fallback', async () => {
  const writeText = vi.fn(async () => {});
  clipboard(writeText, () => { throw new Error('fallback must not run'); });
  await expect(copyText('citation')).resolves.toBeUndefined();
  expect(writeText).toHaveBeenCalledWith('citation');
  expect(document.execCommand).not.toHaveBeenCalled();
  expect(document.querySelector('textarea')).toBeNull();
});

test('falls back to the selected text when the Clipboard API is denied', async () => {
  clipboard(async () => { throw new Error('permission denied'); }, () => {
    expect(document.getSelection()?.toString() || document.querySelector('textarea')?.value).toBe('schema link');
    return true;
  });
  await expect(copyText('schema link')).resolves.toBeUndefined();
  expect(document.execCommand).toHaveBeenCalledWith('copy');
  expect(document.querySelector('textarea')).toBeNull();
  expect(getLogEntries()).toEqual([]);
});

test.each(['false', 'throw'])('reports a failed legacy copy (%s) through the callback boundary', async (failure) => {
  clipboard(async () => { throw new Error('permission denied'); }, () => {
    if (failure === 'throw') throw new Error('legacy clipboard unavailable');
    return false;
  });
  let copied = false;
  asyncCallback('Copy schema link failed', async () => {
    await copyText('schema link');
    copied = true;
  })();
  await waitFor(() => expect(getLogEntries()).toEqual([
    expect.objectContaining({ level: 'error', message: expect.stringContaining('Copy schema link failed:') }),
  ]));
  expect(copied).toBe(false);
  expect(document.querySelector('textarea')).toBeNull();
});
