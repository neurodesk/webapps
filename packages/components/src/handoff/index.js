// Passes files from one app to another on the same site. The sender stores them in IndexedDB
// and navigates to the receiver with the entry's id in the hash; the receiver claims the entry,
// copies the files out and deletes it before it loads them, so an entry exists only between
// send and receive. The sender stores Blobs as they are, never reading them into memory.
// Self-contained: the app shell imports this file directly to sweep expired entries.

const DATABASE = 'neurodesk-handoff';
const STORE = 'entries';
const PARAM = 'handoff=';
const CLAIM = 'claimed:';
const SECRET = 'neurodesk-handoff:';

// One navigation is all an entry has to survive.
export const HANDOFF_TTL_MS = 2 * 60 * 1000;
// How long a receiver waits for the isolation service worker to decide whether it reloads.
const RELOAD_DECISION_MS = 10 * 1000;

function hashParams(hash) {
  return String(hash).replace(/^#/, '').split('&').filter(Boolean);
}

export function handoffId(hash) {
  return hashParams(hash).find((param) => param.startsWith(PARAM))?.slice(PARAM.length) || null;
}

// Other fragment parameters are kept byte for byte.
export function withoutHandoff(hash) {
  const rest = hashParams(hash).filter((param) => param !== 'handoff' && !param.startsWith(PARAM));
  return rest.length ? `#${rest.join('&')}` : '';
}

// A clock set back since sending also expires the entry rather than extending its life.
export function isExpired(entry, now = Date.now()) {
  return !(now >= entry.createdAt && now - entry.createdAt < HANDOFF_TTL_MS);
}

// The app path a page belongs to: the last segment of its base directory, as sendHandoff names targets.
export function appPath(baseURI) {
  return new URL('.', baseURI).pathname.split('/').filter(Boolean).at(-1) ?? '';
}

// The apps of the site another app can open with its data, in title order, without the page's
// own: the shell's app information lists them from the registry. `receives` is the form an app
// takes, 'nifti' or 'dicom'.
export function handoffTargets(document = globalThis.document) {
  let catalog = [];
  try {
    catalog = JSON.parse(document.querySelector('script[data-neurodesk-app-information]')?.textContent || '{}').catalog ?? [];
  } catch { /* no catalog: nothing to offer */ }
  const own = appPath(document.baseURI);
  return catalog.filter((app) => app.path !== own).sort((a, b) => a.title.localeCompare(b.title));
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' });
    let blocked = false;
    request.onblocked = () => {
      blocked = true;
      reject(new Error('Another tab of this site holds an older handoff store open. Close it and try again.'));
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      if (blocked) return request.result.close();
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}

async function transact(mode, work) {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE, mode);
    const request = work(transaction.objectStore(STORE));
    await new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      // A failed request's error bubbles here first; an abort without one still rejects.
      transaction.onerror = (event) => reject(event.target.error);
      transaction.onabort = () => reject(transaction.error ?? new DOMException('The transaction was aborted', 'AbortError'));
    });
    return request?.result;
  } finally {
    database.close();
  }
}

async function databaseExists() {
  if (!indexedDB.databases) return true;
  try {
    return (await indexedDB.databases()).some(({ name }) => name === DATABASE);
  } catch {
    return true;
  }
}

export async function sweepHandoffs() {
  // Opening the database creates it; a page that never handed anything off leaves none behind.
  if (!await databaseExists()) return;
  await transact('readwrite', (store) => {
    store.openCursor().onsuccess = ({ target }) => {
      const cursor = target.result;
      if (!cursor) return;
      // Read the clock per entry: one another tab committed after the sweep began is newer than its start.
      if (isExpired(cursor.value)) cursor.delete();
      cursor.continue();
    };
  });
}

async function digest(secret) {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret)));
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function forget(id) {
  return transact('readwrite', (store) => {
    store.delete(id);
    store.delete(`${CLAIM}${id}`);
  });
}

// The entry can be claimed only by presenting a secret kept in sessionStorage, which follows
// the tab to the target app but is gone once the browser restarts without restoring the session.
export async function sendHandoff({ target, source, files, document = globalThis.document, signal }) {
  const destination = new URL(`../${target}/`, document.baseURI);
  // Each app has its own origin under a development server, where the target is not there to open.
  let response;
  try {
    response = await fetch(destination, { method: 'HEAD', signal: AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : [])]) });
  } catch {
    signal?.throwIfAborted();
    throw new Error(`${destination.pathname} could not be reached. Download the image instead.`);
  }
  if (!response.ok) throw new Error(`${destination.pathname} is not served beside this app. Download the image instead.`);
  signal?.throwIfAborted();
  const id = crypto.randomUUID();
  const key = `${SECRET}${id}`;
  const storage = document.defaultView.sessionStorage;
  try {
    await sweepHandoffs();
    const secret = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, '0')).join('');
    storage.setItem(key, secret);
    const proof = await digest(secret);
    signal?.throwIfAborted();
    const entry = {
      id,
      createdAt: Date.now(),
      target,
      source,
      proof,
      files: files.map((file) => ({ name: file.name, type: file.type, blob: file })),
    };
    await transact('readwrite', (store) => store.put(entry));
    signal?.throwIfAborted();
    destination.hash = `${PARAM}${id}`;
    document.location.assign(destination.href);
  } catch (error) {
    try { storage.removeItem(key); } catch { /* the storage that failed holds no secret */ }
    await forget(id).catch(() => {});
    if (error?.name === 'AbortError') throw error;
    const reason = error?.name === 'QuotaExceededError' ? 'This browser has no room to pass the image on' : 'This browser cannot pass the image on';
    throw new Error(`${reason}. Download the image instead.`, { cause: error });
  }
}

// Of two tabs holding the secret (a duplicated tab copies it), one claims the entry. A claim is
// a marker beside the entry, not a rewrite of it: WebKit drops a stored Blob's bytes when its
// record is replaced. An entry refused for its age, its target or a missing secret is deleted.
async function claim(id, app, proof) {
  let entry = null;
  let claimed = false;
  await transact('readwrite', (store) => {
    const stored = store.get(id);
    const marker = store.getKey(`${CLAIM}${id}`);
    marker.onsuccess = () => {
      entry = stored.result ?? null;
      if (!entry || marker.result !== undefined) return;
      if (isExpired(entry) || entry.target !== app || entry.proof !== proof) {
        store.delete(id);
        return;
      }
      claimed = true;
      store.put({ id: `${CLAIM}${id}`, createdAt: entry.createdAt });
    };
  });
  return { entry, claimed };
}

// WebKit and Firefox delete a stored Blob's bytes with its entry, even while a File still
// refers to them, so the receiver works on copies that outlive the entry. For a 1 GB image,
// WebKit holds a streamed copy whole in memory (4.6 GB at peak) and copying in 64 MB pieces
// keeps it near 2 GB, while Chromium and Firefox stream the copy to disk (under 0.6 GB) but
// would hold the pieces in memory. A wrong guess costs memory, never the image. Chromium-based
// browsers also say AppleWebKit, so they are told apart by their own name.
export function copiesInPieces(userAgent) {
  return /AppleWebKit/.test(userAgent) && !/Chrome\/|Chromium\//.test(userAgent);
}
const COPY_IN_PIECES = copiesInPieces(globalThis.navigator?.userAgent ?? '');
const COPY_PIECE = 64 * 1024 * 1024;
// An abort stops the copy: the streamed one cancels its pipe, the pieced one stops after the piece in flight.
async function copyOut({ name, type, blob }, signal) {
  if (!COPY_IN_PIECES) {
    const stream = blob.stream().pipeThrough(new TransformStream(), { signal });
    return new File([await new Response(stream).blob()], name, { type });
  }
  const pieces = [];
  for (let offset = 0; offset < blob.size; offset += COPY_PIECE) {
    signal?.throwIfAborted();
    pieces.push(new Blob([await blob.slice(offset, offset + COPY_PIECE).arrayBuffer()]));
  }
  return new File(pieces, name, { type });
}

// The isolation service worker reloads some pages on their first visit; the page after the
// reload claims the entry instead. Once this page claims it, later reloads are held off.
async function pageStays(window) {
  if (!window.crossOriginIsolated && window.coiWillReload) {
    const timeout = new Promise((resolve) => { window.setTimeout(resolve, RELOAD_DECISION_MS, false); });
    if (await Promise.race([window.coiWillReload, timeout])) return false;
  }
  window.coiHoldReloads?.();
  return true;
}

// Claims the handoff in the page's hash and returns its files, copied out of storage. A load
// that fails afterwards is not retried; the user sends again. Returns null when the page
// carries no handoff or is about to reload. An abort during the copy rejects with the
// signal's reason, and the entry is deleted as after any failure.
export async function takeHandoff({ document = globalThis.document, signal } = {}) {
  const { location, defaultView: window } = document;
  const id = handoffId(location.hash);
  if (!id) return null;
  if (!await pageStays(window)) return null;
  const unreadable = (error) => new Error(`This browser could not read the image sent from another app (${error?.message ?? error}).`, { cause: error });
  const key = `${SECRET}${id}`;
  let entry;
  let claimed;
  try {
    // Without sessionStorage there is no secret, and the claim is refused.
    let presented = null;
    try { presented = window.sessionStorage.getItem(key); } catch { /* unavailable */ }
    ({ entry, claimed } = await claim(id, appPath(document.baseURI), presented && await digest(presented)));
  } catch (error) {
    throw unreadable(error);
  } finally {
    try { window.sessionStorage.removeItem(key); } catch { /* unavailable */ }
  }
  window.history.replaceState(window.history.state, '', `${location.pathname}${location.search}${withoutHandoff(location.hash)}`);
  if (!claimed) {
    throw new Error(`The image sent from ${entry?.source.title ?? 'another app'} is no longer available. Send it again.`);
  }
  try {
    const files = await Promise.all(entry.files.map((file) => copyOut(file, signal)));
    signal?.throwIfAborted();
    return { source: entry.source, files };
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    throw unreadable(error);
  } finally {
    // An entry left claimed is never handed out again, and the next sweep after expiry removes it.
    await forget(id).catch(() => {});
  }
}
