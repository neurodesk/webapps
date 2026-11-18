// The digest record each published site carries (DIGEST_FILE at its root), and
// how a deploy reads it back from the site's host. It uses only Node built-ins,
// so a job can confirm a host's digest without installing the workspace.

export const DIGEST_FILE = 'site-digest.json';
export const DIGEST_SCHEMA = 1;
// Each read of a live record ends at this deadline.
const RECORD_TIMEOUT_MS = 30_000;

const HEX64 = /^[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

/** A calendar instant that reads back as written: 2026-02-31 or 24:00 is refused, not moved to another day. */
export const isInstant = (value) => typeof value === 'string'
  && ISO_INSTANT.test(value)
  && !Number.isNaN(Date.parse(value))
  && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);

export const message = (error) => String(error?.message ?? error);

/**
 * Run `read` under one deadline over a whole exchange: every request, its
 * headers and its body. `read` gets the signal to pass to fetch and `within`,
 * which settles with a promise or rejects when the deadline passes first. When
 * `read` settles, by any path, the request is aborted, so a body nobody read
 * cannot keep the process alive. The plain timer, unlike AbortSignal.timeout,
 * stays referenced, so a stalled read still ends.
 */
export async function exchange(ms, what, read) {
  const controller = new AbortController();
  let timer;
  const expired = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      const reason = new DOMException(`${what}no complete answer in ${ms / 1000} s`, 'TimeoutError');
      controller.abort(reason);
      reject(reason);
    }, ms);
  });
  expired.catch(() => {});
  try {
    return await read({ signal: controller.signal, within: (promise) => Promise.race([promise, expired]) });
  } finally {
    clearTimeout(timer);
    controller.abort(new DOMException(`${what}read finished`, 'AbortError'));
  }
}

/**
 * Parse a served DIGEST_FILE: `{ record }`, or `{ error }` saying why it cannot
 * be trusted. Every field the plan reads is checked here, so a record of the
 * wrong shape is unreadable instead of a throw later in the plan.
 */
export function parseLiveRecord(text, site) {
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    return { error: 'not JSON' };
  }
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return { error: 'not a JSON object' };
  if (record.schema !== DIGEST_SCHEMA) return { error: `schema ${JSON.stringify(record.schema)}, expected ${DIGEST_SCHEMA}` };
  if (record.site !== site) return { error: `it describes site ${JSON.stringify(record.site)}` };
  if (typeof record.digest !== 'string' || !HEX64.test(record.digest)) return { error: 'no content digest' };
  if (record.analyticsGeneratedAt !== null && !isInstant(record.analyticsGeneratedAt)) return { error: 'analyticsGeneratedAt is neither null nor an ISO instant' };
  if (record.commit !== null && !(typeof record.commit === 'string' && HEX40.test(record.commit))) return { error: 'commit is neither null nor a commit hash' };
  return { record };
}

/**
 * Read the digest record a host serves; any failure is an `{ error }`, never a
 * throw. Only a direct, uncached JSON answer counts: a redirect can lead to an
 * old copy elsewhere, and a cached copy can predate the last deploy.
 */
export async function readLiveRecord({ site, host, nonce, fetch = globalThis.fetch, timeoutMs = RECORD_TIMEOUT_MS }) {
  // A fresh query string keeps a CDN from answering with a copy cached before the last deploy.
  const url = `https://${host}/${DIGEST_FILE}?run=${encodeURIComponent(nonce)}`;
  try {
    return await exchange(timeoutMs, '', async ({ signal, within }) => {
      const init = { cache: 'no-store', redirect: 'manual', headers: { 'cache-control': 'no-cache' }, signal };
      const response = await within(fetch(url, init));
      if (response.status !== 200) return { error: `HTTP ${response.status}` };
      const age = response.headers.get('age');
      if (age !== null && Number(age.trim()) !== 0) return { error: `a cached copy (Age: ${age})` };
      const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      if (type !== 'application/json') return { error: `content type ${JSON.stringify(type)}` };
      return parseLiveRecord(await within(response.text()), site);
    });
  } catch (error) {
    return { error: message(error) };
  }
}
