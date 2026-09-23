// Fetch a tract atlas once, then score a lesion against every bundle in it. The atlases are
// 7.9 MB (ENIGMA) and 21.8 MB (HCP1065) gzipped and inflate to many times that, so each is
// cached and kept open for the life of the worker; the queries themselves take about 60 ms,
// which is why the worker exists for the download rather than for the arithmetic.
import { fetchModel } from '@neurodesk/webapp-components/worker';
import { openAtlas } from '@neurodesk/nii2tvx';

const CACHE = 'neurodesk-disconnectome-v1';
// Keyed by URL, so switching atlas and switching back does not download or inflate twice.
const opened = new Map();

async function cacheStore() {
  let storage;
  try { storage = await caches.open(CACHE); } catch { return null; } // private mode
  return {
    async get(key) { return (await storage.match(key))?.arrayBuffer(); },
    async set(key, bytes) { try { await storage.put(key, new Response(bytes)); } catch { /* quota */ } },
    async delete(key) { await storage.delete(key); },
  };
}

self.onmessage = async ({ data: job }) => {
  const progress = (value, message) => self.postMessage({ type: 'progress', value, message });
  try {
    const { url, bytes, sha256, label } = job.atlas;
    if (!opened.has(url)) {
      opened.set(url, (async () => {
        progress(0.05, `Downloading the ${label} atlas…`);
        // fetchModel verifies the checksum on a cache hit too, so a corrupted cache entry is
        // evicted and refetched rather than opened.
        const data = await fetchModel({ url, integrity: { bytes, sha256 } }, {
          cache: await cacheStore(),
          onProgress: ({ fraction }) => progress(0.05 + 0.65 * (fraction ?? 0),
            `Downloading the ${label} atlas · ${((fraction ?? 0) * 100).toFixed(0)}%`),
        });
        progress(0.75, 'Opening the tract atlas…');
        return openAtlas(new Uint8Array(data));
      })().catch((error) => { opened.delete(url); throw error; }));
    }
    const atlas = await opened.get(url);
    progress(0.9, `Scoring ${atlas.tracts.length} bundles…`);
    const fractions = await atlas.query(new Uint8Array(job.lesion));
    self.postMessage({ type: 'result', tracts: atlas.tracts, fractions }, [fractions.buffer]);
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
