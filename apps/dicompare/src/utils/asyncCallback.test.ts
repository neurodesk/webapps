import { waitFor } from '@testing-library/react';
import { asyncCallback } from './asyncCallback';
import { getLogEntries, resetTechnicalLog } from './technicalLog';

beforeEach(resetTechnicalLog);

test('a synchronous event callback forwards its arguments and reports a later rejection', async () => {
  const argumentsSeen: string[] = [];
  const callback = asyncCallback('Upload failed', async (name: string) => {
    argumentsSeen.push(name);
    await Promise.resolve();
    throw new Error('worker unavailable');
  });
  expect(callback('scan.dcm')).toBeUndefined();
  expect(argumentsSeen).toEqual(['scan.dcm']);
  await waitFor(() => expect(getLogEntries().map(entry => [entry.level, entry.message]))
    .toEqual([['error', 'Upload failed: worker unavailable']]));
});

test('synchronous failures use the same user-visible error path', () => {
  const callback = asyncCallback('Save failed', () => { throw new Error('storage denied'); });
  callback();
  expect(getLogEntries().map(entry => entry.message)).toEqual(['Save failed: storage denied']);
});

test('successful void and promise callbacks do not report errors', async () => {
  const results: string[] = [];
  asyncCallback('Navigation failed', () => { results.push('navigation'); })();
  asyncCallback('Save failed', async () => {
    await Promise.resolve();
    results.push('save');
  })();
  await waitFor(() => expect(results).toEqual(['navigation', 'save']));
  expect(getLogEntries()).toEqual([]);
});
