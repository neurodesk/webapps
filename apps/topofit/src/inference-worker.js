import { runTopofit } from '@neurodesk/topofit';
import { Tensor, browserRuntime, createBrowserSession } from '@neurodesk/topofit/browser';
import manifest from '@neurodesk/topofit/manifest';
import cortexAtlas from '@neurodesk/topofit/cortex-atlas-manifest';
import { fetchModel } from '@neurodesk/webapp-components/worker';
import { Niimath } from '@niivue/niimath';

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

async function conform(file) {
  const niimath = new Niimath();
  try {
    await niimath.init();
    const output = await niimath.image(file).gz(0).conform().ras().run('topofit-conformed.nii');
    return output.arrayBuffer();
  } finally {
    niimath.dispose();
  }
}

self.onmessage = async ({ data: job }) => {
  try {
    const result = await runTopofit({
      buffer: await job.file.arrayBuffer(),
      model: job.model,
      conform: job.conform,
      conformInput: () => conform(job.file),
      overlayThickness: job.overlayThickness,
      estimateNormals: job.estimateNormals,
      patches: job.patches,
      roiBuffer: job.roiBuffer,
      loadAtlas: async () => fetchModel({
        url: cortexAtlas.url,
        cacheKey: cortexAtlas.url,
        integrity: cortexAtlas,
      }, { cache: await cachePromise }),
      loadAsset: (name, from, to) => asset(name, from, to, job.assetBase),
      createSession: createBrowserSession,
      Tensor,
      onProgress: progress,
      runtime: {
        app: 'TopoFit web 0.7.20260919',
        release: manifest.release,
        conformer: '@niivue/niimath -conform -ras',
        assets: Object.fromEntries(manifest.assets.map(({ filename, sha256 }) => [filename, sha256])),
        ...(job.patches ? { cortexAtlasSha256: cortexAtlas.sha256 } : {}),
        ...browserRuntime(),
      },
    });
    self.postMessage({ type: 'result', ...result }, [...result.files.map((file) => file.bytes), ...Object.values(result.surfaces.vertices).map((array) => array.buffer), ...Object.values(result.surfaces.faces).map((array) => array.buffer)]);
  } catch (error) {
    self.postMessage({ type: 'error', message: error.message || String(error) });
  }
};
