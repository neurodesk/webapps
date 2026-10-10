import assert from "node:assert/strict";
import { test } from "node:test";
import { createIoWorkerQueue } from "../src/io-worker.js";

function deferred() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
}

function worker(name) {
  return { name, terminated: false, terminate() { this.terminated = true; } };
}

test("a reset during worker creation prevents the abandoned read from running", async () => {
  const creation = deferred();
  const creating = deferred();
  const stale = worker("cancelled worker");
  const current = worker("retry worker");
  let first = true;
  const io = createIoWorkerQueue(() => {
    if (!first) return Promise.resolve(current);
    first = false;
    creating.resolve();
    return creation.promise;
  });
  let abandonedReads = 0;
  const abandoned = io.run((active) => {
    abandonedReads++;
    return { image: active.name, webWorker: active };
  });
  const rejected = assert.rejects(abandoned, { name: "AbortError" });
  await creating.promise;
  io.reset();
  assert.equal((await io.run((active) => ({ image: active.name }))).image, "retry worker");
  creation.resolve(stale);
  await rejected;
  assert.equal(abandonedReads, 0);
  assert.equal(stale.terminated, true);
  assert.equal((await io.run((active) => ({ image: active.name }))).image, "retry worker");
  io.reset();
});

test("reset rejects old results and queued reads while the retry keeps its own worker", async () => {
  const pending = deferred();
  const started = deferred();
  const old = worker("old worker");
  const current = worker("current worker");
  let count = 0;
  const io = createIoWorkerQueue(async () => count++ ? current : old);
  const stale = io.run(async (active) => {
    started.resolve();
    await pending.promise;
    return { image: active.name, webWorker: active };
  });
  let queuedReads = 0;
  const queued = io.run((active) => {
    queuedReads++;
    return { image: active.name };
  });
  const rejected = [stale, queued].map((read) => assert.rejects(read, { name: "AbortError" }));
  await started.promise;
  io.reset();
  assert.equal(old.terminated, true);
  assert.equal((await io.run((active) => ({ image: active.name }))).image, "current worker");
  pending.resolve();
  await Promise.all(rejected);
  assert.equal(queuedReads, 0);
  assert.equal((await io.run((active) => ({ image: active.name }))).image, "current worker");
  io.reset();
});

test("successful reads serialize on one worker and a failed read permits the next", async () => {
  const pending = deferred();
  const started = deferred();
  const active = worker("shared worker");
  const io = createIoWorkerQueue(async () => active);
  const images = [];
  const first = io.run(async (current) => {
    started.resolve();
    await pending.promise;
    images.push(`${current.name}:first image`);
    return "first image";
  });
  const second = io.run((current) => {
    images.push(`${current.name}:second image`);
    return "second image";
  });
  await started.promise;
  assert.deepEqual(images, []);
  pending.resolve();
  assert.deepEqual(await Promise.all([first, second]), ["first image", "second image"]);
  assert.deepEqual(images, ["shared worker:first image", "shared worker:second image"]);
  await assert.rejects(io.run(() => { throw new Error("Invalid image"); }), /Invalid image/);
  assert.equal(await io.run(() => "valid replacement"), "valid replacement");
  io.reset();
});

test("an aborted task waiting in the active queue does not create a worker", async () => {
  const controller = new AbortController();
  let workers = 0;
  const io = createIoWorkerQueue(async () => {
    workers++;
    return worker("active");
  });
  const abandoned = io.run(() => "abandoned", { signal: controller.signal });
  controller.abort();
  await assert.rejects(abandoned, { name: "AbortError" });
  assert.equal(workers, 0);
  assert.equal(await io.run(() => "replacement"), "replacement");
  assert.equal(workers, 1);
  io.reset();
});

test("abort during worker creation terminates that worker before starting IO", async () => {
  const controller = new AbortController();
  const creation = deferred();
  const started = deferred();
  const stale = worker("abandoned");
  let tasks = 0;
  const io = createIoWorkerQueue(() => {
    started.resolve();
    return creation.promise;
  });
  const abandoned = io.run(() => { tasks++; }, { signal: controller.signal });
  const rejected = assert.rejects(abandoned, { name: "AbortError" });
  await started.promise;
  controller.abort();
  creation.resolve(stale);
  await rejected;
  assert.equal(stale.terminated, true);
  assert.equal(tasks, 0);
  io.reset();
});
