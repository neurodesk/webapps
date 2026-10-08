import manifest from '@neurodesk/topofit/manifest';
import { fetchModel } from '@neurodesk/webapp-components/worker';

export async function openModelCache() {
  try {
    const storage = await caches.open(`neurodesk-topofit-${manifest.release}`);
    return {
      async get(key) {
        return (await storage.match(key))?.arrayBuffer();
      },
      async set(key, value) {
        await storage.put(key, new Response(value));
      },
      async delete(key) {
        await storage.delete(key);
      },
    };
  } catch {
    return null;
  }
}

export function createAssetLoader({ baseUrl, cache, onProgress = () => {} }) {
  return async (name, from, to) => {
    const entry = manifest.assets.find((candidate) => candidate.filename === name);
    if (!entry) throw new Error(`TopoFit release is missing ${name}.`);
    return fetchModel(
      {
        url: `${baseUrl}${name}?sha256=${entry.sha256}`,
        cacheKey: `${manifest.release}/${entry.sha256}`,
        integrity: { bytes: entry.bytes, sha256: entry.sha256 },
      },
      {
        cache: await cache,
        onProgress: ({ fraction }) => onProgress(from + (to - from) * (fraction || 0), `Loading ${name}…`),
      },
    );
  };
}
