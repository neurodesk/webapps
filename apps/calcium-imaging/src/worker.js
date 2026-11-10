// One module worker per task slot. The page starts a fresh set for each run and terminates them
// on cancel, so no state outlives a run. Movies travel as SharedArrayBuffer views when the page
// is cross-origin isolated, otherwise as copies.
import { inspectTiffStack, readTiffStack } from '@neurodesk/webapp-components/file-io/tiff';
import { InputTooLargeError } from '@neurodesk/webapp-components/file-io/input-limits';
import { initialTemplate } from './core/registration.js';
import { analyse, extractActivity, registerRange } from './core/pipeline.js';
import { MAX_MOVIE_BYTES, checkMovie } from './config.js';

const handlers = {
  async decode({ buffer, shared, name }) {
    checkMovie(await inspectTiffStack(buffer), name);
    // Each page is decoded straight into the float32 movie: the file and the movie are the only copies.
    try {
      const { data: movie, ...rest } = await readTiffStack(buffer, { Type: Float32Array, shared, maxBytes: MAX_MOVIE_BYTES, onProgress: (done, total) => postMessage({ progress: done / total }) });
      return { ...rest, movie };
    } catch (error) {
      if (!(error instanceof InputTooLargeError)) throw error;
      throw new Error(`This movie needs ${(error.actualBytes / 1e9).toFixed(2)} GB as float32; the limit is ${(MAX_MOVIE_BYTES / 1e9).toFixed(1)} GB. Crop it in time or space first.`);
    }
  },
  template({ movie, width, height, frames }) {
    return { template: initialTemplate(movie, frames, height, width) };
  },
  register({ movie, out, template, width, height, start, end, options }) {
    const target = out ?? new Float32Array((end - start) * width * height);
    const view = out ? target : { subarray: (a, b) => target.subarray(a - start * width * height, b - start * width * height) };
    let done = 0;
    const result = registerRange(movie, view, template, { width, height, start, end }, options, () => {
      done++;
      if (done % 4 === 0 || start + done === end) postMessage({ progress: done });
    });
    return { ...result, frames: out ? null : target };
  },
  analyse({ registered, dims, options, labels, margin }) {
    return analyse(registered, dims, options, labels ?? null, { margin });
  },
  activity({ registered, dims, options, labels, margin }) {
    return extractActivity(registered, dims, options, labels, { margin });
  },
};

// The result's own typed arrays (the decoded movie, registered frames) move to the page
// instead of being copied; shared buffers are already visible there.
function transferables(result) {
  const buffers = new Set();
  for (const value of Object.values(result ?? {})) {
    if (ArrayBuffer.isView(value) && value.buffer instanceof ArrayBuffer && value.byteLength === value.buffer.byteLength) buffers.add(value.buffer);
  }
  return [...buffers];
}

self.onmessage = async ({ data }) => {
  try {
    const result = await handlers[data.type](data);
    postMessage({ result }, transferables(result));
  } catch (error) {
    postMessage({ error: error?.message ?? String(error) });
  }
};
