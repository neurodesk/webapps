/**
 * The requests a browser context has sent and not seen end, oldest first,
 * so a failure can name what the page was still waiting for.
 */
export function trackPendingRequests(context, now = Date.now) {
  const started = new Map();
  context.on('request', request => started.set(request, now()));
  context.on('requestfinished', request => started.delete(request));
  context.on('requestfailed', request => started.delete(request));
  return {
    describe(limit = 10) {
      const open = [...started].map(([request, since]) => `${request.url()} (open ${Math.round((now() - since) / 1000)} s)`);
      if (!open.length) return '';
      return `Unfinished requests: ${open.slice(0, limit).join(', ')}${open.length > limit ? `, and ${open.length - limit} more` : ''}`;
    },
  };
}

/**
 * Bounds one audited page. When `ms` pass, records what was still open and calls `close`,
 * which must make the caller's pending browser calls reject (closing the context does).
 * The caller reports `failure` instead of the rejection it then catches.
 */
export function startDeadline(ms, { pending, close }) {
  let failure = null;
  const timer = setTimeout(() => {
    failure = `No result within the ${Math.round(ms / 1000)} s deadline for one app and width; ${pending.describe() || 'no request was open'}`;
    Promise.resolve().then(close).catch(() => {});
  }, ms);
  return {
    get failure() {
      return failure;
    },
    clear: () => clearTimeout(timer),
  };
}
