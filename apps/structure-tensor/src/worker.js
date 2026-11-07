// One analysis per worker: the page terminates it on cancel, which frees its arrays.
import { analyse } from "./tensor.js";

self.onmessage = ({ data: { image, settings } }) => {
  try {
    let last = 0;
    const result = analyse(image, settings, {
      onProgress: (fraction) => {
        if (fraction - last >= 0.05 || fraction === 1) {
          last = fraction;
          self.postMessage({ progress: fraction });
        }
      },
    });
    const maps = Object.fromEntries(Object.entries(result.maps).map(([key, values]) => [key, Float32Array.from(values)]));
    const distributions = Object.fromEntries(Object.entries(result.distributions).map(([key, value]) => [key, { ...value, counts: Array.from(value.counts) }]));
    const transfer = [...Object.values(maps).map((values) => values.buffer), result.colour.buffer];
    self.postMessage({ result: { dimensions: result.dimensions, dominant: result.dominant, maps, distributions, colour: result.colour } }, transfer);
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};
