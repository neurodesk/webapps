import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_STARTUP_TIMEOUT_MS,
  DEFAULT_WORKFLOW_TIMEOUT_MS,
  LONG_WORKFLOW_BUDGETS_MS,
  WORKFLOW_STARTUP_HEADROOM_MS,
  isTransientDesktopFailure,
  resolveAppTimeoutMs,
} from '../../../scripts/desktop/smoke-timeouts.mjs';

test('resolveAppTimeoutMs scales long workflow budgets with headroom and respects explicit overrides', () => {
  assert.equal(resolveAppTimeoutMs('fastprep', { workflows: false }), DEFAULT_STARTUP_TIMEOUT_MS);
  assert.equal(resolveAppTimeoutMs('derm-compare', { workflows: true }), DEFAULT_WORKFLOW_TIMEOUT_MS);
  assert.equal(
    resolveAppTimeoutMs('fastprep', { workflows: true }),
    LONG_WORKFLOW_BUDGETS_MS.fastprep + WORKFLOW_STARTUP_HEADROOM_MS,
  );
  assert.equal(
    resolveAppTimeoutMs('samsrf', { workflows: true }),
    LONG_WORKFLOW_BUDGETS_MS.samsrf + WORKFLOW_STARTUP_HEADROOM_MS,
  );
  assert.equal(
    resolveAppTimeoutMs('me-ica', { workflows: true }),
    LONG_WORKFLOW_BUDGETS_MS['me-ica'] + WORKFLOW_STARTUP_HEADROOM_MS,
  );
  assert.equal(
    resolveAppTimeoutMs('vesselboost', { workflows: true }),
    LONG_WORKFLOW_BUDGETS_MS.vesselboost + WORKFLOW_STARTUP_HEADROOM_MS,
  );
  assert.equal(
    resolveAppTimeoutMs('white-matter-lesions', { workflows: true }),
    LONG_WORKFLOW_BUDGETS_MS['white-matter-lesions'] + WORKFLOW_STARTUP_HEADROOM_MS,
  );
  assert.equal(resolveAppTimeoutMs('fastprep', { workflows: true, envTimeoutMs: '450000' }), 450_000);
  assert.equal(resolveAppTimeoutMs('fastprep', { workflows: true, envTimeoutMs: '' }), 39 * 60 * 1000);
  assert.equal(resolveAppTimeoutMs('fastprep', { workflows: true, envTimeoutMs: '0' }), 39 * 60 * 1000);
  assert.equal(resolveAppTimeoutMs('fastprep', { workflows: true, envTimeoutMs: '-5' }), 39 * 60 * 1000);
  assert.equal(resolveAppTimeoutMs('fastprep', { workflows: true, envTimeoutMs: 'NaN' }), 39 * 60 * 1000);
  assert.equal(
    resolveAppTimeoutMs('syncro', { workflows: true, syncroTimeoutMs: '2400000' }),
    (2 + 40 + 2) * 60 * 1000,
  );
});

test('isTransientDesktopFailure skips retrying hard outer timeouts only on extended-budget workflow runs', () => {
  const extendedMs = resolveAppTimeoutMs('fastprep', { workflows: true });
  assert.equal(
    isTransientDesktopFailure(new Error('fastprep timed out after 2340s'), {
      timedOut: true,
      workflows: true,
      timeoutMs: extendedMs,
    }),
    false,
  );
  assert.equal(
    isTransientDesktopFailure(new Error('electron.launch: Timeout 60000ms exceeded'), {
      timedOut: false,
      workflows: true,
      timeoutMs: extendedMs,
    }),
    true,
  );
  assert.equal(
    isTransientDesktopFailure(new Error('niimath timed out after 900s'), {
      timedOut: true,
      workflows: true,
      timeoutMs: DEFAULT_WORKFLOW_TIMEOUT_MS,
    }),
    true,
  );
  // Startup-only runs with an explicit large NEURODESK_APP_TIMEOUT_MS keep their CI retry.
  assert.equal(
    isTransientDesktopFailure(new Error('niimath timed out after 1200s'), {
      timedOut: true,
      workflows: false,
      timeoutMs: 1_200_000,
    }),
    true,
  );
  assert.equal(
    isTransientDesktopFailure(new Error('Target page, context or browser has been closed'), {
      timedOut: false,
      workflows: true,
      timeoutMs: DEFAULT_WORKFLOW_TIMEOUT_MS,
    }),
    true,
  );
  assert.equal(
    isTransientDesktopFailure(new Error('AssertionError: expected 1 to equal 2'), {
      timedOut: false,
      workflows: true,
      timeoutMs: DEFAULT_WORKFLOW_TIMEOUT_MS,
    }),
    false,
  );
});
