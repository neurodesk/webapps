// The verified markers: GitHub Actions cache entries whose key says that a
// site, at a content digest, passed the deployed checks whose inputs hash to a
// given value (scripts/lib/site-deploy.mjs). The plan looks a marker up, the
// check job saves it after the checks pass, and deletes it when one fails.
// It uses only Node built-ins, so a check job need not install the workspace.
import { exchange, message } from './site-record.mjs';

// Each read or delete of a marker ends at this deadline.
const MARKER_TIMEOUT_MS = 30_000;

async function cacheRequest({ method = 'GET', key, repository, ref, token, apiUrl = 'https://api.github.com', fetch = globalThis.fetch, timeoutMs = MARKER_TIMEOUT_MS }) {
  if (!key || !repository || !ref || !token) throw new Error('no key, repository, ref or token');
  return exchange(timeoutMs, 'GitHub API: ', async ({ signal, within }) => {
    const query = new URLSearchParams(method === 'GET' ? { key, ref, per_page: '100' } : { key, ref });
    const headers = { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' };
    const response = await within(fetch(`${apiUrl}/repos/${repository}/actions/caches?${query}`, { method, headers, signal }));
    const text = await within(response.text());
    return { status: response.status, text };
  });
}

/**
 * Whether the verified marker `key` exists in the Actions cache of `ref`:
 * `{ present }`, or `{ error }`, never a throw. The REST API matches `key` as a
 * prefix, so an entry counts only when its key and its ref are both equal. An
 * answer with more than one page of matches is unknown, even with a match on it.
 */
export async function readMarker(request) {
  try {
    const { status, text } = await cacheRequest(request);
    if (status !== 200) throw new Error(`GitHub API: HTTP ${status}`);
    const answer = JSON.parse(text);
    if (!Number.isSafeInteger(answer?.total_count) || !Array.isArray(answer.actions_caches)) throw new Error('GitHub API: no cache list');
    if (answer.total_count > answer.actions_caches.length) throw new Error(`GitHub API: ${answer.total_count} caches match, more than one page`);
    return { present: answer.actions_caches.some((entry) => entry?.key === request.key && entry?.ref === request.ref) };
  } catch (error) {
    return { error: message(error) };
  }
}

/**
 * Delete the verified marker `key` of `ref`: `{ deleted }`, the number of
 * entries the API deleted, or `{ error }`, never a throw. The API deletes by
 * complete key and ref. It documents only HTTP 200; a 404 counts as nothing to
 * delete only when a lookup then finds no marker.
 */
export async function deleteMarker(request) {
  try {
    const { status, text } = await cacheRequest({ ...request, method: 'DELETE' });
    if (status === 200) {
      const deleted = JSON.parse(text)?.total_count;
      if (!Number.isSafeInteger(deleted)) throw new Error('GitHub API: no list of deleted caches');
      return { deleted };
    }
    if (status !== 404) throw new Error(`GitHub API: HTTP ${status}`);
    const after = await readMarker(request);
    if (after.error) throw new Error(`HTTP 404, then the marker could not be looked up (${after.error})`);
    if (after.present) throw new Error('HTTP 404, but the marker is still listed');
    return { deleted: 0 };
  } catch (error) {
    return { error: message(error) };
  }
}
