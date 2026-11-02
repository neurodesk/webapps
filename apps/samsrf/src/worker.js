// One SamSrf worker: one engine instance, one job.
// In:  { type: "prepare", inputs } | { type: "job", job } | { type: "run", start, end } | { type: "merge", shards }
// Out: { type: "progress", done, total? } while preparing or running, then { type: "done", value } or { type: "error", message }.
import { createJob, mergeShards, runShard } from "./engine.js";

let job = null;

/** Post progress at most once per percent: the search space reports every grid point. */
function progress() {
  let last = -1;
  return (done, total) => {
    const percent = Math.floor((100 * done) / total);
    if (percent === last) return;
    last = percent;
    self.postMessage({ type: "progress", done, total });
  };
}

const handlers = {
  prepare: async ({ inputs }) => (job = await createJob(inputs, progress())),
  job: async (message) => {
    job = message.job;
  },
  run: ({ start, end }) => runShard(job, start, end, (done) => self.postMessage({ type: "progress", done })),
  merge: ({ shards }) => mergeShards(job, shards),
};

self.onmessage = async ({ data }) => {
  try {
    const value = await handlers[data.type](data);
    self.postMessage({ type: "done", value });
  } catch (error) {
    self.postMessage({ type: "error", message: error?.message ?? String(error) });
  }
};
