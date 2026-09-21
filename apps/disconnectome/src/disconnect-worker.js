// Fetch the tract atlas once, then score a lesion against all 87 bundles. The atlas is 21.8 MB
// gzipped and inflates to 88 MB, so it is cached and kept open for the life of the worker; the
// queries themselves take about 60 ms, which is why the worker exists for the download rather
// than for the arithmetic.
import { openAtlas } from '@neurodesk/nii2tvx';

const CACHE = 'neurodesk-disconnectome-v1';
let atlasPromise;

async function fetchAtlas({ url, bytes, sha256 }, report) {
  let cache;
  try { cache = await caches.open(CACHE); } catch { /* private mode: fetch every time */ }
  const cached = await cache?.match(url);
  if (cached) return new Uint8Array(await cached.arrayBuffer());

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not download the tract atlas (HTTP ${response.status}).`);
  const total = Number(response.headers.get('content-length')) || bytes;
  const chunks = [];
  let received = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (received > bytes) throw new Error('The tract atlas is larger than the manifest says; refusing it.');
    report(received / total);
  }
  const data = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }

  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)),
    (v) => v.toString(16).padStart(2, '0')).join('');
  if (digest !== sha256) throw new Error('The downloaded tract atlas does not match its checksum.');
  try { await cache?.put(url, new Response(data)); } catch { /* quota */ }
  return data;
}

self.onmessage = async ({ data: job }) => {
  const progress = (value, message) => self.postMessage({ type: 'progress', value, message });
  try {
    if (!atlasPromise) {
      atlasPromise = (async () => {
        progress(0.05, 'Downloading the tract atlas…');
        const bytes = await fetchAtlas(job.atlas, (fraction) => progress(0.05 + 0.65 * fraction,
          `Downloading the tract atlas · ${(fraction * 100).toFixed(0)}%`));
        progress(0.75, 'Opening the tract atlas…');
        return openAtlas(bytes);
      })().catch((error) => { atlasPromise = null; throw error; });
    }
    const atlas = await atlasPromise;
    progress(0.9, 'Scoring 87 bundles…');
    const fractions = await atlas.query(new Uint8Array(job.lesion));
    self.postMessage({ type: 'result', tracts: atlas.tracts, fractions }, [fractions.buffer]);
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
