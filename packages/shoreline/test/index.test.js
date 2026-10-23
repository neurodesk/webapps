import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_THREADS, MEMORY_LIMIT, estimateMemory, fitsInMemory, runShoreline, threadCount } from "../src/index.js";

test("threads: up to MAX_THREADS when isolated, else one", () => {
  assert.equal(threadCount({ isolated: false, hardware: 16 }), 1);
  assert.equal(threadCount({ isolated: true, hardware: 16 }), MAX_THREADS);
  assert.equal(threadCount({ isolated: true, hardware: 4 }), 4);
  assert.equal(threadCount({ isolated: true, hardware: Number.NaN }), 1);
});

test("memory: a clinical series fits, an HCP-sized one does not", () => {
  const clinical = { voxels: 112 * 112 * 72, volumes: 141, inputBytes: 187e6 };
  assert.ok(estimateMemory(clinical) > 1.5e9 && fitsInMemory(clinical));
  const hcp = { voxels: 145 * 174 * 145, volumes: 288, inputBytes: 1.5e9 };
  assert.ok(estimateMemory(hcp) > MEMORY_LIMIT && !fitsInMemory(hcp));
});

test("a run adds the files, passes the arguments and returns the outputs", () => {
  const calls = [];
  class Session {
    constructor() { this.files = new Map(); }
    addFile(name, bytes) { this.files.set(name, bytes); }
    run(args, log) { calls.push(args); log("[    0.0 s] done"); this.files.set("out.nii.gz", Uint8Array.of(1)); this.files.set("out.log", Uint8Array.of(2)); }
    fileNames() { return [...this.files.keys()].sort(); }
    takeFile(name) { const b = this.files.get(name); this.files.delete(name); return b; }
    free() { calls.push("free"); }
  }
  const lines = [];
  const outputs = runShoreline({ api: { Session }, files: { "dwi.nii.gz": Uint8Array.of(9) }, args: ["--imain=dwi.nii.gz", "--out=out"], onLog: (l) => lines.push(l) });
  assert.deepEqual(Object.keys(outputs), ["out.log", "out.nii.gz"]);
  assert.deepEqual(lines, ["[    0.0 s] done"]);
  assert.deepEqual(calls, [["--imain=dwi.nii.gz", "--out=out"], "free"]);
  assert.throws(() => runShoreline({ api: { Session }, files: {}, args: [] }), /--out=/);
});
