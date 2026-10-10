import { test } from "node:test";
import assert from "node:assert/strict";
import { createRegistrationRunner, registrationError } from "../src/registration.js";

function fakes() {
  const workers = [];
  const pending = [];
  const createWebWorker = async () => {
    const worker = { terminated: false, terminate() { this.terminated = true; } };
    workers.push(worker);
    return worker;
  };
  const defaultParameterMap = async (stage, { webWorker }) => ({ parameterMap: { Transform: [stage] }, webWorker });
  const elastix = (parameterObject, { webWorker }) => new Promise((resolve, reject) => {
    pending.push({ resolve: () => resolve({ result: "image", transform: [], transformParameterObject: parameterObject, webWorker }), reject });
  });
  return { workers, pending, createWebWorker, defaultParameterMap, elastix };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a run builds the preset maps, registers on its own worker and releases it", async () => {
  const f = fakes();
  const active = [];
  const runner = createRegistrationRunner({ ...f, onActiveChange: (value) => active.push(value) });
  const phases = [];
  const run = runner.run({ fixed: "f", moving: "m", settings: { method: "rigid" }, onPhase: (phase) => phases.push(phase) });
  await tick();
  f.pending[0].resolve();
  const result = await run;
  assert.deepEqual(result.parameterObject.map((map) => map.Transform[0]), ["translation", "rigid"]);
  assert.deepEqual(phases, ["Building elastix parameter maps", "Registering with elastix · translation → rigid"]);
  assert.equal(f.workers.length, 1);
  assert.ok(f.workers[0].terminated);
  assert.deepEqual(active, [true, false]);
  assert.equal(runner.active, false);
});

test("cancelling terminates the worker, ignores a late result and frees the next run", async () => {
  const f = fakes();
  const active = [];
  const runner = createRegistrationRunner({ ...f, onActiveChange: (value) => active.push(value) });
  const first = runner.run({ fixed: "f", moving: "m", parameterObject: [{ Transform: ["custom"] }] });
  await tick();
  runner.cancel();
  await assert.rejects(first, { name: "AbortError" });
  assert.ok(f.workers[0].terminated);
  const second = runner.run({ fixed: "f", moving: "m", parameterObject: [{ Transform: ["custom"] }] });
  await tick();
  f.pending[0].resolve();
  await tick();
  assert.equal(runner.active, true, "the first run's late result does not close the second");
  f.pending[1].resolve();
  assert.equal((await second).result, "image");
  assert.deepEqual(active, [true, false, true, false]);
});

for (const cancelWithSignal of [false, true]) {
  test(`cancelling during worker creation releases the late worker without closing the next run (${cancelWithSignal ? "signal" : "button"})`, async () => {
    const f = fakes();
    const waiting = [];
    const active = [];
    const runner = createRegistrationRunner({
      ...f,
      createWebWorker: () => new Promise((resolve) => waiting.push(resolve)),
      onActiveChange: (value) => active.push(value),
    });
    const controller = new AbortController();
    const first = runner.run({ fixed: "f", moving: "m", parameterObject: [{}], signal: controller.signal });
    if (cancelWithSignal) controller.abort();
    else runner.cancel();
    await assert.rejects(first, { name: "AbortError" });

    const second = runner.run({ fixed: "f", moving: "m", parameterObject: [{}] });
    let terminations = 0;
    waiting[0]({ terminate() { terminations += 1; } });
    await tick();
    assert.equal(terminations, 1);
    assert.equal(runner.active, true);
    assert.deepEqual(active, [true, false, true]);
    assert.equal(f.pending.length, 0, "the cancelled run never registers");

    waiting[1](await f.createWebWorker());
    await tick();
    f.pending[0].resolve();
    assert.equal((await second).result, "image");
    assert.ok(f.workers[0].terminated);
    assert.equal(terminations, 1);
    assert.deepEqual(active, [true, false, true, false]);
  });
}

test("an abort signal cancels the run and only one run is active at a time", async () => {
  const f = fakes();
  const runner = createRegistrationRunner(f);
  const controller = new AbortController();
  const run = runner.run({ fixed: "f", moving: "m", parameterObject: [{}], signal: controller.signal });
  await assert.rejects(runner.run({ fixed: "f", moving: "m", parameterObject: [{}] }), /already running/);
  controller.abort();
  await assert.rejects(run, { name: "AbortError" });
  assert.ok(f.workers[0].terminated);
  await assert.rejects(runner.run({ fixed: "f", moving: "m", parameterObject: [{}], signal: controller.signal }), { name: "AbortError" });
});

test("an elastix C++ exception number becomes a readable error", async () => {
  const f = fakes();
  const runner = createRegistrationRunner(f);
  const run = runner.run({ fixed: "f", moving: "m", parameterObject: [{}] });
  await tick();
  f.pending[0].reject(5_243_016);
  await assert.rejects(run, /elastix stopped with an internal error/);
  assert.equal(registrationError(new Error("kept")).message, "kept");
  assert.equal(registrationError("text").message, "text");
});
