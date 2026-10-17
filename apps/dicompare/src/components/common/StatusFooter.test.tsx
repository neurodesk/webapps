import { act, render, screen } from '@testing-library/react';
import { ActivityStatusFooter } from './StatusFooter';
import { logError, resetTechnicalLog } from '../../utils/technicalLog';

beforeEach(resetTechnicalLog);

test('the read-only viewer reports errors without processing or Python providers', () => {
  render(<ActivityStatusFooter />);
  expect(screen.getByRole('status')).toHaveTextContent('Ready');
  act(() => logError('Copy DOI failed', new Error('Clipboard denied')));
  expect(screen.getByRole('status')).toHaveTextContent('Copy DOI failed: Clipboard denied');
  expect(screen.getByLabelText('Cancel')).not.toBeVisible();
});
