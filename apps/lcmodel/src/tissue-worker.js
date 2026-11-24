// MindMap's continuous tissue maps (@brainchop/core segmentTissues) in a
// worker: a WebGL2 run blocks its thread, and Cancel terminates the worker.
import { segmentTissues } from "@brainchop/core";

self.onmessage = async ({ data: { input, options } }) => {
  try {
    const result = await segmentTissues(input, { ...options, worker: false, timeoutMs: 900000 });
    const { gm, wm, csf } = result.tissues;
    self.postMessage({ result: { tissues: { gm, wm, csf }, backend: result.backend, elapsedMs: result.elapsedMs } }, [gm, wm, csf]);
  } catch (error) {
    // A BrainchopError carries the module's own output, which says why it failed.
    self.postMessage({ error: error instanceof Error ? error.message : String(error), log: error?.log ?? [] });
  }
};
