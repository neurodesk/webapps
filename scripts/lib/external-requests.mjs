/**
 * Records the requests a browser context makes to other hosts than `origin`,
 * and tells which of them depended on the network.
 */
export function trackExternalRequests(context, origin) {
  const external = [];
  const answeredHere = new WeakSet();
  const responded = new WeakSet();
  const failed = new WeakSet();
  context.on('request', request => {
    if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== origin) external.push(request);
  });
  context.on('response', response => {
    responded.add(response.request());
    if (response.fromServiceWorker()) answeredHere.add(response.request());
  });
  context.on('requestfailed', request => failed.add(request));
  return {
    // A route that fulfils a request itself reports it here.
    answered: request => answeredHere.add(request),
    sent() {
      // A page request its service worker handles is seen again as the worker's own fetch,
      // and only that fetch can reach the network. The page's copy says so in its response;
      // one cancelled before any response is known by the worker's fetch of the same URL.
      const workerFetched = new Set(external.filter(request => request.serviceWorker()).map(request => request.url()));
      const cancelledCopy = request => failed.has(request) && !responded.has(request) && !request.serviceWorker() && workerFetched.has(request.url());
      return external.filter(request => !answeredHere.has(request) && !cancelledCopy(request)).map(request => new URL(request.url()));
    },
  };
}
