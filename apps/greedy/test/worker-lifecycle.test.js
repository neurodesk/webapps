import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
const registrationSource = source.slice(source.indexOf("function runRegistration("), source.indexOf("\nasync function register()"))
  .replace("import.meta.url", '"https://example.test/main.js"');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

for (const outcome of ["resolve", "reject"]) {
  test(`cancelled file read ${outcome} cannot publish into or terminate a subsequent worker`, async () => {
    const workers = [];
    const cancelButton = { hidden: true };
    const context = vm.createContext({
      URL,
      $: () => cancelButton,
      Worker: class {
        constructor() {
          this.messages = [];
          this.terminated = false;
          workers.push(this);
        }
        terminate() { this.terminated = true; }
        postMessage(message) { this.messages.push(message); }
      },
    });
    vm.runInContext(`let registrationWorker; let cancelRegistration; ${registrationSource}`, context);
    const read = deferred();
    const oldJob = context.runRegistration({ arrayBuffer: () => read.promise }, { arrayBuffer: async () => new ArrayBuffer(1) }, "affine", () => {});
    const cancelled = assert.rejects(oldJob, /Cancelled/);
    vm.runInContext("cancelRegistration()", context);
    await cancelled;
    assert.equal(cancelButton.hidden, true);
    const newRead = deferred();
    const currentJob = context.runRegistration({ arrayBuffer: () => newRead.promise }, { arrayBuffer: async () => new ArrayBuffer(1) }, "affine", () => {});
    if (outcome === "resolve") read.resolve(new ArrayBuffer(1));
    else read.reject(new Error("Old input failed"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(workers[0].terminated, true);
    assert.equal(workers[1].terminated, false);
    assert.equal(workers[1].messages.length, 0);
    workers[0].onmessage({ data: { error: "Stale worker result" } });
    assert.equal(workers[1].terminated, false);
    newRead.resolve(new ArrayBuffer(1));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(workers[1].messages.length, 1);
    workers[1].onmessage({ data: { result: "current" } });
    assert.deepEqual(await currentJob, { result: "current" });
    assert.equal(workers[1].terminated, true);
    assert.equal(cancelButton.hidden, true);
  });
}
