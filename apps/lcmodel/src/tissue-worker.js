// MindMap's continuous tissue maps (@brainchop/mindgrab segmentTissues) in a
// worker: a WebGL2 run blocks its thread, and Cancel terminates the worker.
import { segmentTissues } from "@brainchop/mindgrab";

self.onmessage = async ({ data: { input, options } }) => {
  try {
    const result = await segmentTissues(input, { ...options, worker: false, timeoutMs: 900000 });
    const { gm, wm, csf } = result.tissues;
    self.postMessage({ result: { tissues: { gm, wm, csf }, backend: result.backend, elapsedMs: result.elapsedMs } }, [gm, wm, csf]);
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
