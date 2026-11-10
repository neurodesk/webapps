import { test } from "node:test";
import assert from "node:assert/strict";
import { allOrAbort } from "../src/tasks.js";

/** A task that resolves after `ms` unless its signal aborts first. */
const slow = (ms, value, stopped) => (signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => resolve(value), ms);
  signal.addEventListener("abort", () => {
    clearTimeout(timer);
    stopped.push(value);
    reject(signal.reason);
  }, { once: true });
});

test("one failing task aborts its siblings and its error is thrown", async () => {
  const stopped = [];
  const failure = new Error("worker 2 failed");
  const failing = () => new Promise((_, reject) => setTimeout(() => reject(failure), 5));
  await assert.rejects(allOrAbort(undefined, [slow(10000, "a", stopped), failing, slow(10000, "c", stopped)]), failure);
  assert.deepEqual(stopped.sort(), ["a", "c"]);
});

test("tasks that all succeed resolve in order, and a caller's abort stops them all", async () => {
  assert.deepEqual(await allOrAbort(undefined, [slow(5, 1, []), slow(1, 2, [])]), [1, 2]);
  const stopped = [];
  const controller = new AbortController();
  const run = allOrAbort(controller.signal, [slow(10000, "x", stopped), slow(10000, "y", stopped)]);
  controller.abort(new DOMException("Cancelled", "AbortError"));
  await assert.rejects(run, { name: "AbortError" });
  assert.deepEqual(stopped.sort(), ["x", "y"]);
});
