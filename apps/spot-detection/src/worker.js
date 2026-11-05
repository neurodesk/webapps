// One analysis per worker; the page terminates the worker to cancel it.
import { analyse } from "./pipeline.js";

self.onmessage = ({ data }) => {
  try {
    const result = analyse(data.image, {
      ...data.settings,
      labels: data.labels,
      onProgress: (stage, fraction) => self.postMessage({ progress: { stage, fraction } }),
    });
    const { image, curve, ...rest } = result;
    self.postMessage({ result: { ...rest, image: { shape: image.shape, dtype: image.dtype, data: image.data }, curve: curve && { thresholds: curve.thresholds, counts: curve.counts } } });
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};
