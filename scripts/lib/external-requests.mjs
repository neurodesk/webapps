/**
 * Records the requests a browser context makes to other hosts than `origin`,
 * and tells which of them depended on the network.
 */
export function trackExternalRequests(context, origin) {
  const external = [];
  const pending = new Set();
  const answeredHere = new WeakSet();
  const responded = new WeakSet();
  const failed = new WeakSet();
  const started = new WeakMap();
  const outcomes = new WeakMap();
  const settle = (request, outcome) => Promise.resolve(outcome === 'finished' ? request.sizes().catch(() => null) : null).then(sizes => {
    outcomes.set(request, { outcome, ms: Date.now() - started.get(request), bytes: sizes?.responseBodySize ?? null });
  });
  context.on('request', request => {
    if (!/^https?:/.test(request.url()) || new URL(request.url()).origin === origin) return;
    external.push(request);
    started.set(request, Date.now());
  });
  context.on('requestfinished', request => {
    if (started.has(request)) pending.add(settle(request, 'finished'));
  });
  context.on('response', response => {
    responded.add(response.request());
    if (response.fromServiceWorker()) answeredHere.add(response.request());
  });
  context.on('requestfailed', request => {
    failed.add(request);
    if (started.has(request)) pending.add(settle(request, request.failure()?.errorText ?? 'failed'));
  });
  return {
    // A route that fulfils a request itself reports it here.
    answered: request => answeredHere.add(request),
    // Every counted request with its body size as transferred and the time until it ended.
    // A request with no outcome was still open when this was read.
    async log() {
      await Promise.all(pending);
      return this.sentRequests().map(request => ({
        url: request.url(),
        ...(outcomes.get(request) ?? { outcome: 'unfinished', ms: Date.now() - started.get(request), bytes: null }),
      }));
    },
    sent() {
      return this.sentRequests().map(request => new URL(request.url()));
    },
    sentRequests() {
      // A page request its service worker handles is seen again as the worker's own fetch,
      // and only that fetch can reach the network. The page's copy says so in its response;
      // one cancelled before any response is known by the worker's fetch of the same URL.
      const workerFetched = new Set(external.filter(request => request.serviceWorker()).map(request => request.url()));
      const cancelledCopy = request => failed.has(request) && !responded.has(request) && !request.serviceWorker() && workerFetched.has(request.url());
      return external.filter(request => !answeredHere.has(request) && !cancelledCopy(request));
    },
  };
}
