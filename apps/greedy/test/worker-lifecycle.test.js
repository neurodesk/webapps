import assert from "node:assert/strict";
import test from "node:test";
import { createRegistrationRunner } from "../src/registration-runner.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

class FakeWorker {
  messages = [];
  terminated = false;
  terminate() { this.terminated = true; }
  postMessage(message) { this.messages.push(message); }
}

function harness() {
  const workers = [];
  const state = { active: false };
  const runner = createRegistrationRunner({
    createWorker: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    onActiveChange: (active) => { state.active = active; },
  });
  return { runner, workers, state };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const ready = { arrayBuffer: async () => new ArrayBuffer(1) };

for (const cancellation of ["button", "signal"]) for (const outcome of ["resolve", "reject"]) {
  test(`${cancellation}-cancelled file read ${outcome} cannot publish into or terminate a subsequent worker`, async () => {
    const { runner, workers, state } = harness();
    const read = deferred();
    const controller = new AbortController();
    const oldJob = runner.run({ arrayBuffer: () => read.promise }, ready, "affine", () => {}, controller.signal);
    assert.equal(state.active, true);
    const cancelled = assert.rejects(oldJob, /Cancelled/);
    if (cancellation === "button") runner.cancel();
    else controller.abort(new DOMException("Cancelled", "AbortError"));
    await cancelled;
    assert.equal(state.active, false);
    const newRead = deferred();
    const currentJob = runner.run({ arrayBuffer: () => newRead.promise }, ready, "affine", () => {});
    if (outcome === "resolve") read.resolve(new ArrayBuffer(1));
    else read.reject(new Error("Old input failed"));
    await settle();
    assert.equal(workers[0].terminated, true);
    assert.equal(workers[1].terminated, false);
    assert.equal(workers[0].messages.length, 0);
    assert.equal(workers[1].messages.length, 0);
    workers[0].onmessage({ data: { error: "Stale worker result" } });
    assert.equal(workers[1].terminated, false);
    assert.equal(state.active, true);
    newRead.resolve(new ArrayBuffer(1));
    await settle();
    assert.equal(workers[1].messages.length, 1);
    workers[1].onmessage({ data: { result: "current" } });
    assert.deepEqual(await currentJob, { result: "current" });
    assert.equal(workers[1].terminated, true);
    assert.equal(state.active, false);
  });
}

test("progress is reported and a worker error rejects and releases the worker", async () => {
  const { runner, workers, state } = harness();
  const phases = [];
  const job = runner.run(ready, ready, "affine", (phase) => phases.push(phase));
  await settle();
  workers[0].onmessage({ data: { phase: "Preparing NIfTI images" } });
  assert.deepEqual(phases, ["Preparing NIfTI images"]);
  assert.equal(workers[0].terminated, false);
  workers[0].onmessage({ data: { error: "Kernel failed" } });
  await assert.rejects(job, /Kernel failed/);
  assert.equal(workers[0].terminated, true);
  assert.equal(state.active, false);
});
