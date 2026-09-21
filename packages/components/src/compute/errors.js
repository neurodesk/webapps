// Error types and explanations for the remote compute client.

export class ComputeError extends Error {
  constructor(code, message, { status = 0, job = null } = {}) {
    super(message);
    this.name = 'ComputeError';
    this.code = code;
    this.status = status;
    this.job = job;
  }
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Turn what a user typed into an origin. Accepts `host`, `host:port`,
 * `https://host:port/`, and strips any `/api/v1` suffix. A bare host gets
 * `https://`, loopback hosts get `http://`, and the default port is 8765.
 */
export function normalizeBaseUrl(input) {
  const text = String(input ?? '').trim();
  if (!text) throw new ComputeError('invalid-address', 'Enter the address of a compute server');
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `${LOOPBACK.has(text.split(':')[0]) ? 'http' : 'https'}://${text}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw new ComputeError('invalid-address', `"${text}" is not a valid server address`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new ComputeError('invalid-address', 'The server address must start with http:// or https://');
  if (!url.port && !/^[a-z][a-z0-9+.-]*:\/\/[^/]+:\d+/i.test(withScheme)) url.port = '8765';
  const path = url.pathname.replace(/\/api\/v1\/?$/, '').replace(/\/+$/, '');
  return `${url.protocol}//${url.host}${path}`;
}

export function isLoopback(baseUrl) {
  try {
    return LOOPBACK.has(new URL(baseUrl).hostname) || LOOPBACK.has(`[${new URL(baseUrl).hostname}]`);
  } catch {
    return false;
  }
}

/**
 * Explain a failed connection in words a clinician can act on. Browsers report
 * blocked mixed content, untrusted certificates and unreachable hosts with the
 * same opaque TypeError, so the explanation is derived from the two origins.
 */
export function describeConnectionError(error, { pageOrigin = '', baseUrl = '' } = {}) {
  if (error instanceof ComputeError && error.code === 'invalid-address') return { code: error.code, message: error.message };
  if (error?.name === 'AbortError') return { code: 'cancelled', message: 'Connection cancelled' };
  if (error instanceof ComputeError && error.status === 401) {
    return { code: 'unauthorized', message: 'The server rejected the access token. Copy the token printed when the server started.' };
  }
  if (error instanceof ComputeError && error.status) {
    return { code: error.code, message: `The server answered with an error: ${error.message}` };
  }
  let page = null;
  let target = null;
  try {
    page = pageOrigin ? new URL(pageOrigin) : null;
    target = baseUrl ? new URL(baseUrl) : null;
  } catch {
    page = null;
  }
  if (page?.protocol === 'https:' && target?.protocol === 'http:' && !isLoopback(baseUrl)) {
    return {
      code: 'mixed-content',
      message: `This page is served over HTTPS, so the browser blocks a plain http:// server at ${target.host}. `
        + 'Start the server with its HTTPS address (it makes its own certificate) or open the app from the server\'s own address.',
    };
  }
  if (target?.protocol === 'https:') {
    return {
      code: 'unreachable',
      message: `Could not reach ${target.host}. If the server uses its own certificate, open ${baseUrl}/api/v1/info in a new tab once, `
        + 'accept the certificate, then connect again. Otherwise check the address, port and firewall.',
    };
  }
  return {
    code: 'unreachable',
    message: `Could not reach ${target?.host || 'the server'}. Check that neurodesk-compute is running and that the address, port and firewall allow this connection.`,
  };
}
