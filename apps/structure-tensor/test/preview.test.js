import { test } from "node:test";
import assert from "node:assert/strict";
import { showCommitted } from "../src/preview.js";

test("a cancel after the new view is shown restores the committed view and throws", async () => {
  const shown = [];
  const controller = new AbortController();
  const show = async (view) => {
    shown.push(view);
    // The user cancels once the viewer has drawn the new image, before the load commits it.
    if (view === "new") controller.abort(new DOMException("Cancelled", "AbortError"));
  };
  await assert.rejects(showCommitted(show, "new", "old", controller.signal), { name: "AbortError" });
  assert.deepEqual(shown, ["new", "old"]);
});

test("an uncancelled view stays shown", async () => {
  const shown = [];
  await showCommitted(async (view) => shown.push(view), "new", "old", new AbortController().signal);
  assert.deepEqual(shown, ["new"]);
});
