import assert from "node:assert/strict";
import { test } from "node:test";
import { createSourceReader, cancellableStore } from "../src/source-reader.js";
import { createIoWorkerQueue } from "../src/io-worker.js";

function deferred() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
}

for (const kind of ["tiff", "zarr", "ozx"]) {
  for (const stage of ["store", "metadata", "pixels"]) {
    if (kind !== "tiff" && stage === "store") continue;
    test(`cancelled remote ${kind} ${stage} read cannot start display serialization or delay a retry`, async () => {
      const pending = deferred();
      const started = deferred();
      const store = { get: async () => undefined };
      const image = { name: "abandoned image" };
      const multiscales = { images: [{ data: { shape: [2, 2] }, dims: ["y", "x"] }] };
      let workers = 0;
      let writes = 0;
      const io = createIoWorkerQueue(async () => {
        workers++;
        return { terminate() {} };
      });
      const wait = async (at, value) => {
        if (at === stage) {
          started.resolve();
          await pending.promise;
        }
        return value;
      };
      const read = createSourceReader({
        TiffStore: { fromUrl: () => wait("store", store) },
        ZipFileStore: { fromUrl: (_url, options) => {
          assert.equal(options.overrides.signal, controller.signal);
          return store;
        } },
        FetchStore: class {
          constructor(_url, options) { assert.equal(options.overrides.signal, controller.signal); }
          get() { return store.get(); }
        },
        fromOmeZarr: () => wait("metadata", multiscales),
        ngffImageToItkImage: () => wait("pixels", image),
        prepared: (value, _name, _kind, _display, _detail, signal) => io.run(() => {
          writes++;
          return value;
        }, { signal }),
      });
      const controller = new AbortController();
      const abandoned = read(`https://images.example.org/image.${kind === "tiff" ? "ome.tif" : kind === "ozx" ? "ozx" : "ome.zarr/"}`, { signal: controller.signal });
      const rejected = assert.rejects(abandoned, { name: "AbortError" });
      await started.promise;
      controller.abort();
      io.reset();
      pending.resolve();
      await rejected;
      assert.equal(workers, 0);
      assert.equal(writes, 0);
      assert.equal(await io.run(() => "replacement image"), "replacement image");
      assert.equal(workers, 1);
      assert.equal(writes, 0);
      io.reset();
    });
  }
}

test("store calls receive the signal and discard results completed after cancellation", async () => {
  const controller = new AbortController();
  const pending = deferred();
  let calls = 0;
  const store = cancellableStore({
    async get(key, options) {
      calls++;
      assert.equal(key, "/zarr.json");
      assert.equal(options.signal, controller.signal);
      return pending.promise;
    },
  }, controller.signal);
  const read = store.get("/zarr.json");
  const rejected = assert.rejects(read, { name: "AbortError" });
  controller.abort();
  pending.resolve(new Uint8Array([1]));
  await rejected;
  await assert.rejects(store.get("/zarr.json"), { name: "AbortError" });
  assert.equal(calls, 1);
});
