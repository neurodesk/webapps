const [current, total] = (process.env.NEURODESK_E2E_SHARD || '').split('/').map(Number);
// Pull requests and pushes to main leave out @slow tests (NEURODESK_E2E_SKIP_SLOW), and
// @heavy ones for an app a change reaches only through shared code (NEURODESK_E2E_SKIP_HEAVY).
const skipped = [
  process.env.NEURODESK_E2E_SKIP_SLOW === '1' && '@slow',
  process.env.NEURODESK_E2E_SKIP_HEAVY === '1' && '@heavy',
].filter(Boolean);
export const e2eTier = {
  ...(skipped.length ? { grepInvert: new RegExp(skipped.join('|')) } : {}),
  ...(total > 1 ? { shard: { current, total } } : {}),
};
