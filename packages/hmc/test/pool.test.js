// The pool's scheduling, errors and cancellation, on fake workers that answer like the kernel worker.
import assert from "node:assert/strict";
import test from "node:test";
import { createRegistrationPool } from "../src/pool.js";

/** A fake worker: answers each run after `delay` ms, unless terminated first. */
function fakeSpawner({ delay = 5, fail = () => null } = {}) {
  const workers = [];
  const spawn = () => {
    const worker = {
      terminated: false,
      received: [],
      onmessage: null,
      onerror: null,
      postMessage(message, transfer) {
        worker.received.push({ message, transfer });
        setTimeout(() => {
          if (worker.terminated) return;
          const error = fail(message);
          if (error) return worker.onmessage({ data: { id: message.id, error, log: ["line"] } });
          worker.onmessage({ data: { id: message.id, outputs: { "out.txt": new TextEncoder().encode(message.argv.join(" ")) }, log: [] } });
        }, delay);
      },
      terminate() {
        worker.terminated = true;
      },
    };
    workers.push(worker);
    return worker;
  };
  return { spawn, workers };
}

const text = (bytes) => new TextDecoder().decode(bytes);

test("runs every task, at most `workers` at a time, and builds inputs only when sent", async () => {
  const { spawn, workers } = fakeSpawner();
  const pool = createRegistrationPool({ spawn, workers: 2 });
  let built = 0;
  const results = await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      pool.run({
        argv: [`task-${i}`],
        inputs: () => {
          built++;
          return { "a.nii": new Uint8Array([i]) };
        },
        transfer: true,
      }),
    ),
  );
  assert.deepEqual(results.map(({ outputs }) => text(outputs["out.txt"])), ["task-0", "task-1", "task-2", "task-3", "task-4"]);
  assert.equal(workers.length, 2);
  assert.equal(built, 5);
  assert.ok(workers.every((w) => w.received.every(({ transfer }) => transfer.length === 1)));
  await pool.close();
  assert.ok(workers.every((w) => w.terminated));
  await assert.rejects(pool.run({ argv: ["late"], inputs: {} }), /closed/);
});

test("a run error rejects that task with the kernel log", async () => {
  const { spawn } = fakeSpawner({ fail: (message) => (message.argv[0] === "bad" ? "antsRegistration failed (exit 1)" : null) });
  const pool = createRegistrationPool({ spawn, workers: 1 });
  await assert.rejects(pool.run({ argv: ["bad"], inputs: {} }), (error) => error.message === "antsRegistration failed (exit 1)" && error.log[0] === "line");
  assert.equal(text((await pool.run({ argv: ["good"], inputs: {} })).outputs["out.txt"]), "good");
  await pool.close();
});

test("a worker that fails stops the pool", async () => {
  const { spawn, workers } = fakeSpawner({ delay: 50 });
  const pool = createRegistrationPool({ spawn, workers: 1 });
  const first = pool.run({ argv: ["a"], inputs: {} });
  const second = pool.run({ argv: ["b"], inputs: {} });
  workers[0].onerror({ message: "out of memory" });
  await assert.rejects(first, /out of memory/);
  await assert.rejects(second, /out of memory/);
  assert.ok(workers[0].terminated);
});

test("an abort terminates the workers and rejects running and queued tasks; an aborted signal starts none", async () => {
  const { spawn, workers } = fakeSpawner({ delay: 1000 });
  const controller = new AbortController();
  const pool = createRegistrationPool({ spawn, workers: 2, signal: controller.signal });
  const runs = [0, 1, 2].map((i) => pool.run({ argv: [`${i}`], inputs: {} }));
  controller.abort();
  for (const run of runs) await assert.rejects(run, { name: "AbortError" });
  assert.equal(workers.length, 2);
  assert.ok(workers.every((w) => w.terminated));

  const aborted = fakeSpawner();
  const none = createRegistrationPool({ spawn: aborted.spawn, workers: 2, signal: AbortSignal.abort() });
  await assert.rejects(none.run({ argv: ["x"], inputs: {} }), { name: "AbortError" });
  assert.equal(aborted.workers.length, 0);
  assert.throws(() => createRegistrationPool({ spawn, workers: 0 }), /positive whole number/);
});

test("kernel URLs travel with each message", async () => {
  const { spawn, workers } = fakeSpawner();
  const kernel = { module: "/k.mjs", wasm: "/k.wasm" };
  const pool = createRegistrationPool({ spawn, workers: 1, kernel });
  await pool.run({ argv: ["x"], inputs: {} });
  assert.deepEqual(workers[0].received[0].message.kernel, kernel);
  await pool.close();
});

test("an abort during input preparation rejects the task before posting to the terminated worker", { timeout: 1000 }, async () => {
  const { spawn, workers } = fakeSpawner();
  const controller = new AbortController();
  const pool = createRegistrationPool({ spawn, workers: 1, signal: controller.signal });
  await assert.rejects(pool.run({ argv: ["x"], inputs: () => {
    controller.abort();
    return { "a.nii": new Uint8Array([1]) };
  } }), { name: "AbortError" });
  assert.equal(workers.length, 1);
  assert.equal(workers[0].terminated, true);
  assert.deepEqual(workers[0].received, []);
  await pool.close();
});
