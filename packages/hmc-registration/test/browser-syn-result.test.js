import assert from "node:assert/strict";
import test from "node:test";
import { browserResultProblems } from "../validation/browser-syn-result.mjs";

const native = "native-rigid-sha256";
const warps = ["fmap_syn0Warp.nii.gz", "fmap_syn0InverseWarp.nii.gz"];
const full = () => ({
  mode: "full", reply: { id: 1, error: null, outputs: Object.fromEntries(warps.map(f => [f, { bytes: 42 }])) },
  outputs_vs_replay: Object.fromEntries(warps.map(f => [f, { bytes_equal: true, decompressed_equal: true, uploaded_sha256_matches_page: true }])),
  linear_memory: { memories: [{ byteLength: 268435456 }] }, after_terminate: [{ renderer_rss_kb: 1000 }],
});
const cancel = () => ({
  mode: "cancel", before_terminate: { after_s: 14 }, reply_after_terminate: "no reply (terminated)",
  rigid_after_terminate: { error: null, native_bytes: true, sha256: native }, after_terminate: [{ renderer_rss_kb: 1000 }],
});

test("complete warp parity and successful cancellation recovery pass", () => {
  assert.deepEqual(browserResultProblems(full(), native), []);
  assert.deepEqual(browserResultProblems(cancel(), native), []);
});

for (const [name, mutate] of [
  ["worker error", r => { r.reply.error = "kernel failed"; }],
  ["wrong reply", r => { r.reply.id = 2; }],
  ["missing inverse warp", r => { delete r.reply.outputs[warps[1]]; delete r.outputs_vs_replay[warps[1]]; }],
  ["empty warp", r => { r.reply.outputs[warps[0]].bytes = 0; }],
  ...["bytes_equal", "decompressed_equal", "uploaded_sha256_matches_page"].map(key => [key, r => { r.outputs_vs_replay[warps[0]][key] = false; }]),
  ["missing memory record", r => { r.linear_memory.memories = []; }],
  ["missing termination record", r => { r.after_terminate = []; }],
]) test(`full experiment rejects ${name}`, () => {
  const result = full(); mutate(result);
  assert.ok(browserResultProblems(result, native).length);
});

for (const [name, mutate] of [
  ["late reply", r => { r.reply_after_terminate = { error: null }; }],
  ["recovery error", r => { r.rigid_after_terminate.error = "failed"; }],
  ["missing recovery", r => { delete r.rigid_after_terminate; }],
  ["wrong recovery bytes", r => { r.rigid_after_terminate.sha256 = "wrong"; }],
  ["no running observation", r => { r.before_terminate.after_s = 0; }],
]) test(`cancel experiment rejects ${name}`, () => {
  const result = cancel(); mutate(result);
  assert.ok(browserResultProblems(result, native).length);
});
