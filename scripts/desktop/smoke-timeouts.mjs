export const DEFAULT_STARTUP_TIMEOUT_MS = 3 * 60 * 1000;
export const DEFAULT_WORKFLOW_TIMEOUT_MS = 15 * 60 * 1000;
export const WORKFLOW_STARTUP_HEADROOM_MS = 2 * 60 * 1000;

// Sequential inner offline workflow budgets (example loading, run waits, downloads, and handoffs)
// that exceed DEFAULT_WORKFLOW_TIMEOUT_MS - WORKFLOW_STARTUP_HEADROOM_MS (13 min).
// The outer smoke deadline adds WORKFLOW_STARTUP_HEADROOM_MS for Electron launch and
// Standalone dialog checks so long multi-stage CPU pipelines are not killed early.
export const LONG_WORKFLOW_BUDGETS_MS = Object.freeze({
  ants: 22 * 60 * 1000,
  aurora: 34 * 60 * 1000,
  brain2print: 22 * 60 * 1000,
  brainqcnet: 19 * 60 * 1000,
  degibbs: 16 * 60 * 1000,
  dicomview: 21 * 60 * 1000,
  dwi2trx: 23 * 60 * 1000,
  dwicorrect: 22 * 60 * 1000,
  dwidenoise: 16 * 60 * 1000,
  edgereg: 22 * 60 * 1000,
  elastix: 22 * 60 * 1000,
  fastprep: 37 * 60 * 1000,
  fireants: 22 * 60 * 1000,
  gliomoda: 34 * 60 * 1000,
  greedy: 22 * 60 * 1000,
  hmc: 22 * 60 * 1000,
  'me-ica': 14 * 60 * 1000,
  n4: 16 * 60 * 1000,
  noddi: 16 * 60 * 1000,
  samsrf: 36 * 60 * 1000,
  sdc: 16 * 60 * 1000,
  seedseg: 14 * 60 * 1000,
  spinalcordtoolbox: 14 * 60 * 1000,
  syncro: 32 * 60 * 1000,
  topofit: 17 * 60 * 1000,
  totalsegmentator: 14 * 60 * 1000,
  'tumour-report': 14 * 60 * 1000,
  vesselboost: 14 * 60 * 1000,
  'white-matter-lesions': 27 * 60 * 1000,
});

const SYNCRO_NON_RUN_BUDGET_MS = 2 * 60 * 1000;

function positiveFiniteMs(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function resolveAppTimeoutMs(appId, { workflows = false, envTimeoutMs, syncroTimeoutMs } = {}) {
  const explicit = positiveFiniteMs(envTimeoutMs);
  if (explicit !== null) return explicit;
  if (!workflows) return DEFAULT_STARTUP_TIMEOUT_MS;
  let workflowBudgetMs = LONG_WORKFLOW_BUDGETS_MS[appId] ?? 0;
  if (appId === 'syncro') {
    const syncroOverride = positiveFiniteMs(syncroTimeoutMs);
    if (syncroOverride !== null) workflowBudgetMs = SYNCRO_NON_RUN_BUDGET_MS + syncroOverride;
  }
  return Math.max(DEFAULT_WORKFLOW_TIMEOUT_MS, workflowBudgetMs + WORKFLOW_STARTUP_HEADROOM_MS);
}

const TRANSIENT_ERROR_RE = /timed out|Target page, context or browser has been closed|electron\.launch|browser has been closed|EPIPE|ECONNRESET|net::ERR_/i;

export function isTransientDesktopFailure(
  error,
  { timedOut = false, workflows = false, timeoutMs = DEFAULT_WORKFLOW_TIMEOUT_MS } = {},
) {
  if (workflows && timedOut && timeoutMs > DEFAULT_WORKFLOW_TIMEOUT_MS) return false;
  const message = String(error?.message || error || '');
  return TRANSIENT_ERROR_RE.test(message);
}
