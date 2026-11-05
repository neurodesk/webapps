// One module worker per task; the page terminates it on cancel, so no state outlives a task.
import { inspectTiffStack, readTiffStack } from "@neurodesk/webapp-components/file-io/tiff";
import { analyseBeads, summariseBeads } from "./core/psf.js";
import { analyseField } from "./core/field.js";
import { omeOptics } from "./core/optics.js";
import { MAX_STACK_BYTES, checkStack } from "./config.js";

const handlers = {
  async decode({ buffer }) {
    const info = await inspectTiffStack(buffer);
    checkStack(info);
    const stack = await readTiffStack(buffer, { Type: Float32Array, maxBytes: MAX_STACK_BYTES, onProgress: (done, total) => postMessage({ progress: done / total }) });
    const { data } = stack;
    for (let i = 0; i < data.length; i++) {
      if (!Number.isFinite(data[i])) {
        const plane = Math.floor(i / (stack.width * stack.height));
        throw new Error(`Plane ${plane + 1} holds a NaN or infinite value; replace non-finite pixels before quality control.`);
      }
    }
    const { data: _data, ...rest } = stack;
    return { ...rest, optics: omeOptics(stack.metadata.description), data };
  },
  psf({ data, dims, options, theory }) {
    const analysis = analyseBeads(data, dims, options, (done, total) => postMessage({ progress: done / total }));
    return { ...analysis, summary: summariseBeads(analysis.beads, theory) };
  },
  field({ data, dims, options }) {
    return analyseField(data, dims, options);
  },
};

self.onmessage = async ({ data }) => {
  try {
    postMessage({ result: await handlers[data.type](data) });
  } catch (error) {
    postMessage({ error: error?.message ?? String(error) });
  }
};
