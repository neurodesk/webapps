import { runSurfaceAnalysis } from '@neurodesk/topofit';
import cortexAtlas from '@neurodesk/topofit/cortex-atlas-manifest';
import { fetchModel } from '@neurodesk/webapp-components/worker';

self.onmessage = async ({ data: job }) => {
  try {
    const result = await runSurfaceAnalysis({
      ...job,
      buffer: await job.file.arrayBuffer(),
      cortexAtlasSha256: cortexAtlas.sha256,
      loadAtlas: () => fetchModel({ url: cortexAtlas.url, integrity: cortexAtlas }),
      onProgress: (value, message) => self.postMessage({ type: 'progress', value, message }),
    });
    self.postMessage({ type: 'result', ...result }, result.files.map((file) => file.bytes));
  } catch (error) {
    self.postMessage({ type: 'error', message: error.message || String(error) });
  }
};
