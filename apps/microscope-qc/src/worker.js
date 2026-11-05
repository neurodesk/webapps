// One module worker per task; the page terminates it on cancel, so no state outlives a task.
// The image stack is transferred in and handed back with the result (or the error), so only
// one copy of it exists at a time.
import { inspectTiffStack, readTiffStack } from "@neurodesk/webapp-components/file-io/tiff";
import { analyseBeads, summariseBeads } from "./core/psf.js";
import { analyseField } from "./core/field.js";
import { omeOptics } from "./core/optics.js";
import { MAX_PEAK_BYTES, checkStack } from "./config.js";

const handlers = {
  async decode({ buffer }) {
    const info = await inspectTiffStack(buffer);
    checkStack(info, buffer.byteLength);
    const stack = await readTiffStack(buffer, { Type: Float32Array, maxBytes: MAX_PEAK_BYTES, onProgress: (done, total) => postMessage({ progress: done / total }) });
    const { data } = stack;
    for (let i = 0; i < data.length; i++) {
      if (!Number.isFinite(data[i])) {
        const plane = Math.floor(i / (stack.width * stack.height));
        throw new Error(`Plane ${plane + 1} holds a NaN or infinite value; replace non-finite pixels before quality control.`);
      }
    }
    return [{ ...stack, optics: omeOptics(stack.metadata.description) }, [data.buffer]];
  },
  psf({ data, dims, options, theory }) {
    const analysis = analyseBeads(data, dims, options, (done, total) => postMessage({ progress: done / total }));
    return [{ ...analysis, summary: summariseBeads(analysis.beads, theory), data }, [data.buffer]];
  },
  field({ data, dims, options }) {
    const field = analyseField(data, dims, options);
    return [{ ...field, data }, [data.buffer, field.zones.buffer, field.smoothed.buffer]];
  },
};

self.onmessage = async ({ data: message }) => {
  try {
    const [result, transfer] = await handlers[message.type](message);
    postMessage({ result }, transfer);
  } catch (error) {
    const { data } = message;
    postMessage({ error: error?.message ?? String(error), data }, data ? [data.buffer] : []);
  }
};
