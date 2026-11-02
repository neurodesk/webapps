// One SamSrf worker: one engine instance, one job.
// In:  { type: "prepare", inputs } | { type: "job", job } | { type: "run", start, end } | { type: "merge", shards }
// Out: { type: "progress", done } while running, then { type: "done", value } or { type: "error", message }.
import { createJob, mergeShards, runShard } from "./engine.js";

let job = null;

const handlers = {
  prepare: async ({ inputs }) => (job = await createJob(inputs)),
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
