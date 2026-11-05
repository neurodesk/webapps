// One module worker per task slot. The page starts a fresh set for each run and terminates them
// on cancel, so no state outlives a run. Movies travel as SharedArrayBuffer views when the page
// is cross-origin isolated, otherwise as copies.
import { inspectTiffStack, readTiffStack } from '@neurodesk/webapp-components/file-io/tiff';
import { initialTemplate } from './core/registration.js';
import { analyse, extractActivity, registerRange } from './core/pipeline.js';
import { MAX_MOVIE_BYTES } from './config.js';

function floatArray(length, shared) {
  return new Float32Array(shared ? new SharedArrayBuffer(length * 4) : new ArrayBuffer(length * 4));
}

const handlers = {
  async decode({ buffer, shared }) {
    const info = await inspectTiffStack(buffer);
    const bytes = info.pages * info.width * info.height * 4;
    if (bytes > MAX_MOVIE_BYTES) throw new Error(`This movie needs ${(bytes / 1e9).toFixed(2)} GB as float32; the limit is ${(MAX_MOVIE_BYTES / 1e9).toFixed(1)} GB. Crop it in time or space first.`);
    const stack = await readTiffStack(buffer, { maxBytes: MAX_MOVIE_BYTES, onProgress: (done, total) => postMessage({ progress: done / total }) });
    const movie = floatArray(stack.data.length, shared);
    movie.set(stack.data);
    const { data: _data, ...rest } = stack;
    return { ...rest, movie };
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
  activity({ registered, dims, options, labels }) {
    return extractActivity(registered, dims, options, labels);
  },
};

self.onmessage = async ({ data }) => {
  try {
    const result = await handlers[data.type](data);
    postMessage({ result });
  } catch (error) {
    postMessage({ error: error?.message ?? String(error) });
  }
};
