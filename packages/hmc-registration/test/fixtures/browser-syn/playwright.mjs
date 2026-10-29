import { createHash } from "node:crypto";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { NATIVE_MAT_SHA256 } from "../../expected.mjs";
const scenario = process.env.HMC_BROWSER_TEST_CASE;
const [, , , replay, out] = process.argv;
const page = {
  async exposeFunction() {}, on() {}, async goto() {},
  async waitForEvent() { return { on() {}, async evaluate(fn) {
    if (String(fn).includes("memories.map")) return { memories: [{ byteLength: 268435456 }], grows: [] };
  } }; },
  async evaluate(fn) {
    const code = String(fn);
    if (code.includes("crossOriginIsolated")) return true;
    if (code.includes("Promise.race([self.replies.syn")) return scenario === "cancel-late" ? { error: null } : "no reply (terminated)";
    if (code.includes("self.workers.rigid.onmessage")) return { error: null, sha256: scenario === "cancel-bad-recovery" ? "wrong" : NATIVE_MAT_SHA256 };
    if (!code.includes("self.replies.syn")) return;
    const reply = { id: 1, error: null, outputs: {}, log: [], wall_s: 1 };
    if (scenario === "worker-event-error") return { error: "synthetic worker event failure" };
    if (scenario === "worker-error") return { ...reply, error: "synthetic worker failure" };
    for (const file of ["fmap_syn0Warp.nii.gz", "fmap_syn0InverseWarp.nii.gz"]) {
      if (scenario === "missing-warp" && file.includes("Inverse")) continue;
      const destination = join(out, "outputs", file);
      copyFileSync(join(replay, file), destination);
      if (scenario === "wrong-warp") writeFileSync(destination, gzipSync(Buffer.from("wrong warp")));
      const bytes = readFileSync(destination);
      reply.outputs[file] = { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    }
    return reply;
  },
};
export const chromium = { async launch() {
  if (scenario === "launch-error") throw new Error("synthetic launch failure");
  return { async newPage() { return page; }, version() { return "synthetic CLI regression"; }, async close() {} };
} };
