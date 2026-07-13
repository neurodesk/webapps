import React from 'react';
import { act, render, screen } from '@testing-library/react';
import App from './App';

test('renders the landing page', async () => {
  await act(async () => {
    render(<App />);
  });

  expect(screen.getByRole('heading', { name: /dicompare/i })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /open workspace/i })).toBeInTheDocument();
});
