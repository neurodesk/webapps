import { test } from "node:test";
import assert from "node:assert/strict";
import { readTileFiles } from "../src/input.js";

test("the combined source budget is enforced before reading any tile", async () => {
  const file = { name: "a.tif", size: 6, arrayBuffer() { assert.fail("oversized selection read"); } };
  await assert.rejects(readTileFiles([file, { ...file, name: "b.tif" }], undefined, 10), /input limit/);
});

test("cancellation during a read prevents reading the next tile", async () => {
  const controller = new AbortController();
  const first = { name: "a.tif", size: 1, async arrayBuffer() { controller.abort(); return new ArrayBuffer(1); } };
  const next = { name: "b.tif", size: 1, arrayBuffer() { assert.fail("read after cancellation"); } };
  await assert.rejects(readTileFiles([first, next], controller.signal), { name: "AbortError" });
});

test("source bytes at the budget retain names and order", async () => {
  const files = [new File(["a"], "a.tif"), new File(["b"], "b.tif")];
  const result = await readTileFiles(files, undefined, 2);
  assert.deepEqual(result.map(({ name, buffer }) => [name, new TextDecoder().decode(buffer)]), [["a.tif", "a"], ["b.tif", "b"]]);
});
