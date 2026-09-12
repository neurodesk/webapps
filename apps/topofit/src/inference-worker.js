import { runTopofit } from '@neurodesk/topofit';
import { Tensor, browserRuntime, createBrowserSession } from '@neurodesk/topofit/browser';
import manifest from '@neurodesk/topofit/manifest';
import { fetchModel } from '@neurodesk/webapp-components/worker';

const progress = (value, message) => self.postMessage({ type: 'progress', value, message });
const cachePromise = openModelCache();

async function openModelCache() {
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

async function asset(name, from, to, baseUrl) {
  const entry = manifest.assets.find((candidate) => candidate.filename === name);
  if (!entry) throw new Error(`TopoFit release is missing ${name}.`);
  return fetchModel(
    {
      url: `${baseUrl}${name}?sha256=${entry.sha256}`,
      cacheKey: `${manifest.release}/${entry.sha256}`,
      integrity: { bytes: entry.bytes, sha256: entry.sha256 },
    },
    {
      cache: await cachePromise,
      onProgress: ({ fraction }) => progress(from + (to - from) * (fraction || 0), `Loading ${name}…`),
    },
  );
}

self.onmessage = async ({ data: job }) => {
  try {
    const result = await runTopofit({
      buffer: await job.file.arrayBuffer(),
      model: job.model,
      conform: job.conform,
      overlayThickness: job.overlayThickness,
      loadAsset: (name, from, to) => asset(name, from, to, job.assetBase),
      createSession: createBrowserSession,
      Tensor,
      onProgress: progress,
      runtime: {
        app: 'TopoFit web 0.3.20260912',
        release: manifest.release,
        assets: Object.fromEntries(manifest.assets.map(({ filename, sha256 }) => [filename, sha256])),
        ...browserRuntime(),
      },
    });
    self.postMessage({ type: 'result', ...result }, result.files.map((file) => file.bytes));
  } catch (error) {
    self.postMessage({ type: 'error', message: error.message || String(error) });
  }
};
