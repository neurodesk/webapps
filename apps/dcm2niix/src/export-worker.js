// Compression can be expensive for a DWI examination. Keep it off the UI thread
// so editing stays responsive and cancelling can release every export buffer.
import { buildDataset, datasetZip } from './bids.js';

self.onmessage = async ({ data: { series, options } }) => {
  try {
    const dataset = await buildDataset(series, options, {
      onProgress: (fraction) => self.postMessage({ progress: fraction * 0.9 }),
    });
    const bytes = await datasetZip(dataset.entries);
    self.postMessage({ bytes, count: dataset.count }, [bytes.buffer]);
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};
